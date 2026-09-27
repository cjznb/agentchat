/**
 * AgentChat Claude Code 安装器：把 **hooks 事件条目** 与 **MCP server 条目** 并入用户
 * Claude Code `settings.json`。
 *
 * 用法：
 *   node adapters/claude-code/install.mjs [--config <path>] [--dry-run] [--uninstall] [--help]
 *
 * 目标 settings 解析顺序（本文件实际支持，见 docs/adapters-claude-code.md）：
 *   1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确错误，退出码 1）
 *   2. `$CLAUDE_SETTINGS`（AgentChat 约定覆盖；同上校验）
 *   3. `$CLAUDE_CONFIG_DIR/settings.json`（Claude Code 官方配置目录重定位），否则
 *      `~/.claude/settings.json`；文件不存在 → 报错并提示 `--config`（不自动创建）
 *
 * 合并语义（关键）：`hooks` 各事件下**用户既有条目一律保留**，仅追加本适配器条目并按脚本
 * 路径去重（重复安装不产生重复、内容等价）；`mcpServers` 仅增/改 `agentchat` 键，不动他人。
 * `--uninstall` 精确移除本适配器 hooks 条目（数组空则删该键）与 `mcpServers.agentchat`。
 *
 * 安全：改动前备份 `<config>.bak`，再以临时文件 + rename 原子替换；`--dry-run` 只打印不落盘。
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const MCP_KEY = "agentchat"
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))

/** 事件 → 脚本 + 可选 matcher；与 `settings.snippet.json` 及 A4 脚本逐一对应。 */
const HOOK_EVENTS = [
  { event: "SessionStart", script: "session-start.mjs", matcher: "startup|resume|clear|compact|fork" },
  { event: "SubagentStart", script: "subagent-start.mjs", matcher: undefined },
  { event: "PreToolUse", script: "busy.mjs", matcher: undefined },
  { event: "PostToolUse", script: "busy.mjs", matcher: undefined },
  { event: "Stop", script: "idle.mjs", matcher: undefined },
  { event: "Notification", script: "idle.mjs", matcher: "idle_prompt" },
]
/** 本适配器脚本 basename 集合；hooks 条目按 `args[0]` 的 basename 识别归属（可跨目录搬移）。 */
const OUR_SCRIPTS = new Set(HOOK_EVENTS.map((e) => e.script))

// ── 目标 settings 解析 ──────────────────────────────────────────────

function defaultConfigPath(env) {
  const dir =
    env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
      ? env.CLAUDE_CONFIG_DIR
      : join(homedir(), ".claude")
  return join(dir, "settings.json")
}

function resolveConfigPath(explicit, env) {
  if (explicit !== undefined && explicit !== "") return explicit
  if (env.CLAUDE_SETTINGS !== undefined && env.CLAUDE_SETTINGS !== "") return env.CLAUDE_SETTINGS
  return defaultConfigPath(env)
}

function assertConfigExists(path) {
  const dir = dirname(path)
  if (!existsSync(dir)) throw new Error(`settings 父目录不存在：${dir}`)
  if (!existsSync(path)) throw new Error(`settings 文件不存在：${path}（用 --config <path> 指定，或先创建）`)
}

// ── 将写内容 ────────────────────────────────────────────────────────

function posix(p) {
  return p.split(sep).join("/")
}

function hubUrl(env) {
  const base =
    env.AGENTCHAT_URL !== undefined && env.AGENTCHAT_URL !== ""
      ? env.AGENTCHAT_URL
      : `http://127.0.0.1:${env.AGENTCHAT_PORT ?? "4646"}`
  return `${base.replace(/\/+$/, "")}/mcp`
}

/** 与 snippet 一致的 hooks 目标结构（`node` + 绝对路径，exec form 跨平台）。 */
function desiredHooks() {
  const dir = posix(ADAPTER_DIR)
  const out = {}
  for (const { event, script, matcher } of HOOK_EVENTS) {
    const hook = { type: "command", command: "node", args: [`${dir}/${script}`] }
    out[event] = [matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] }]
  }
  return out
}

