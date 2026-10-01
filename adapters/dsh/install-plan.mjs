/**
 * DSH 安装器的**纯规划层**：路径解析、profile manifest、Hub 厂商登记，以及
 * `planInstall` / `planUninstall` 两个总装函数。
 *
 * 分层（见 `install.mjs` 头部总览）：`install-yaml.mjs` = 文本工具 + patch 托管块；
 * 本模块 = 其余纯规划；`install-apply.mjs` = 副作用层；`install.mjs` = CLI + 公开再导出。
 *
 * 本模块**不做任何 fs 访问**：当前文件内容由调用方读好后注入（`profilePackage` / `userPatch` /
 * `agentchatConfig`），函数只返回"将要写什么"。返回 `{ files, links, unlinks, notes, paths }`；
 * `files[].change` 直接给出幂等判断（第二次安装全为 `false`）。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  agentchatConfigPath,
  agentchatHome,
  applyVendor,
  serializeAgentchatConfig,
} from "../agentchat-config.mjs"
import { errorText, isRecord } from "./install-io.mjs"
import {
  buildManagedBlock,
  eolOf,
  planPatchInstall,
  planPatchUninstall,
  serializeJsonLike,
} from "./install-yaml.mjs"

/** bundle 包名：同时是 profile 依赖名、bundle 选择项。 */
const ADAPTER_ID = "@agentchat/dsh-adapter"
/** 本厂商 id：写入 `<home>/config.json` 的 `adapters`（与 `AGENTCHAT_ADAPTERS` 的取值一致）。 */
const VENDOR_ID = "dsh"
const DEFAULT_PROFILE = "desktop"
/** MCP 桥文件名：MCP 行指向 `<适配器目录>/mcp-bridge.mjs`。 */
export const BRIDGE_FILE = "mcp-bridge.mjs"
const DEFAULT_DSH_HOME = ".dsh"

// ── 类型 ────────────────────────────────────────────────────────────

/**
 * @typedef {object} PlannedFile
 * @property {string} path 目标文件绝对路径
 * @property {string|null} content 期望内容；`null` = 期望"不存在"（卸载时删除本安装器创建的文件）
 * @property {boolean} existed 规划时该文件是否已存在（决定是否需要写 `<path>.bak`）
 * @property {boolean} change 是否需要落盘（幂等判断；第二次安装/已卸载状态下全为 `false`）
 * @property {"json"|"yaml"|"agentchat"} kind 写入方式；`agentchat` 走共享 helper `writeAgentchatConfig`
 * @property {Record<string, unknown>} [value] `kind === "agentchat"` 时要写的配置对象
 */

/**
 * @typedef {object} PlannedLink
 * @property {string} path 联结路径
 * @property {string} target 目标绝对路径
 * @property {"junction"|"dir"} type `fs.symlinkSync` 的类型参数
 */

/**
 * @typedef {object} PlanPaths
 * @property {string} dshHome
 * @property {string} profile
 * @property {string} adapterDir
 * @property {string} bridgePath
 * @property {string} profileDir
 * @property {string} manifestPath
 * @property {string} patchPath
 * @property {string} linkPath
 * @property {string} agentchatHome
 * @property {string} agentchatConfigPath
 * @property {string} nodeExe
 */

/**
 * @typedef {object} Plan
 * @property {PlannedFile[]} files 需要管理的三份文件（每份都给出期望内容与 `change`）
 * @property {PlannedLink[]} links 需要建立的目录联接（安装）
 * @property {{path: string}[]} unlinks 需要移除的目录联接（卸载）
 * @property {string[]} notes 给人看的说明（路径、分工）
 * @property {PlanPaths} paths 解析后的全部落点（供 CLI 打印）
 */

/**
 * @typedef {object} PlanContext
 * @property {string} [dshHome] DSH home（缺省：`$DSH_HOME` 或 `~/.dsh`）
 * @property {string} [profile] profile 名（缺省：`$DSH_PROFILE` 或 `desktop`）
 * @property {string} [adapterDir] 适配器包目录绝对路径
 * @property {string} [agentchatHome] AgentChat 数据目录（缺省：`$AGENTCHAT_HOME` 或 `~/.agentchat`）
 * @property {string} [nodeExe] 写进 MCP 行的 node 绝对路径（缺省：`process.execPath`）
 * @property {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] 解析缺省值用的环境变量
 * @property {string} [platform] 覆盖 `process.platform`（只为测试：决定联结类型）
 * @property {string} [profilePackage] 注入的当前 `package.json` 文本（`undefined` = 不存在）
 * @property {string} [userPatch] 注入的当前 `cordis.patch.yml` 文本（`undefined` = 不存在）
 * @property {Record<string, unknown>} [agentchatConfig] 注入的当前 Hub 配置对象（`undefined` = 不存在）
 */

// ── 缺省值与路径 ────────────────────────────────────────────────────

