/**
 * AgentChat × DSH 桌面端安装器：把本仓库的 DSH bundle（`adapters/dsh`）装进某个 DSH profile，
 * 并把 Hub 的 MCP 工具行写进该 profile 的**用户 patch 层**。
 *
 * 用法：
 *   node adapters/dsh/install.mjs [--profile <name>] [--dsh-home <path>] [--agentchat-home <path>]
 *        [--dry-run] [--uninstall] [--help]
 *
 * 安装四步（`--uninstall` 逐一反向）：
 *   1. **目录联接**：`<dshHome>/profiles/node_modules/@agentchat/dsh-adapter` → 适配器目录。
 *      DSH 启动器在 `<dshHome>/profiles/node_modules` 维护共享扁平模块根，profile manifest 里的
 *      `file:` 依赖就靠它解析。Windows 用 `symlinkSync(target, path, "junction")`（无需提权），
 *      其它平台用 `"dir"`。
 *   2. **profile manifest** `<dshHome>/profiles/<profile>/package.json`：
 *      `dependencies["@agentchat/dsh-adapter"] = "file:<适配器绝对目录>"`（pnpm 可解析的记录；
 *      路径写正斜杠，见 `install-plan.mjs` 的 `dependencyValue`），并把 `"@agentchat/dsh-adapter"`
 *      追加进 `dsh.profile.bundles`（bundle **选择**；loader 只对被选中的 bundle 合成其 patch，
 *      所以只建联结不登记是不够的）。
 *   3. **profile 用户 patch** `<dshHome>/profiles/<profile>/cordis.patch.yml`：追加**机器相关**的
 *      MCP 行（Hub 工具入口）。bundle 自带的 `cordis.patch.yml` 刻意不含任何绝对路径，两处分工见
 *      `adapters/dsh/cordis.patch.yml` 顶部注释。整块由 `MANAGED_HEAD` / `MANAGED_TAIL` 两个 marker
 *      界定：重复安装只替换块内文本（**不会重复追加**），`--uninstall` 只摘掉这一块。
 *   4. **Hub 厂商登记** `<agentchat home>/config.json` 的 `adapters` 追加 `dsh`
 *      （复用 `adapters/agentchat-config.mjs`，免用户手动设 `AGENTCHAT_ADAPTERS`）。
 *
 * 文件分层（本仓硬约束「单文件 ≤ 250 纯行」，见 `CONTRIBUTING.md`）：
 *   - **本文件**：CLI（`parseArgs` / `renderPlan` / `main`）+ **公开面再导出**，自身不实现规划与落盘；
 *     它同时是模块入口——被 import 时不得有任何副作用（见文件末尾的 `process.argv[1]` 守卫）。
 *   - `install-plan.mjs`：纯规划——路径、profile manifest、Hub 厂商登记、`planInstall` / `planUninstall`。
 *   - `install-yaml.mjs`：文本工具（EOL/缩进/格式保持）+ profile 用户 patch（托管块）规划。
 *   - `install-apply.mjs`：**唯一做副作用的地方**（mkdir / 备份 / 原子写 / symlink）+ `--dry-run` 判定。
 *   - `install-io.mjs`：极小 IO / 通用工具（`isRecord` / `errorText` / `readIfExists`）。
 *
 * 设计：**纯规划 / 副作用分离**（这样单测可以在临时目录里直接调函数，既不碰真实 `~/.dsh`，也不必 spawn）
 *   - `parseArgs(argv)`：纯参数解析。
 *   - `planInstall(ctx)` / `planUninstall(ctx)`：**不做任何 fs 访问**。当前文件内容由调用方读好后注入
 *     （`profilePackage` / `userPatch` / `agentchatConfig`），函数只返回"将要写什么"。返回
 *     `{ files, links, unlinks, notes, paths }`；`files[].change` 直接给出幂等判断（第二次安装全为 `false`）。
 *   - `applyPlan(plan, { dryRun })`：**唯一做副作用的地方**——mkdir、`<file>.bak` 备份、
 *     临时文件 + rename 原子替换、symlink。返回它实际做了什么；`dryRun` 时只计算、不落盘。
 *
 * 安全：改动前备份 `<file>.bak`（仅当原文件存在）；写盘一律临时文件 + rename；patch 顶层不是 YAML 数组
 * 时**拒绝**改写（宁可报错也不破坏用户 patch 层）。卸载只精确摘除本适配器的四处产物，保留用户其它键。
 * 关于"逐字节还原"的精确边界见 `install-plan.mjs` 的 `planManifest` 与 `install-yaml.mjs` 的 `planPatchInstall`。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  agentchatConfigPath,
  agentchatHome,
  readAgentchatConfig,
} from "../agentchat-config.mjs"
import { applyPlan, normalizePathForCompare, planHasChanges } from "./install-apply.mjs"
import { errorText, readIfExists } from "./install-io.mjs"
import {
  BRIDGE_FILE,
  defaultDshHome,
  defaultProfile,
  nonEmpty,
  planInstall,
  planUninstall,
  profileDir,
} from "./install-plan.mjs"

// ── 公开面（保持与拆分前**逐一相同**的名字与语义：单测与外部按名复用）──────
export { MANAGED_HEAD, MANAGED_TAIL } from "./install-yaml.mjs"
export { adapterLinkPath, linkType } from "./install-plan.mjs"
export { applyPlan, planHasChanges, planInstall, planUninstall, profileDir }

// ── CLI ─────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ profile?: string, dshHome?: string, agentchatHome?: string, dryRun: boolean,
 *   uninstall: boolean, help: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const args = {
    profile: undefined,
    dshHome: undefined,
    agentchatHome: undefined,
    dryRun: false,
    uninstall: false,
    help: false,
    error: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--profile" || arg === "--dsh-home" || arg === "--agentchat-home") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        args.error = `${arg} 需要一个值`
        return args
      }
      if (arg === "--profile") args.profile = value
      else if (arg === "--dsh-home") args.dshHome = value
      else args.agentchatHome = value
      i += 1
    } else {
      args.error = `未知参数：${arg}（支持 --profile <name>、--dsh-home <path>、--agentchat-home <path>、--dry-run、--uninstall、--help）`
      return args
    }
  }
  return args
}

const HELP =
  [
    "AgentChat × DSH 桌面端安装器",
    "用法：node adapters/dsh/install.mjs [--profile <name>] [--dsh-home <path>] [--agentchat-home <path>] [--dry-run] [--uninstall] [--help]",
    "  --profile <name>        DSH profile 名（默认：$DSH_PROFILE 或 desktop）",
    "  --dsh-home <path>       DSH home（默认：$DSH_HOME 或 ~/.dsh）",
    "  --agentchat-home <path> AgentChat 数据目录（默认：$AGENTCHAT_HOME 或 ~/.agentchat）",
    "  --dry-run               只打印将要写入的路径与内容，不落盘",
    "  --uninstall             反向执行四步（移除联接、file: 依赖与 bundle 选择、托管块、厂商登记），幂等",
    "  --help                  显示本帮助",
    "安装内容：",
    "  1. <dsh-home>/profiles/node_modules/@agentchat/dsh-adapter → 适配器目录（目录联接/符号链接）",
    "  2. <dsh-home>/profiles/<profile>/package.json：file: 依赖 + dsh.profile.bundles 选择项",
    "  3. <dsh-home>/profiles/<profile>/cordis.patch.yml：托管块（Hub MCP 行，含 node 与桥的绝对路径）",
    "  4. <agentchat-home>/config.json：adapters 追加 dsh",
  ].join("\n") + "\n"

/**
 * dry-run 打印：路径 + 将要写入的完整内容（`--dry-run` 的输出就是它）。
 *
 * @param {import("./install-plan.mjs").Plan} plan
 * @param {boolean} uninstall
 * @returns {string}
 */
