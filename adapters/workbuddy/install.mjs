#!/usr/bin/env node
/**
 * AgentChat WorkBuddy 安装器（幂等）：把本插件装进 WorkBuddy 的**本地目录市场**并启用。
 *
 * 用法：
 *   node adapters/workbuddy/install.mjs [--dry-run] [--uninstall] [--force] [--help]
 *        [--workbuddy-home <path>] [--agentchat-home <path>] [--plugin-dir <path>]
 *
 * 写什么（报告 §4 方案 A）：
 *   ① 市场目录 `<wbHome>/plugins/marketplaces/agentchat-local/`（含 `.codebuddy-plugin/marketplace.json`
 *      与插件源 `agentchat-workbuddy/`）；
 *   ② 安装落地 `<wbHome>/plugins/cache/agentchat-local/agentchat-workbuddy/<version>/`；
 *   ③ `known_marketplaces.json` 注册目录型市场；
 *   ④ `installed_plugins.json`（v2 台账）登记 `agentchat-workbuddy@agentchat-local`；
 *   ⑤ `settings.json` 的 `enabledPlugins` 置 `true`；
 *   ⑥ Hub `<home>/config.json` 的 `adapters` 追加 `workbuddy`（免手动设 env）。
 *
 * ⚠️ ③/④ 属 WorkBuddy **内部 schema**，版本升级可能漂移（报告 §4 风险 ③）。故一律
 * 「备份 `.agentchat.bak` + 原子替换」，且 `--uninstall` 在内容未被第三方改动时**字节级还原**。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  agentchatConfigPath,
  applyVendor,
  readAgentchatConfig,
  serializeAgentchatConfig,
  writeAgentchatConfig,
} from "../agentchat-config.mjs"
import {
  atomicWrite,
  backupPath,
  clearCreated,
  commitJson,
  copyTree,
  dropBackup,
  exists,
  markCreated,
  readJsonWithBytes,
  readRaw,
  removeFileIfExists,
  removeTree,
  serialize,
  wasCreatedByUs,
} from "./install-io.mjs"
import {
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  VENDOR_ID,
  installedEntry,
  installerPaths,
  marketplaceEntry,
  marketplaceManifest,
  mergeEnabled,
  mergeInstalled,
  mergeKnown,
  resolveWorkbuddyHome,
} from "./install-plan.mjs"
import { isRecord } from "./lib/util.mjs"

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))

const HELP = [
  "AgentChat WorkBuddy 安装器",
  "用法：node adapters/workbuddy/install.mjs [--dry-run] [--uninstall] [--force] [--help]",
  "  --workbuddy-home <path>  WorkBuddy 配置目录（默认 $AGENTCHAT_WORKBUDDY_HOME 或 ~/.workbuddy）",
  "  --agentchat-home <path>  Hub 数据目录（默认 $AGENTCHAT_HOME 或 ~/.agentchat）",
  "  --plugin-dir <path>      插件源目录（默认本适配器目录）",
  "  --dry-run 只打印计划、不落盘；--uninstall 精确回退；--force 覆盖已存在的市场/安装目录",
  "",
  "装完后需**重启 WorkBuddy**（或用插件管理页确认 agentchat-local 市场 / agentchat-workbuddy 已启用）。",
  "本机已验证项与未验证项见 adapters/workbuddy/README.md 的「真机清单」。",
].join("\n")

function parseArgs(argv) {
  const args = { dryRun: false, uninstall: false, force: false, help: false, error: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--force") args.force = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--workbuddy-home" || arg === "--agentchat-home" || arg === "--plugin-dir") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        args.error = `${arg} 需要一个路径参数`
        return args
      }
      if (arg === "--workbuddy-home") args.wbHome = value
      else if (arg === "--agentchat-home") args.agentchatHome = value
      else args.pluginDir = value
      i += 1
    } else {
      args.error = `未知参数：${arg}（支持 --dry-run、--uninstall、--force、--help、--workbuddy-home、--agentchat-home、--plugin-dir）`
      return args
    }
  }
  return args
}

/**
 * 读一个可能不存在的 JSON 文件，得到三份信息：
 * - `current`      — 现状（不存在 → `undefined`）
 * - `next`         — 目标内容（安装：合并；卸载：精确移除本适配器的键）
 * - `installShape` — 由 `<path>.agentchat.bak`（**安装前**的原始内容）推出的"安装后应有形态"，
 *                    用于判断"自安装起有没有被第三方改动过"，从而决定能否**字节级还原**
 */
