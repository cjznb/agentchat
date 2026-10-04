/**
 * 安装/卸载的**纯规划层**：目标路径推导 + 各 JSON 文件的合并/移除变换。
 *
 * 与 IO 分离（`install-io.mjs`）使本模块可被单测直接断言"给定既有内容 → 期望内容"，
 * 无需触碰真实文件系统。
 *
 * 落点（报告 §4 方案 A：**本地目录市场 + enabledPlugins**）：
 * ```
 * <wbHome>/plugins/marketplaces/agentchat-local/.codebuddy-plugin/marketplace.json   ← 市场清单
 * <wbHome>/plugins/marketplaces/agentchat-local/agentchat-workbuddy/                 ← 插件源
 * <wbHome>/plugins/cache/agentchat-local/agentchat-workbuddy/0.1.0/                  ← 安装落地
 * <wbHome>/plugins/known_marketplaces.json    ← 注册目录型市场（内部 schema）
 * <wbHome>/plugins/installed_plugins.json     ← 安装台账 v2（内部 schema）
 * <wbHome>/settings.json → enabledPlugins     ← 启用开关
 * <home>/config.json → adapters               ← Hub 侧厂商登记
 * ```
 *
 * ⚠️ 后两者属 WorkBuddy **内部 schema**，版本升级可能漂移（报告 §4 风险 ③）——因此安装器
 * 一律「备份 + 原子替换」，并在卸载时**尽力字节级还原**。
 */
import { homedir } from "node:os"
import { isRecord } from "./lib/util.mjs"
import { join, resolve } from "node:path"

export const PLUGIN_NAME = "agentchat-workbuddy"
export const MARKETPLACE_NAME = "agentchat-local"
export const VENDOR_ID = "workbuddy"
export const PLUGIN_VERSION = "0.1.0"

/** WorkBuddy 配置目录：`AGENTCHAT_WORKBUDDY_HOME`（非空）否则 `~/.workbuddy`。 */
export function resolveWorkbuddyHome(env) {
  const home = env["AGENTCHAT_WORKBUDDY_HOME"]
  return home !== undefined && home !== "" ? home : join(homedir(), ".workbuddy")
}

/** 本安装器产物的全部路径（单一来源）。 */
export function installerPaths(wbHome) {
  const pluginsRoot = join(wbHome, "plugins")
  const marketplaceDir = join(pluginsRoot, "marketplaces", MARKETPLACE_NAME)
  return {
    wbHome,
    pluginsRoot,
    marketplaceDir,
    marketplaceManifest: join(marketplaceDir, ".codebuddy-plugin", "marketplace.json"),
    /** 市场内插件源目录（`marketplace.json` 的 `source` 指向它）。 */
    pluginSourceDir: join(marketplaceDir, PLUGIN_NAME),
    /** 宿主安装落地目录（`installed_plugins.json` 的 `installPath` 指向它）。 */
    installDir: join(pluginsRoot, "cache", MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION),
    knownMarketplaces: join(pluginsRoot, "known_marketplaces.json"),
    installedPlugins: join(pluginsRoot, "installed_plugins.json"),
    settings: join(wbHome, "settings.json"),
  }
}

