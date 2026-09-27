/**
 * AgentChat Claude Code 安装器：把 **hooks 事件条目** 并入用户 `settings.json`，
 * 把 **MCP server 条目** 并入 MCP 配置（默认用户级 `~/.claude.json`）。
 *
 * 用法：
 *   node adapters/claude-code/install.mjs [--config <path>] [--mcp-config <path>]
 *        [--dry-run] [--uninstall] [--help]
 *
 * 落点（官方事实：Claude Code settings schema **无根级 `mcpServers`**，写在 settings.json 会被
 * 静默忽略；官方 MCP JSON 位置为 `~/.claude.json` / `.mcp.json` / `claude mcp add-json`）：
 *   - hooks : `settings.json` —— `--config` → `$CLAUDE_SETTINGS` → `$CLAUDE_CONFIG_DIR/settings.json`
 *             → `~/.claude/settings.json`；不存在 → 报错并提示 `--config`（不自动创建）
 *   - MCP   : `--mcp-config <path>`（如项目 `.mcp.json`）→ 否则用户级 `~/.claude.json`（不存在则创建）
 *   `settings.json` 与 MCP 目标不得为同一文件。
 *
 * 合并语义：`hooks` 各事件下**用户既有条目一律保留**，仅追加/去重本适配器条目——按
 * `command === "node"` 且 `args[0]` 的**规范化绝对路径**命中本适配器脚本（不做 basename 兜底，
 * 以免误删用户自有的同名脚本）；`mcpServers` 仅增/改 `agentchat` 键。改动前备份 `<file>.bak`、
 * tmp+rename 原子写；`--dry-run` 只打印；`--uninstall` 精确移除两处本适配器条目（空数组键清空即删）。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const MCP_KEY = "agentchat"
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_POSIX = ADAPTER_DIR.split(sep).join("/")

/** 事件 → 脚本 + 可选 matcher；与 `settings.snippet.json` 及 A4 脚本逐一对应。 */
const HOOK_EVENTS = [
  { event: "SessionStart", script: "session-start.mjs", matcher: "startup|resume|clear|compact|fork" },
  { event: "SubagentStart", script: "subagent-start.mjs", matcher: undefined },
  { event: "PreToolUse", script: "busy.mjs", matcher: undefined },
  { event: "PostToolUse", script: "busy.mjs", matcher: undefined },
  { event: "Stop", script: "idle.mjs", matcher: undefined },
  { event: "Notification", script: "idle.mjs", matcher: "idle_prompt" },
]
/** 本适配器 hooks 的规范化绝对路径集合；归属识别严格按此匹配（用户同名脚本不受影响）。 */
const OUR_HOOK_PATHS = new Set(HOOK_EVENTS.map((e) => `${ADAPTER_POSIX}/${e.script}`))

// ── 目标文件解析 ────────────────────────────────────────────────────

function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

function resolveSettingsPath(explicit, env) {
  if (explicit !== undefined && explicit !== "") return explicit
  if (env.CLAUDE_SETTINGS !== undefined && env.CLAUDE_SETTINGS !== "") return env.CLAUDE_SETTINGS
  const dir =
    env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
      ? env.CLAUDE_CONFIG_DIR
      : join(homedir(), ".claude")
  return join(dir, "settings.json")
}

function resolveMcpPath(explicit) {
  return explicit !== undefined && explicit !== "" ? explicit : join(homedir(), ".claude.json")
}

function assertParentExists(path, label) {
  const dir = dirname(path)
  if (!existsSync(dir)) throw new Error(`${label} 父目录不存在：${dir}`)
}

function assertSettingsExists(path) {
  assertParentExists(path, "settings")
  if (!existsSync(path)) throw new Error(`settings 文件不存在：${path}（用 --config <path> 指定，或先创建）`)
}

// ── 将写内容 ────────────────────────────────────────────────────────