/** 与 snippet 一致的 MCP 条目；`${…}` 由 Claude Code 在连接时展开（文件引用不支持，故用环境变量）。 */
function desiredMcp(env) {
  return {
    type: "http",
    url: hubUrl(env),
    headers: {
      Authorization: "Bearer ${HUB_TOKEN}",
      "x-agent-id": "${AGENTCHAT_AGENT_ID}",
    },
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
    Array.isArray(hook.args) &&
    hook.args.length > 0 &&
    typeof hook.args[0] === "string" &&
    OUR_SCRIPTS.has(basename(hook.args[0]))
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

function mergeMcp(config, desired) {
  if (config.mcpServers === undefined) config.mcpServers = {}
  else if (!isRecord(config.mcpServers)) throw new Error("目标 settings 的 mcpServers 字段不是对象，拒绝改写")
  if (JSON.stringify(config.mcpServers[MCP_KEY]) === JSON.stringify(desired)) return false
  config.mcpServers[MCP_KEY] = desired
  return true
}

function install(config, env) {
  let changed = mergeHooks(config, desiredHooks())
  if (mergeMcp(config, desiredMcp(env))) changed = true
  return changed
}

function uninstall(config) {
  let changed = false
  if (isRecord(config.hooks)) {
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
  }
  if (isRecord(config.mcpServers) && Object.prototype.hasOwnProperty.call(config.mcpServers, MCP_KEY)) {
    delete config.mcpServers[MCP_KEY]
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
    changed = true
  }
  return changed
}

// ── 参数与主流程 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: undefined, dryRun: false, uninstall: false, help: false, error: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        args.error = "--config 需要一个路径参数"
        return args
      }
      args.config = value
      i += 1
    } else {
      args.error = `未知参数：${arg}（支持 --config <path>、--dry-run、--uninstall、--help）`
      return args
    }
  }
  return args
}

const HELP =
  [
    "AgentChat Claude Code 安装器",
    "用法：node adapters/claude-code/install.mjs [--config <path>] [--dry-run] [--uninstall]",
    "  --config <path>   目标 settings.json（默认：$CLAUDE_SETTINGS 或 $CLAUDE_CONFIG_DIR/settings.json 或 ~/.claude/settings.json）",
    "  --dry-run 只打印不落盘；--uninstall 精确移除本适配器条目；--help 显示本帮助",
  ].join("\n") + "\n"

function parseConfig(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`目标 settings 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

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
    const configPath = resolveConfigPath(args.config, env)
    assertConfigExists(configPath)
    const config = parseConfig(readFileSync(configPath, "utf8"))
    if (!isRecord(config)) throw new Error("目标 settings 顶层不是对象，拒绝改写")
    const action = args.uninstall ? "卸载" : "安装"
    const changed = args.uninstall ? uninstall(config) : install(config, env)
    const text = `${JSON.stringify(config, null, 2)}\n`

    if (args.dryRun) {
      process.stdout.write(text)
      console.error(`[agentchat] --dry-run：未写入 ${configPath}（${changed ? "将有改动" : "无改动"}）`)
      return 0
    }
    if (!changed) {
      console.log(`[agentchat] 目标 settings 已是最新（${action}无改动）：${configPath}`)
      return 0
    }
    copyFileSync(configPath, `${configPath}.bak`)
    const tmp = `${configPath}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, configPath)
    console.log(`[agentchat] ${action}完成：${configPath}`)
    console.log(`[agentchat] 原文件已备份：${configPath}.bak`)
    console.log(`[agentchat] hooks 条目：${posix(ADAPTER_DIR)}/{session-start,subagent-start,busy,idle}.mjs`)
    console.log(`[agentchat] MCP 条目：${MCP_KEY} → ${desiredMcp(env).url}`)
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = main()
