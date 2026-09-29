/**
 * AgentChat Claude Code 安装器：把 **hooks 事件条目** 并入用户 `settings.json`，
 * 把 **MCP server 条目** 并入 MCP 配置（默认用户级 `~/.claude.json`；设 `CLAUDE_CONFIG_DIR` 时为
 * `$CLAUDE_CONFIG_DIR/.claude.json`）。
 *
 * 用法：
 *   node adapters/claude-code/install.mjs [--config <path>] [--mcp-config <path>]
 *        [--dry-run] [--uninstall] [--help]
 *
 * 落点（官方事实：Claude Code settings schema **无根级 `mcpServers`**，写在 settings.json 会被
 * 静默忽略；官方 MCP JSON 位置为 `~/.claude.json` / `.mcp.json` / `claude mcp add-json`）：
 *   - hooks : `settings.json` —— `--config` → `$CLAUDE_SETTINGS` → `$CLAUDE_CONFIG_DIR/settings.json`
 *             → `~/.claude/settings.json`；不存在 → 报错并提示 `--config`（不自动创建）
 *   - MCP   : `--mcp-config <path>`（如项目 `.mcp.json`）→ 否则 `$CLAUDE_CONFIG_DIR/.claude.json`
 *             （设该变量时）→ 否则用户级 `~/.claude.json`（不存在则创建）
 *   `settings.json` 与 MCP 目标不得为同一文件。
 *
 * 合并语义：`hooks` 各事件下**用户既有条目一律保留**，仅追加/去重本适配器条目——按
 * `command === "node"` 且 `args[0]` 的**规范化绝对路径**命中本适配器脚本（不做 basename 兜底，
 * 以免误删用户自有的同名脚本）；`mcpServers` 仅增/改 `agentchat` 键。改动前备份 `<file>.bak`、
 * tmp+rename 原子写；`--dry-run` 只打印；`--uninstall` 精确移除两处本适配器条目（空数组键清空即删）。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertParentExists,
  assertSettingsExists,
  canonicalPath,
  commit,
  isRecord,
  normalizePath,
  readJson,
  readJsonIfExists,
  resolveMcpPath,
  resolveSettingsPath,
  serialize,
} from "./install-io.mjs"
import {
  agentchatConfigPath,
  applyVendor,
  readAgentchatConfig,
  serializeAgentchatConfig,
  writeAgentchatConfig,
} from "../agentchat-config.mjs"

const MCP_KEY = "agentchat"
/** 本厂商 id：写入 `<home>/config.json` 的 `adapters`（令用户免于手动设 env）。 */
const VENDOR_ID = "claude-code"
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_POSIX = ADAPTER_DIR.split(sep).join("/")

/** 事件 → 脚本 + 可选 matcher；与 `settings.snippet.json` 及 A4 脚本逐一对应。 */
const HOOK_EVENTS = [
  { event: "SessionStart", script: "session-start.mjs", matcher: "startup|resume|clear|compact|fork" },
  { event: "SubagentStart", script: "subagent-start.mjs", matcher: undefined },
  { event: "SubagentStop", script: "subagent-stop.mjs", matcher: undefined },
  { event: "PreToolUse", script: "busy.mjs", matcher: undefined },
  { event: "PostToolUse", script: "busy.mjs", matcher: undefined },
  { event: "Stop", script: "idle.mjs", matcher: undefined },
  { event: "Notification", script: "idle.mjs", matcher: "idle_prompt" },
]
/** 本适配器 hooks 的规范化绝对路径集合；归属识别严格按此匹配（用户同名脚本不受影响）。 */
const OUR_HOOK_PATHS = new Set(HOOK_EVENTS.map((e) => `${ADAPTER_POSIX}/${e.script}`))

// ── 将写内容 ────────────────────────────────────────────────────────

function hubUrl(env) {
  const port = env.AGENTCHAT_PORT !== undefined && env.AGENTCHAT_PORT !== "" ? env.AGENTCHAT_PORT : "4646"
  const base =
    env.AGENTCHAT_URL !== undefined && env.AGENTCHAT_URL !== ""
      ? env.AGENTCHAT_URL
      : `http://127.0.0.1:${port}`
  return `${base.replace(/\/+$/, "")}/mcp`
}

/** 与 `settings.snippet.json` 一致的 hooks 目标结构（`node` + 绝对路径，exec form 跨平台）。 */
function desiredHooks() {
  const out = {}
  for (const { event, script, matcher } of HOOK_EVENTS) {
    const hook = { type: "command", command: "node", args: [`${ADAPTER_POSIX}/${script}`] }
    out[event] = [matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] }]
  }
  return out
}