function hubUrl(env) {
  const base =
    env.AGENTCHAT_URL !== undefined && env.AGENTCHAT_URL !== ""
      ? env.AGENTCHAT_URL
      : `http://127.0.0.1:${env.AGENTCHAT_PORT ?? "4646"}`
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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

function mergeMcp(config, desired) {
  if (config.mcpServers === undefined) config.mcpServers = {}
  else if (!isRecord(config.mcpServers)) throw new Error("目标 MCP 配置的 mcpServers 字段不是对象，拒绝改写")
  if (JSON.stringify(config.mcpServers[MCP_KEY]) === JSON.stringify(desired)) return false
  config.mcpServers[MCP_KEY] = desired
  return true
}

function uninstallMcp(config) {
  if (!isRecord(config.mcpServers) || !Object.prototype.hasOwnProperty.call(config.mcpServers, MCP_KEY)) {
    return false
  }
  delete config.mcpServers[MCP_KEY]
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
  return true
}

// ── JSON 读写（备份 + tmp+rename 原子写）─────────────────────────────

function parseJson(text, label) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value)) throw new Error(`${label} 顶层不是对象，拒绝改写`)
  return value
}

function readJson(path, label) {
  return parseJson(readFileSync(path, "utf8"), label)
}

function readJsonIfExists(path, label) {
  return existsSync(path) ? readJson(path, label) : undefined
}

function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`
}

function commit(path, text) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// ── 参数与主流程 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: undefined, mcpConfig: undefined, dryRun: false, uninstall: false, help: false, error: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
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
      args.error = `未知参数：${arg}（支持 --config <path>、--mcp-config <path>、--dry-run、--uninstall、--help）`
      return args
    }
  }
  return args
}

const HELP =
  [
    "AgentChat Claude Code 安装器",
    "用法：node adapters/claude-code/install.mjs [--config <path>] [--mcp-config <path>] [--dry-run] [--uninstall]",
    "  --config <path>      hooks 目标 settings.json（默认：$CLAUDE_SETTINGS 或 $CLAUDE_CONFIG_DIR/settings.json 或 ~/.claude/settings.json）",
    "  --mcp-config <path>  MCP 目标（默认：~/.claude.json；项目级可用 <repo>/.mcp.json）",
    "  --dry-run 只打印不落盘；--uninstall 精确移除两处本适配器条目；--help 显示本帮助",
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
    const mcpPath = resolveMcpPath(args.mcpConfig)
    if (normalizePath(settingsPath) === normalizePath(mcpPath)) {
      throw new Error("settings 与 MCP 目标不能是同一文件（settings.json 的 mcpServers 会被静默忽略）")
    }
    assertSettingsExists(settingsPath)
    const settings = readJson(settingsPath, "settings")
    const existingMcp = readJsonIfExists(mcpPath, "MCP 配置")
    if (!args.uninstall && existingMcp === undefined) assertParentExists(mcpPath, "MCP 配置")

    const hooksChanged = args.uninstall ? uninstallHooks(settings) : mergeHooks(settings, desiredHooks())
    const mcp = existingMcp ?? {}
    const mcpChanged = args.uninstall
      ? existingMcp !== undefined && uninstallMcp(mcp)
      : mergeMcp(mcp, desiredMcp(env))
    const action = args.uninstall ? "卸载" : "安装"

    if (args.dryRun) {
      process.stdout.write(`# hooks → ${settingsPath}\n${serialize(settings)}`)
      if (!args.uninstall || existingMcp !== undefined) {
        process.stdout.write(`# MCP → ${mcpPath}\n${serialize(mcp)}`)
      }
      console.error(`[agentchat] --dry-run：未写入（${hooksChanged || mcpChanged ? "将有改动" : "无改动"}）`)
      return 0
    }
    if (!hooksChanged && !mcpChanged) {
      console.log(`[agentchat] 目标已是最新（${action}无改动）`)
      return 0
    }
    if (hooksChanged) commit(settingsPath, serialize(settings))
    if (mcpChanged) commit(mcpPath, serialize(mcp))
    console.log(`[agentchat] ${action}完成`)
    console.log(`[agentchat] hooks → ${settingsPath}${hooksChanged ? `（备份：${settingsPath}.bak）` : "（无改动）"}`)
    console.log(`[agentchat] MCP   → ${mcpPath}${mcpChanged ? `（备份：${mcpPath}.bak）` : "（无改动）"}`)
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = main()