/** 市场清单（`source` 用**相对路径**，保证同一份包可被任意路径安装）。 */
export function marketplaceManifest() {
  return {
    name: MARKETPLACE_NAME,
    description: "AgentChat 本地适配器插件（由 adapters/workbuddy/install.mjs 写入）",
    owner: { name: "AgentChat" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./${PLUGIN_NAME}`,
        version: PLUGIN_VERSION,
        description: "把 WorkBuddy 的每个会话接入 AgentChat Hub：可被寻址、可被唤醒、可回信",
      },
    ],
  }
}

/** `known_marketplaces.json` 的 `agentchat-local` 条目（**含机器绝对路径**，故由安装器写入）。 */
export function marketplaceEntry(paths, nowIso) {
  const dir = resolve(paths.marketplaceDir)
  return {
    manifestName: MARKETPLACE_NAME,
    type: "directory",
    source: { source: "directory", path: dir },
    installLocation: dir,
    description: `Marketplace from ${dir}`,
    lastUpdated: nowIso,
    autoUpdate: false,
  }
}

/** `installed_plugins.json` 的 `agentchat-workbuddy@agentchat-local` 条目。 */
export function installedEntry(paths, nowIso) {
  return {
    scope: "user",
    installPath: resolve(paths.installDir),
    version: PLUGIN_VERSION,
    installedAt: nowIso,
    lastUpdated: nowIso,
  }
}

/** 安装台账的**键**（`<plugin>@<marketplace>`），也是 `enabledPlugins` 的键。 */
export function pluginKey() {
  return `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
}

function jsonEqual(a, b) {
  return canonical(a) === canonical(b)
}

/** 递归按键排序后的稳定序列化（用于"语义相同"判定，忽略键序）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * 保持时间戳**稳定**（幂等的关键）：若既有条目除时间戳外与本次期望完全一致，则沿用旧时间戳
 * —— 否则每次安装都会因 `lastUpdated` 变化而"看起来改了"，破坏"二次安装字节等价"。
 */
function withStableTimestamps(previous, entry, fields) {
  if (!isRecord(previous)) return entry
  const strip = (value) => {
    const out = { ...value }
    for (const field of fields) delete out[field]
    return out
  }
  if (!jsonEqual(strip(previous), strip(entry))) return entry
  const out = { ...entry }
  for (const field of fields) {
    const value = previous[field]
    if (typeof value === "string") out[field] = value
  }
  return out
}

/**
 * `known_marketplaces.json` 合并/移除。
 * 已存在**同一市场名** → 内容等价则 `changed:false`；不等价则覆盖（本安装器拥有该键）。
 */
export function mergeKnown(existing, entry, uninstall) {
  const base = isRecord(existing) ? existing : {}
  const next = { ...base }
  if (uninstall) {
    if (!Object.prototype.hasOwnProperty.call(next, MARKETPLACE_NAME)) return { value: next, changed: false }
    delete next[MARKETPLACE_NAME]
  } else {
    next[MARKETPLACE_NAME] = withStableTimestamps(base[MARKETPLACE_NAME], entry, ["lastUpdated"])
  }
  return { value: next, changed: !jsonEqual(next, base) }
}

/** `installed_plugins.json`（v2：`{version, plugins:{<key>:[entries]}}`）合并/移除。 */
export function mergeInstalled(existing, entry, uninstall) {
  const base = isRecord(existing) ? existing : { version: 2, plugins: {} }
  const plugins = isRecord(base.plugins) ? { ...base.plugins } : {}
  const key = pluginKey()
  if (uninstall) {
    if (!Object.prototype.hasOwnProperty.call(plugins, key)) {
      return { value: { ...base, plugins }, changed: false }
    }
    delete plugins[key]
  } else {
    const previous = plugins[key]
    const stable = Array.isArray(previous) && previous.length === 1
      ? [withStableTimestamps(previous[0], entry, ["installedAt", "lastUpdated"])]
      : [entry]
    plugins[key] = stable
  }
  const next = { ...base, version: base.version ?? 2, plugins }
  return { value: next, changed: !jsonEqual(next, base) }
}

/** `settings.json` 的 `enabledPlugins` 合并/移除（保留其它全部键）。 */
export function mergeEnabled(existing, uninstall) {
  const base = isRecord(existing) ? existing : {}
  const enabled = isRecord(base.enabledPlugins) ? { ...base.enabledPlugins } : {}
  const key = pluginKey()
  if (uninstall) {
    if (!Object.prototype.hasOwnProperty.call(enabled, key)) return { value: base, changed: false }
    delete enabled[key]
  } else {
    enabled[key] = true
  }
  const next = { ...base }
  if (Object.keys(enabled).length === 0) delete next.enabledPlugins
  else next.enabledPlugins = enabled
  return { value: next, changed: !jsonEqual(next, base) }
}

export { jsonEqual }