export function renderPlan(plan, uninstall) {
  const out = []
  for (const file of plan.files) {
    const verb = file.content === null ? "删除" : uninstall ? "卸载后" : "安装后"
    out.push(`# ${verb} ${file.path}${file.change ? "" : "（无改动）"}`)
    if (file.change && file.content !== null) out.push(file.content.replace(/\n+$/, ""))
  }
  for (const link of plan.links) {
    out.push(`# 目录联接 ${link.path} → ${link.target}（type=${link.type}）`)
  }
  for (const item of plan.unlinks) out.push(`# 移除目录联接 ${item.path}`)
  return `${out.join("\n")}\n`
}

/**
 * `--dry-run` 的收尾摘要：这份计划**究竟会不会动盘**。
 *
 * 不能用"计划里有没有条目"判断：安装计划恒带一条联结、卸载计划恒带一条 unlink，那只表示"要保证的
 * 结果"；联结已指向同一目标 / 联结本就不存在时，这份计划其实是 no-op（历史缺陷：no-op 也报"将有改动"）。
 * 这里交给 `planHasChanges` 按副作用层的判定口径复算（只读，不落盘）。
 *
 * @param {import("./install-plan.mjs").Plan} plan
 * @returns {string}
 */
export function dryRunSummary(plan) {
  return `[agentchat] --dry-run：未写入（${planHasChanges(plan) ? "将有改动" : "无改动"}）`
}