/** 非空字符串才认（空串视同未设：`--profile ""` 与未给等价）。 */
export function nonEmpty(value) {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** DSH home：`ctx.dshHome` → `$DSH_HOME` → `~/.dsh`。 */
export function defaultDshHome(env) {
  return nonEmpty(env.DSH_HOME) ?? join(homedir(), DEFAULT_DSH_HOME)
}

/** profile 名：`$DSH_PROFILE` → `desktop`。 */
export function defaultProfile(env) {
  return nonEmpty(env.DSH_PROFILE) ?? DEFAULT_PROFILE
}

/** `<dshHome>/profiles/<profile>`。 */
export function profileDir(dshHome, profile) {
  return join(dshHome, "profiles", profile)
}

/** 共享扁平模块根里本适配器的联结路径。 */
export function adapterLinkPath(dshHome) {
  return join(dshHome, "profiles", "node_modules", "@agentchat", "dsh-adapter")
}

/** Windows 用 `junction`（无需提权）；其它平台用 `dir`。 */
export function linkType(platform) {
  return platform === "win32" ? "junction" : "dir"
}

/**
 * @param {PlanContext} [ctx]
 * @returns {PlanPaths}
 */
function resolvePaths(ctx = {}) {
  const env = ctx.env ?? {}
  const dshHome = resolve(nonEmpty(ctx.dshHome) ?? defaultDshHome(env))
  const profile = nonEmpty(ctx.profile) ?? defaultProfile(env)
  const adapterDir = resolve(nonEmpty(ctx.adapterDir) ?? ".")
  const hub = resolve(nonEmpty(ctx.agentchatHome) ?? agentchatHome(env))
  const dir = profileDir(dshHome, profile)
  return {
    dshHome,
    profile,
    adapterDir,
    bridgePath: join(adapterDir, BRIDGE_FILE),
    profileDir: dir,
    manifestPath: join(dir, "package.json"),
    patchPath: join(dir, "cordis.patch.yml"),
    linkPath: adapterLinkPath(dshHome),
    agentchatHome: hub,
    // 复用共享 helper 解析 `<home>/config.json`（AGENTCHAT_HOME 已由调用方解析成绝对路径）。
    agentchatConfigPath: agentchatConfigPath({ AGENTCHAT_HOME: hub }),
    nodeExe: nonEmpty(ctx.nodeExe) ?? process.execPath,
  }
}

/**
 * `file:` 依赖记录（pnpm 兼容）。路径**一律写成正斜杠**：Windows 的原生 `C:\...` 在 manifest 里
 * 需要转义、且 POSIX 侧 pnpm 读不懂；正斜杠两个平台都认，仍是合法 JSON 字符串值。
 */
function dependencyValue(adapterDir) {
  return `file:${adapterDir.replace(/\\/g, "/")}`
}

// ── 纯规划：profile manifest ────────────────────────────────────────

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function parseManifest(text, path) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`profile manifest 不是合法 JSON，拒绝改写：${path}（${errorText(error)}）`)
  }
  if (!isRecord(value)) throw new Error(`profile manifest 顶层不是对象，拒绝改写：${path}`)
  return value
}

/** 安装器在"manifest 不存在"时会创建的规范内容（卸载时据此判断是否可以整份删除）。 */
function createdManifest(profile, depValue) {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [ADAPTER_ID]: depValue },
    dsh: { profile: { bundles: [ADAPTER_ID] } },
  }
}

/**
 * 规划 profile manifest：`dependencies[ADAPTER_ID] = file:<适配器目录>` + `dsh.profile.bundles` 选择项。
 *
 * 逐字节还原的边界：
 * - 只增删**我们这两个位置**，不删除空容器键（`dependencies` / `bundles`）；JSON 按原文的
 *   缩进 / 换行 / 末尾是否带换行序列化。DSH 生成的 profile manifest 恒含 `"dependencies": {}` 与
 *   `"dsh": {"profile": {"bundles": [...]}}`，因此卸载后逐字节相同；只有手写、原本就缺这两个容器的
 *   manifest 会留下空容器（不做启发式猜测，以免误删用户结构）。
 *
 * @returns {PlannedFile}
 */