function loadPlan(path, label, merge, uninstall) {
  const found = readJsonWithBytes(path, label)
  const current = found === undefined ? undefined : found.value
  const rawBak = readRaw(backupPath(path))
  let bakValue
  if (rawBak !== undefined) {
    try {
      const parsed = JSON.parse(rawBak)
      bakValue = isRecord(parsed) ? parsed : undefined
    } catch {
      bakValue = undefined
    }
  }
  return {
    current,
    next: merge(current, uninstall).value,
    /** 空输入下的基线（用于判断"本安装器创建的文件卸载后是否已回到空壳"）。 */
    baseline: merge(undefined, uninstall).value,
    installShape: bakValue === undefined ? undefined : merge(bakValue, false).value,
  }
}

/** 内容是否相同（键序无关）。 */
function sameJson(a, b) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

/** 安装/卸载时"是否需要落盘"。 */
export function needsWrite(plan) {
  if (plan.current === undefined) return plan.next !== undefined
  return !sameJson(plan.current, plan.next)
}

/** 落盘（自动打「本安装器创建」标记，使卸载能精确删掉而非留下空壳）。 */
function commitMerged(path, value) {
  if (!exists(path)) markCreated(path)
  commitJson(path, value)
}

/**
 * 卸载单个 JSON：
 * 1. 内容仍等于"安装后应有形态"→ **字节级还原**（写回 `.agentchat.bak` 原始字节）；
 * 2. 文件是本安装器创建的、且移除后已回到空基线 → **删掉整文件**（不留空壳）；
 * 3. 其余情况 → 精确移除本适配器的键并**告警**（绝不静默损毁用户改动）。
 */
function revert(path, label, plan) {
  if (plan.current === undefined) return { outcome: "missing", changed: false }
  const rawBak = readRaw(backupPath(path))
  if (rawBak !== undefined && plan.installShape !== undefined && sameJson(plan.current, plan.installShape)) {
    atomicWrite(path, rawBak)
    dropBackup(path)
    clearCreated(path)
    return { outcome: "restored", changed: true }
  }
  if (wasCreatedByUs(path) && sameJson(plan.next, plan.baseline)) {
    removeFileIfExists(path)
    clearCreated(path)
    return { outcome: "removed", changed: true }
  }
  if (sameJson(plan.current, plan.next)) return { outcome: "unchanged", changed: false }
  atomicWrite(path, serialize(plan.next))
  clearCreated(path)
  return { outcome: "patched", changed: true }
}

