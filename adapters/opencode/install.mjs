/**
 * AgentChat OpenCode 安装器：把 **plugin 条目** 与 **MCP server 条目** 并入用户 OpenCode 配置。
 *
 * 用法：
 *   node adapters/opencode/install.mjs [--config <path>] [--dry-run] [--uninstall] [--force] [--help]
 *
 * 目标配置解析顺序（本文件实际支持，见 docs/adapters-opencode.md）：
 *   1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确错误，退出码 1）
 *   2. `$OPENCODE_CONFIG`（同上校验）
 *   3. `$XDG_CONFIG_HOME/opencode/`（未设则 `~/.config/opencode/`）下取
 *      `opencode.jsonc` → `opencode.json` 首个存在者；都无 → 报错并提示 `--config`
 *
 * MCP 条目为**本地 stdio 桥**（同目录 `mcp-bridge.mjs`），配置里**不含任何 `{file:}` 引用或机密**：
 * OpenCode 在解析配置前会对整份文件原文做 `{file:}` 替换，文件缺失即致命，故身份与传输 token
 * 改由桥**逐请求**从磁盘读取（见 docs/adapters-opencode.md）。旧版 `remote` + `{file:…opencode.id}`
 * 结构会被识别为本适配器旧产物，**无需 `--force`** 即可迁移；`--uninstall` 同样能移除它。
 *
 * 安全：改动前先备份 `<config>.bak`，再以临时文件 + rename 原子替换；`--dry-run` 只打印不落盘。
 * 幂等：重复安装内容等价；`--uninstall` 仅精确移除本适配器条目，保留用户其它键。
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseConfig } from "./jsonc.mjs"

const MCP_KEY = "agentchat"
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const BRIDGE_PATH = join(ADAPTER_DIR, "mcp-bridge.mjs")
const BRIDGE_BASENAME = /(^|[\\/])mcp-bridge\.mjs$/
const LEGACY_AGENT_ID = /^\{file:.*agents\/opencode\.id\}$/

// ── 目标配置解析 ────────────────────────────────────────────────────

function findDefaultConfig(env) {
  const dir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveConfigPath(explicit, env) {
  if (explicit !== undefined && explicit !== "") return explicit
  if (env.OPENCODE_CONFIG !== undefined && env.OPENCODE_CONFIG !== "") return env.OPENCODE_CONFIG
  const found = findDefaultConfig(env)
  if (found !== undefined) return found
  throw new Error(
    "找不到 OpenCode 配置（已查 $OPENCODE_CONFIG 与 ~/.config/opencode/opencode.jsonc|json）；请用 --config <path> 指定",
  )
}

function assertConfigExists(path) {
  const dir = dirname(path)
  if (!existsSync(dir)) throw new Error(`配置父目录不存在：${dir}`)
  if (!existsSync(path)) throw new Error(`配置文件不存在：${path}`)
}

// ── 将写内容 ────────────────────────────────────────────────────────

function posix(p) {
  return p.split(sep).join("/")
}

/** 仅写入显式覆盖的**非机密**环境变量；默认值不写（避免噪声与无谓 diff）。 */
function bridgeEnvironment(env) {
  const environment = {}
  const home = env.AGENTCHAT_HOME
  const url = env.AGENTCHAT_URL
  const port = env.AGENTCHAT_PORT
  if (home !== undefined && home !== "") environment.AGENTCHAT_HOME = home
  if (url !== undefined && url !== "") environment.AGENTCHAT_URL = url
  if (port !== undefined && port !== "" && port !== "4646") environment.AGENTCHAT_PORT = port
  return environment
}

function desiredEntries(env) {
  const environment = bridgeEnvironment(env)
  return {
    pluginPath: posix(ADAPTER_DIR),
    mcp: {
      // 本地 stdio：由 OpenCode 直接 spawn `[node, mcp-bridge.mjs]`。
      // node 取安装时的 process.execPath 绝对路径；换 node/升级后需重跑本安装器。
      type: "local",
      command: [process.execPath, posix(BRIDGE_PATH)],
      enabled: true,
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
    },
  }
}