function planManifest(path, current, { profile, depValue, uninstall }) {
  if (current === undefined) {
    if (uninstall) return { path, content: null, existed: false, change: false, kind: "json" }
    return {
      path,
      content: serializeJsonLike(createdManifest(profile, depValue), undefined),
      existed: false,
      change: true,
      kind: "json",
    }
  }
  if (uninstall && current === serializeJsonLike(createdManifest(profile, depValue), undefined)) {
    // 安装时该文件并不存在（内容仍是我们创建的规范内容）→ 整份删除，才算还原
    return { path, content: null, existed: true, change: true, kind: "json" }
  }
  const manifest = parseManifest(current, path)
  let changed = false

  const dependenciesValue = manifest.dependencies
  if (dependenciesValue !== undefined && !isRecord(dependenciesValue)) {
    throw new Error(`profile manifest 的 dependencies 不是对象，拒绝改写：${path}`)
  }
  const dependencies = dependenciesValue ?? {}
  if (uninstall) {
    if (Object.prototype.hasOwnProperty.call(dependencies, ADAPTER_ID)) {
      delete dependencies[ADAPTER_ID]
      changed = true
    }
  } else if (dependencies[ADAPTER_ID] !== depValue) {
    dependencies[ADAPTER_ID] = depValue
    changed = true
  }
  if (dependenciesValue !== undefined || Object.keys(dependencies).length > 0) {
    manifest.dependencies = dependencies
  }

  const dshValue = manifest.dsh
  if (dshValue !== undefined && !isRecord(dshValue)) {
    throw new Error(`profile manifest 的 dsh 不是对象，拒绝改写：${path}`)
  }
  const profileValue = isRecord(dshValue) ? dshValue.profile : undefined
  if (profileValue !== undefined && !isRecord(profileValue)) {
    throw new Error(`profile manifest 的 dsh.profile 不是对象，拒绝改写：${path}`)
  }
  const bundlesValue = isRecord(profileValue) ? profileValue.bundles : undefined
  if (bundlesValue !== undefined && !isStringArray(bundlesValue)) {
    throw new Error(`profile manifest 的 dsh.profile.bundles 不是字符串数组，拒绝改写：${path}`)
  }
  const bundles = bundlesValue ?? []
  const at = bundles.indexOf(ADAPTER_ID)
  let bundlesChanged = false
  if (uninstall) {
    if (at !== -1) {
      bundles.splice(at, 1)
      bundlesChanged = true
    }
  } else if (at === -1) {
    bundles.push(ADAPTER_ID)
    bundlesChanged = true
  }
  if (bundlesChanged) {
    changed = true
    const dsh = isRecord(dshValue) ? dshValue : {}
    const profileValueOut = isRecord(profileValue) ? profileValue : {}
    profileValueOut.bundles = bundles
    dsh.profile = profileValueOut
    manifest.dsh = dsh
  }

  const content = serializeJsonLike(manifest, current)
  return { path, content, existed: true, change: changed, kind: "json" }
}

// ── 纯规划：Hub 厂商登记 ────────────────────────────────────────────

/** 规划 `<agentchat home>/config.json` 的 `adapters`（复用 `applyVendor`）。 */
function planHub(path, current, uninstall) {
  if (current === undefined) {
    // 卸载时文件本就不存在 → 不要创建它
    if (uninstall) return { path, content: null, existed: false, change: false, kind: "agentchat" }
  }
  const config = { ...(current ?? {}) }
  const changed = applyVendor(config, path, VENDOR_ID, uninstall)
  return {
    path,
    content: serializeAgentchatConfig(config),
    existed: current !== undefined,
    change: changed,
    kind: "agentchat",
    value: config,
  }
}

// ── 纯规划：安装 / 卸载 ─────────────────────────────────────────────

/**
 * 规划安装（**不做任何 fs 访问**；当前文件内容由 `ctx` 注入）。
 *
 * @param {PlanContext} [ctx]
 * @returns {Plan}
 */
export function planInstall(ctx = {}) {
  const paths = resolvePaths(ctx)
  const platform = nonEmpty(ctx.platform) ?? process.platform
  const depValue = dependencyValue(paths.adapterDir)
  const block = buildManagedBlock(paths.nodeExe, paths.bridgePath, eolOf(ctx.userPatch))
  return {
    files: [
      planManifest(paths.manifestPath, ctx.profilePackage, {
        profile: paths.profile,
        depValue,
        uninstall: false,
      }),
      planPatchInstall(paths.patchPath, ctx.userPatch, block),
      planHub(paths.agentchatConfigPath, ctx.agentchatConfig, false),
    ],
    links: [{ path: paths.linkPath, target: paths.adapterDir, type: linkType(platform) }],
    unlinks: [],
    notes: [
      `bundle 选择（dsh.profile.bundles）写入 ${paths.manifestPath}；未选中时 loader 不会合成该 bundle 的 patch`,
      `Hub MCP 行（含 node 与 mcp-bridge.mjs 绝对路径）写入 ${paths.patchPath} 的托管块`,
    ],
    paths,
  }
}

/**
 * 规划卸载（**不做任何 fs 访问**）：移除联接、依赖、bundle 选择项、托管块、厂商登记。
 * 在"本就干净"的 profile 上，所有 `change` 均为 `false`（幂等）。
 *
 * @param {PlanContext} [ctx]
 * @returns {Plan}
 */
export function planUninstall(ctx = {}) {
  const paths = resolvePaths(ctx)
  const depValue = dependencyValue(paths.adapterDir)
  return {
    files: [
      planManifest(paths.manifestPath, ctx.profilePackage, {
        profile: paths.profile,
        depValue,
        uninstall: true,
      }),
      planPatchUninstall(paths.patchPath, ctx.userPatch),
      planHub(paths.agentchatConfigPath, ctx.agentchatConfig, true),
    ],
    links: [],
    unlinks: [{ path: paths.linkPath }],
    notes: [
      `从 ${paths.manifestPath} 移除 file: 依赖与 dsh.profile.bundles 选择项`,
      `从 ${paths.patchPath} 摘除托管块；从 ${paths.agentchatConfigPath} 移除厂商 ${VENDOR_ID}`,
    ],
    paths,
  }
}