/**
 * 与 `mcp.snippet.json` 一致：**配置里不含 token**，改用 `headersHelper` 在连接时由
 * `mcp-headers.mjs` 从 `<AGENTCHAT_HOME>/hub_token` 等读取并输出头（规避凭据变量被读空）。
 */
function desiredMcp(env) {
  return {
    type: "http",
    url: hubUrl(env),
    headersHelper: `node "${ADAPTER_POSIX}/mcp-headers.mjs"`,
  }
}

// ── 合并 / 移除 ─────────────────────────────────────────────────────

function isOurHook(hook) {
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    hook.command === "node" &&
    Array.isArray(hook.args) &&
    hook.args.length > 0 &&
    typeof hook.args[0] === "string" &&
    OUR_HOOK_PATHS.has(normalizePath(hook.args[0]))
  )
}

function isOurEntry(entry) {
  return isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isOurHook)
}

function mergeHooks(config, desired) {
  if (config.hooks === undefined) config.hooks = {}
  else if (!isRecord(config.hooks)) throw new Error("目标 settings 的 hooks 字段不是对象，拒绝改写")
  let changed = false
  for (const [event, entries] of Object.entries(desired)) {
    const existing = config.hooks[event]
    if (existing === undefined) {
      config.hooks[event] = entries
      changed = true
      continue
    }
    if (!Array.isArray(existing)) throw new Error(`目标 settings 的 hooks.${event} 不是数组，拒绝改写`)
    const merged = [...existing.filter((entry) => !isOurEntry(entry)), ...entries]
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      config.hooks[event] = merged
      changed = true
    }
  }
  return changed
}

function uninstallHooks(config) {
  if (!isRecord(config.hooks)) return false
  let changed = false
  for (const event of Object.keys(config.hooks)) {
    const existing = config.hooks[event]
    if (!Array.isArray(existing)) continue
    const kept = existing.filter((entry) => !isOurEntry(entry))
    if (kept.length === existing.length) continue
    changed = true
    if (kept.length === 0) delete config.hooks[event]
    else config.hooks[event] = kept
  }
  if (changed && Object.keys(config.hooks).length === 0) delete config.hooks
  return changed
}

function mergeMcp(config, desired, force) {
  if (config.mcpServers === undefined) config.mcpServers = {}
  else if (!isRecord(config.mcpServers)) throw new Error("目标 MCP 配置的 mcpServers 字段不是对象，拒绝改写")
  const existing = config.mcpServers[MCP_KEY]
  if (existing === undefined) {
    config.mcpServers[MCP_KEY] = desired
    return true
  }
  if (JSON.stringify(existing) === JSON.stringify(desired)) return false
  // 结构不同 = 非本安装器产物（可能用户自有同名条目）：默认拒绝覆盖，除非 --force。
  if (!force) {
    throw new Error(
      `目标 MCP 配置已存在结构不同的 mcpServers.agentchat 条目（非本安装器产物）；拒绝覆盖。` +
        `确认它是本适配器的旧产物后，可加 --force 覆盖`,
    )
  }
  config.mcpServers[MCP_KEY] = desired
  return true
}

function uninstallMcp(config, desired) {
  if (!isRecord(config.mcpServers) || !Object.prototype.hasOwnProperty.call(config.mcpServers, MCP_KEY)) {
    return { changed: false, keptForeign: false }
  }
  // 仅当结构与本安装器产物一致才移除；否则保留用户自有条目并提示。
  if (JSON.stringify(config.mcpServers[MCP_KEY]) !== JSON.stringify(desired)) {
    return { changed: false, keptForeign: true }
  }
  delete config.mcpServers[MCP_KEY]
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
  return { changed: true, keptForeign: false }
}

// ── 参数与主流程 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    config: undefined,
    mcpConfig: undefined,
    dryRun: false,
    uninstall: false,
    force: false,
    help: false,
    error: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--force") args.force = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--config" || arg === "--mcp-config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        args.error = `${arg} 需要一个路径参数`
        return args
      }
      if (arg === "--config") args.config = value
      else args.mcpConfig = value
      i += 1
    } else {
      args.error = `未知参数：${arg}（支持 --config <path>、--mcp-config <path>、--dry-run、--uninstall、--force、--help）`
      return args
    }
  }
  return args
}