function printActions(actions) {
  for (const action of actions) {
    if (action.kind === "link") {
      if (action.changed) console.log(`[agentchat] 目录联接：${action.path} → ${action.target}（${action.type}）`)
      else console.log(`[agentchat] 目录联接已就绪：${action.path} → ${action.target}`)
    } else if (action.kind === "unlink") {
      if (action.changed) console.log(`[agentchat] 已移除目录联接：${action.path}`)
      else if (action.note !== undefined) console.error(`[agentchat] ${action.note}：${action.path}`)
    } else if (action.kind === "delete") {
      console.log(`[agentchat] 已删除本安装器创建的文件：${action.path}`)
    } else if (action.changed) {
      const hint = action.backup === true ? `（备份：${action.path}.bak）` : ""
      console.log(`[agentchat] 已写入：${action.path}${hint}`)
    }
  }
}

function printNextSteps(paths) {
  console.log("[agentchat] 后续步骤：")
  console.log("  1. 重启 DSH 桌面端（bundle 与 MCP 行都在启动时装配）。")
  console.log("  2. 打开 AgentChat，用 GET /api/roster 确认本节点已出现。")
  console.log("  3.（官方支持的替代做法）也可以让你的 DSH agent 调用 plugin_manager：")
  console.log(`     action: install_bundle，target: ${paths.adapterDir}`)
  console.log(
    `     注意：它只装 bundle；MCP 行里的绝对路径（${paths.nodeExe} / ${paths.bridgePath}）仍需本安装器写进 ${paths.patchPath}。`,
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.error !== undefined) {
    console.error(`[agentchat] 错误：${args.error}`)
    process.stderr.write(HELP)
    return 1
  }
  try {
    const env = process.env
    // 适配器目录恒等于**本 CLI 文件所在目录**（install.mjs 是入口，规划/落盘都在同目录的兄弟模块里）。
    const adapterDir = dirname(fileURLToPath(import.meta.url))
    const dshHome = nonEmpty(args.dshHome) ?? defaultDshHome(env)
    const profile = nonEmpty(args.profile) ?? defaultProfile(env)
    const hubHome = nonEmpty(args.agentchatHome) ?? agentchatHome(env)
    const dir = profileDir(resolve(dshHome), profile)
    if (!args.uninstall && !existsSync(dir)) {
      throw new Error(
        `DSH profile 目录不存在：${dir}（请先在 DSH 桌面端创建该 profile，或用 --profile/--dsh-home 指定）`,
      )
    }
    const manifestPath = join(dir, "package.json")
    const patchPath = join(dir, "cordis.patch.yml")
    const hubConfigPath = agentchatConfigPath({ AGENTCHAT_HOME: resolve(hubHome) })
    if (!args.uninstall && !existsSync(join(adapterDir, BRIDGE_FILE))) {
      console.error(`[agentchat] 警告：未找到 ${join(adapterDir, BRIDGE_FILE)}，MCP 行要等它存在后才可用`)
    }
    const context = {
      dshHome: resolve(dshHome),
      profile,
      adapterDir,
      agentchatHome: resolve(hubHome),
      nodeExe: process.execPath,
      env,
      profilePackage: readIfExists(manifestPath),
      userPatch: readIfExists(patchPath),
      agentchatConfig:
        args.uninstall && !existsSync(hubConfigPath) ? undefined : readAgentchatConfig(hubConfigPath),
    }
    const action = args.uninstall ? "卸载" : "安装"
    const plan = args.uninstall ? planUninstall(context) : planInstall(context)

    if (args.dryRun) {
      process.stdout.write(renderPlan(plan, args.uninstall))
      console.error(dryRunSummary(plan))
      return 0
    }

    const result = applyPlan(plan, { dryRun: false })
    const changed = result.actions.filter((item) => item.changed).length
    if (changed === 0) {
      console.log(`[agentchat] ${action}无改动（已是最新）：${plan.paths.profileDir}`)
      return 0
    }
    console.log(`[agentchat] ${action}完成（profile：${plan.paths.profile}）`)
    printActions(result.actions)
    if (!args.uninstall) printNextSteps(plan.paths)
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${errorText(error)}`)
    return 1
  }
}

// 只有被 `node adapters/dsh/install.mjs` 直接执行时才跑 CLI；作为模块 import（单测）不得有副作用。
const invokedDirectly =
  process.argv[1] !== undefined &&
  normalizePathForCompare(process.argv[1]) === normalizePathForCompare(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = main()