/** 稳定键序（仅用于比较；不改文件内容）。 */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (isRecord(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key])
    return out
  }
  return value
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (args.error !== undefined) {
    process.stderr.write(`[agentchat] 错误：${args.error}\n`)
    return 1
  }
  try {
    const env = { ...process.env }
    if (args.agentchatHome !== undefined) env.AGENTCHAT_HOME = args.agentchatHome
    const wbHome = args.wbHome ?? resolveWorkbuddyHome(env)
    const paths = installerPaths(wbHome)
    const sourceDir = args.pluginDir ?? ADAPTER_DIR
    const nowIso = new Date().toISOString()

    const knownPlan = loadPlan(paths.knownMarketplaces, "known_marketplaces.json", (value, uninstall) =>
      mergeKnown(value, marketplaceEntry(paths, nowIso), uninstall), args.uninstall)
    const installedPlan = loadPlan(paths.installedPlugins, "installed_plugins.json", (value, uninstall) =>
      mergeInstalled(value, installedEntry(paths, nowIso), uninstall), args.uninstall)
    const settingsPlan = loadPlan(paths.settings, "settings.json", (value, uninstall) => mergeEnabled(value, uninstall), args.uninstall)

    const agentchatPath = agentchatConfigPath(env)
    const agentchatConfig = readAgentchatConfig(agentchatPath)
    const adaptersChanged = applyVendor(agentchatConfig, agentchatPath, VENDOR_ID, args.uninstall)

    if (args.dryRun) {
      process.stdout.write(`# 插件源 → ${paths.pluginSourceDir}\n`)
      process.stdout.write(`# 安装落地 → ${paths.installDir}\n`)
      process.stdout.write(`# 市场清单 → ${paths.marketplaceManifest}\n${serialize(marketplaceManifest())}`)
      process.stdout.write(`# known_marketplaces.json → ${paths.knownMarketplaces}\n${serialize(knownPlan.next)}`)
      process.stdout.write(`# installed_plugins.json → ${paths.installedPlugins}\n${serialize(installedPlan.next)}`)
      process.stdout.write(`# settings.json → ${paths.settings}\n${serialize(settingsPlan.next)}`)
      process.stdout.write(`# Hub 适配器 → ${agentchatPath}\n${serializeAgentchatConfig(agentchatConfig)}`)
      process.stderr.write(`[agentchat] --dry-run：未写入（${MARKETPLACE_NAME} / ${PLUGIN_NAME}）\n`)
      return 0
    }

    if (args.uninstall) {
      const results = [
        ["known_marketplaces.json", revert(paths.knownMarketplaces, "known_marketplaces.json", knownPlan)],
        ["installed_plugins.json", revert(paths.installedPlugins, "installed_plugins.json", installedPlan)],
        ["settings.json", revert(paths.settings, "settings.json", settingsPlan)],
      ]
      removeTree(paths.marketplaceDir)
      removeTree(paths.installDir)
      let backedUp = false
      if (adaptersChanged) backedUp = writeAgentchatConfig(agentchatPath, agentchatConfig).backedUp
      for (const [label, outcome] of results) {
        process.stdout.write(`[agentchat] ${label}: ${outcome.outcome}\n`)
        if (outcome.outcome === "patched") {
          process.stderr.write(`[agentchat] ⚠️ ${label} 自安装后被改动过，无法字节级还原；已精确移除本适配器的键\n`)
        }
      }
      process.stdout.write(`[agentchat] 已移除市场目录与安装目录（${paths.marketplaceDir} / ${paths.installDir}）\n`)
      if (adaptersChanged) {
        const hint = backedUp ? `（备份：${agentchatPath}.bak）` : ""
        process.stdout.write(`[agentchat] Hub 适配器登记（${VENDOR_ID}）已移除 → ${agentchatPath}${hint}\n`)
      }
      return 0
    }

    const reason = assertInstallable(sourceDir, paths, args.force)
    if (reason !== undefined) {
      process.stderr.write(`[agentchat] 错误：${reason}\n`)
      return 1
    }
    copyTree(sourceDir, paths.pluginSourceDir, { force: args.force })
    copyTree(sourceDir, paths.installDir, { force: args.force })
    commitMerged(paths.marketplaceManifest, marketplaceManifest())
    if (needsWrite(knownPlan)) commitMerged(paths.knownMarketplaces, knownPlan.next)
    if (needsWrite(installedPlan)) commitMerged(paths.installedPlugins, installedPlan.next)
    if (needsWrite(settingsPlan)) commitMerged(paths.settings, settingsPlan.next)
    const backedUp = adaptersChanged ? writeAgentchatConfig(agentchatPath, agentchatConfig).backedUp : false
    const touched = [
      needsWrite(knownPlan) ? "known_marketplaces.json" : undefined,
      needsWrite(installedPlan) ? "installed_plugins.json" : undefined,
      needsWrite(settingsPlan) ? "settings.json" : undefined,
    ].filter((value) => value !== undefined)
    process.stdout.write(`[agentchat] 安装完成：${PLUGIN_NAME}@${MARKETPLACE_NAME}（${touched.length === 0 ? "台账已最新" : `写入 ${touched.join(" / ")}`}）\n`)
    process.stdout.write(`[agentchat] 插件源   → ${paths.pluginSourceDir}\n`)
    process.stdout.write(`[agentchat] 安装落地 → ${paths.installDir}\n`)
    process.stdout.write(`[agentchat] 市场/台账/启用 → ${paths.knownMarketplaces} / ${paths.installedPlugins} / ${paths.settings}\n`)
    if (adaptersChanged) {
      process.stdout.write(`[agentchat] Hub 适配器登记（${VENDOR_ID}）→ ${agentchatPath}${backedUp ? "（已备份）" : ""}\n`)
    }
    process.stdout.write("[agentchat] 下一步：重启 WorkBuddy，然后看 Hub /api/roster 是否出现 workbuddy@<host>\n")
    return 0
  } catch (error) {
    process.stderr.write(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** 目标已存在且非本安装器产物时的拒绝逻辑（返回错误文案或 `undefined`）。 */
function assertInstallable(sourceDir, paths, force) {
  if (!exists(sourceDir)) return `插件源目录不存在：${sourceDir}`
  if (force) return undefined
  if (exists(paths.marketplaceDir) || exists(paths.installDir)) {
    return `目标已存在（${paths.marketplaceDir} 或 ${paths.installDir}）；重装请加 --force`
  }
  return undefined
}

process.exitCode = main()