const HELP =
  [
    "AgentChat Claude Code 安装器",
    "用法：node adapters/claude-code/install.mjs [--config <path>] [--mcp-config <path>] [--dry-run] [--uninstall] [--force]",
    "  --config <path>      hooks 目标 settings.json（默认：$CLAUDE_SETTINGS 或 $CLAUDE_CONFIG_DIR/settings.json 或 ~/.claude/settings.json）",
    "  --mcp-config <path>  MCP 目标（默认：$CLAUDE_CONFIG_DIR/.claude.json 或 ~/.claude.json；项目级可用 <repo>/.mcp.json）",
    "  --dry-run 只打印不落盘；--uninstall 精确移除两处本适配器条目；--help 显示本帮助",
    "  --force 覆盖结构不同的既有 mcpServers.agentchat 条目（默认拒绝，以免破坏用户自有同名条目）",
    "另外把 claude-code 登记进 Hub 的 $AGENTCHAT_HOME/config.json（adapters 字段），免手动设 AGENTCHAT_ADAPTERS",
  ].join("\n") + "\n"

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.error !== undefined) {
    console.error(`[agentchat] 错误：${args.error}`)
    return 1
  }
  try {
    const env = process.env
    const settingsPath = resolveSettingsPath(args.config, env)
    const mcpPath = resolveMcpPath(args.mcpConfig, env)
    if (canonicalPath(settingsPath) === canonicalPath(mcpPath)) {
      throw new Error("settings 与 MCP 目标不能是同一文件（settings.json 的 mcpServers 会被静默忽略）")
    }
    assertSettingsExists(settingsPath)
    const settings = readJson(settingsPath, "settings")
    const existingMcp = readJsonIfExists(mcpPath, "MCP 配置")
    if (!args.uninstall && existingMcp === undefined) assertParentExists(mcpPath, "MCP 配置")

    const desired = desiredMcp(env)
    const hooksChanged = args.uninstall ? uninstallHooks(settings) : mergeHooks(settings, desiredHooks())
    const mcp = existingMcp ?? {}
    const mcpOutcome = args.uninstall
      ? existingMcp === undefined
        ? { changed: false, keptForeign: false }
        : uninstallMcp(mcp, desired)
      : { changed: mergeMcp(mcp, desired, args.force), keptForeign: false }
    const mcpChanged = mcpOutcome.changed
    if (mcpOutcome.keptForeign) {
      console.error("[agentchat] 已保留结构不同的 mcpServers.agentchat 条目（非本适配器产物，未删除）")
    }
    // 顺手把本厂商登记进 Hub `<home>/config.json` 的 adapters（免手动设 env）。
    const agentchatPath = agentchatConfigPath(env)
    const agentchatConfig = readAgentchatConfig(agentchatPath)
    const adaptersChanged = applyVendor(agentchatConfig, agentchatPath, VENDOR_ID, args.uninstall)
    const changed = hooksChanged || mcpChanged || adaptersChanged
    const action = args.uninstall ? "卸载" : "安装"

    if (args.dryRun) {
      process.stdout.write(`# hooks → ${settingsPath}\n${serialize(settings)}`)
      if (!args.uninstall || existingMcp !== undefined) {
        process.stdout.write(`# MCP → ${mcpPath}\n${serialize(mcp)}`)
      }
      process.stdout.write(`# Hub 适配器 → ${agentchatPath}\n${serializeAgentchatConfig(agentchatConfig)}`)
      console.error(`[agentchat] --dry-run：未写入（${changed ? "将有改动" : "无改动"}）`)
      return 0
    }
    if (!changed) {
      console.log(`[agentchat] 目标已是最新（${action}无改动）`)
      return 0
    }
    if (hooksChanged) commit(settingsPath, serialize(settings))
    if (mcpChanged) commit(mcpPath, serialize(mcp))
    if (adaptersChanged) writeAgentchatConfig(agentchatPath, agentchatConfig)
    console.log(`[agentchat] ${action}完成`)
    console.log(`[agentchat] hooks → ${settingsPath}${hooksChanged ? `（备份：${settingsPath}.bak）` : "（无改动）"}`)
    console.log(`[agentchat] MCP   → ${mcpPath}${mcpChanged ? `（备份：${mcpPath}.bak）` : "（无改动）"}`)
    if (adaptersChanged) {
      console.log(`[agentchat] Hub 适配器登记（${VENDOR_ID}）→ ${agentchatPath}（备份：${agentchatPath}.bak）`)
    }
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = main()