// ── 合并 / 移除 ─────────────────────────────────────────────────────

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pluginSpec(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

/** 旧（会砖）结构：remote + `/mcp` + `x-agent-id: {file:…agents/opencode.id}`。 */
function isLegacyEntry(entry) {
  if (!isRecord(entry) || entry.type !== "remote") return false
  if (typeof entry.url !== "string" || !entry.url.endsWith("/mcp")) return false
  const headers = entry.headers
  if (!isRecord(headers)) return false
  return typeof headers["x-agent-id"] === "string" && LEGACY_AGENT_ID.test(headers["x-agent-id"])
}

/** 本适配器产物（含旧结构）：可无 `--force` 就地替换/卸载。 */
function isOwnEntry(entry) {
  if (isLegacyEntry(entry)) return true
  if (!isRecord(entry) || entry.type !== "local") return false
  const command = entry.command
  return Array.isArray(command) && typeof command[1] === "string" && BRIDGE_BASENAME.test(command[1])
}

function install(config, entries, force) {
  let changed = false
  let migrated = false
  if (config.plugin === undefined) {
    config.plugin = []
    changed = true
  } else if (!Array.isArray(config.plugin)) {
    throw new Error("目标配置的 plugin 字段不是数组，拒绝改写")
  }
  if (!config.plugin.some((entry) => pluginSpec(entry) === entries.pluginPath)) {
    config.plugin.push(entries.pluginPath)
    changed = true
  }
  if (config.mcp === undefined) {
    config.mcp = {}
    changed = true
  } else if (!isRecord(config.mcp)) {
    throw new Error("目标配置的 mcp 字段不是对象，拒绝改写")
  }
  const existing = config.mcp[MCP_KEY]
  if (existing === undefined) {
    config.mcp[MCP_KEY] = entries.mcp
    changed = true
  } else if (JSON.stringify(existing) !== JSON.stringify(entries.mcp)) {
    if (isOwnEntry(existing)) {
      // 本适配器旧结构（或旧路径）→ 无 --force 迁移到新结构。
      migrated = isLegacyEntry(existing)
      config.mcp[MCP_KEY] = entries.mcp
      changed = true
    } else if (force) {
      config.mcp[MCP_KEY] = entries.mcp
      changed = true
    } else {
      throw new Error(
        `目标配置已存在结构不同的 mcp.agentchat 条目（非本安装器产物）；拒绝覆盖。` +
          `确认它是本适配器的旧产物后，可加 --force 覆盖`,
      )
    }
  }
  return { changed, migrated }
}

function uninstall(config, entries) {
  let changed = false
  if (Array.isArray(config.plugin)) {
    const kept = config.plugin.filter((entry) => pluginSpec(entry) !== entries.pluginPath)
    if (kept.length !== config.plugin.length) {
      config.plugin = kept
      changed = true
    }
  }
  let keptForeign = false
  if (isRecord(config.mcp) && Object.prototype.hasOwnProperty.call(config.mcp, MCP_KEY)) {
    const existing = config.mcp[MCP_KEY]
    // 结构完全匹配或本适配器产物（含旧结构）→ 移除；否则保留用户自有条目并提示。
    if (JSON.stringify(existing) === JSON.stringify(entries.mcp) || isOwnEntry(existing)) {
      delete config.mcp[MCP_KEY]
      changed = true
    } else {
      keptForeign = true
    }
  }
  return { changed, keptForeign }
}

// ── 参数与主流程 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: undefined, dryRun: false, uninstall: false, force: false, help: false, error: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--force") args.force = true
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
      args.error = `未知参数：${arg}（支持 --config <path>、--dry-run、--uninstall、--force、--help）`
      return args
    }
  }
  return args
}

const HELP = [
  "AgentChat OpenCode 安装器",
  "用法：node adapters/opencode/install.mjs [--config <path>] [--dry-run] [--uninstall] [--force]",
  "  --config <path>   目标 OpenCode 配置（默认：$OPENCODE_CONFIG 或 ~/.config/opencode/opencode.jsonc|json）",
  "  --dry-run 只打印不落盘；--uninstall 精确移除本适配器条目；--help 显示本帮助",
  "  --force 覆盖结构不同的既有 mcp.agentchat 条目（默认拒绝；本适配器旧结构会自动迁移，无需此参数）",
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
    const configPath = resolveConfigPath(args.config, env)
    assertConfigExists(configPath)
    const config = parseConfig(readFileSync(configPath, "utf8"))
    const entries = desiredEntries(env)
    const action = args.uninstall ? "卸载" : "安装"
    const outcome = args.uninstall
      ? uninstall(config, entries)
      : { ...install(config, entries, args.force), keptForeign: false }
    const text = `${JSON.stringify(config, null, 2)}\n`
    if (outcome.keptForeign) {
      console.error("[agentchat] 已保留结构不同的 mcp.agentchat 条目（非本适配器产物，未删除）")
    }

    if (args.dryRun) {
      process.stdout.write(text)
      console.error(`[agentchat] --dry-run：未写入 ${configPath}（${outcome.changed ? "将有改动" : "无改动"}）`)
      return 0
    }
    if (!outcome.changed) {
      console.log(`[agentchat] 目标配置已是最新（${action}无改动）：${configPath}`)
      return 0
    }
    copyFileSync(configPath, `${configPath}.bak`)
    const tmp = `${configPath}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, configPath)
    if (outcome.migrated) {
      console.log(
        "[agentchat] 已从会砖的旧结构（remote + {file:…opencode.id} 身份头）迁移为本地 stdio 桥",
      )
    }
    console.log(`[agentchat] ${action}完成：${configPath}`)
    console.log(`[agentchat] 原文件已备份：${configPath}.bak`)
    console.log(`[agentchat] 插件条目：${entries.pluginPath}`)
    console.log(`[agentchat] MCP 条目：${MCP_KEY} → local ${entries.mcp.command[1]}`)
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = main()
