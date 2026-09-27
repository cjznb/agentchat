#!/usr/bin/env node
/**
 * AgentChat OpenCode 安装器：把 **plugin 条目** 与 **MCP server 条目** 并入用户 OpenCode 配置。
 *
 * 用法：
 *   node adapters/opencode/install.mjs [--config <path>] [--dry-run] [--uninstall] [--help]
 *
 * 目标配置解析顺序（本文件实际支持，见 docs/adapters-opencode.md）：
 *   1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确错误，退出码 1）
 *   2. `$OPENCODE_CONFIG`（同上校验）
 *   3. `$XDG_CONFIG_HOME/opencode/`（未设则 `~/.config/opencode/`）下取
 *      `opencode.jsonc` → `opencode.json` 首个存在者；都无 → 报错并提示 `--config`
 *
 * 安全：改动前先备份 `<config>.bak`，再以临时文件 + rename 原子替换；`--dry-run` 只打印不落盘。
 * 幂等：重复安装内容等价；`--uninstall` 仅精确移除本适配器条目，保留用户其它键。
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const MCP_KEY = "agentchat"
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))

class CliError extends Error {}

// ── 目标配置解析 ────────────────────────────────────────────────────

function resolveHome(env) {
  const home = env.AGENTCHAT_HOME
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}

function hubUrl(env) {
  const base =
    env.AGENTCHAT_URL !== undefined && env.AGENTCHAT_URL !== ""
      ? env.AGENTCHAT_URL
      : `http://127.0.0.1:${env.AGENTCHAT_PORT ?? "4646"}`
  return `${base.replace(/\/+$/, "")}/mcp`
}

function findDefaultConfig(env) {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config")
  const dir = join(base, "opencode")
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
  throw new CliError(
    "找不到 OpenCode 配置（已查 $OPENCODE_CONFIG 与 ~/.config/opencode/opencode.jsonc|json）；请用 --config <path> 指定",
  )
}

function assertConfigExists(path) {
  const dir = dirname(path)
  if (!existsSync(dir)) throw new CliError(`配置父目录不存在：${dir}`)
  if (!existsSync(path)) throw new CliError(`配置文件不存在：${path}`)
}

// ── 将写内容 ────────────────────────────────────────────────────────

function posix(p) {
  return p.split(sep).join("/")
}

/** home 下的绝对路径 → `~` 相对形式（OpenCode `{file:}` 支持 `~` 与 `/` 开头的绝对路径）。 */
function fileRef(absPath) {
  const homeDir = homedir()
  const prefix = homeDir.endsWith(sep) ? homeDir : homeDir + sep
  if (absPath === homeDir) return "~"
  if (absPath.startsWith(prefix)) return `~/${posix(absPath.slice(prefix.length))}`
  return posix(absPath)
}

function desiredEntries(env) {
  return {
    pluginPath: posix(ADAPTER_DIR),
    mcp: {
      type: "remote",
      url: hubUrl(env),
      enabled: true,
      headers: {
        Authorization: "Bearer {env:HUB_TOKEN}",
        "x-agent-id": `{file:${fileRef(join(resolveHome(env), "agents", "opencode.id"))}}`,
      },
    },
  }
}

// ── JSONC 解析（剥离注释与尾逗号；字符串感知）────────────────────────

function stripJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  let inLine = false
  let inBlock = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      i += 1
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i += 2
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i += 2
      continue
    }
    if (ch === "}" || ch === "]") out = out.replace(/,\s*$/, "")
    out += ch
    i += 1
  }
  return out
}

function parseConfig(text) {
  try {
    return JSON.parse(stripJsonc(text))
  } catch (error) {
    throw new CliError(`目标配置不是合法 JSON/JSONC：${error instanceof Error ? error.message : String(error)}`)
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

function install(config, entries) {
  let changed = false
  if (config.plugin === undefined) {
    config.plugin = []
    changed = true
  } else if (!Array.isArray(config.plugin)) {
    throw new CliError("目标配置的 plugin 字段不是数组，拒绝改写")
  }
  if (!config.plugin.some((entry) => pluginSpec(entry) === entries.pluginPath)) {
    config.plugin.push(entries.pluginPath)
    changed = true
  }
  if (config.mcp === undefined) {
    config.mcp = {}
    changed = true
  } else if (!isRecord(config.mcp)) {
    throw new CliError("目标配置的 mcp 字段不是对象，拒绝改写")
  }
  if (JSON.stringify(config.mcp[MCP_KEY]) !== JSON.stringify(entries.mcp)) {
    config.mcp[MCP_KEY] = entries.mcp
    changed = true
  }
  return changed
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
  if (isRecord(config.mcp) && Object.prototype.hasOwnProperty.call(config.mcp, MCP_KEY)) {
    delete config.mcp[MCP_KEY]
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

const HELP = `AgentChat OpenCode 安装器
用法：node adapters/opencode/install.mjs [--config <path>] [--dry-run] [--uninstall]

  --config <path>   目标 OpenCode 配置（默认：$OPENCODE_CONFIG 或 ~/.config/opencode/opencode.jsonc|json）
  --dry-run         只打印将写内容，不落盘
  --uninstall       精确移除本适配器的 plugin 与 MCP 条目
  --help            显示本帮助
`

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
    const changed = args.uninstall ? uninstall(config, entries) : install(config, entries)
    const text = `${JSON.stringify(config, null, 2)}\n`

    if (args.dryRun) {
      process.stdout.write(text)
      console.error(`[agentchat] --dry-run：未写入 ${configPath}（${changed ? "将有改动" : "无改动"}）`)
      return 0
    }
    if (!changed) {
      console.log(`[agentchat] 目标配置已是最新（${action}无改动）：${configPath}`)
      return 0
    }
    copyFileSync(configPath, `${configPath}.bak`)
    const tmp = `${configPath}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, configPath)
    console.log(`[agentchat] ${action}完成：${configPath}`)
    console.log(`[agentchat] 原文件已备份：${configPath}.bak`)
    console.log(`[agentchat] 插件条目：${entries.pluginPath}`)
    console.log(`[agentchat] MCP 条目：${MCP_KEY} → ${entries.mcp.url}`)
    return 0
  } catch (error) {
    console.error(`[agentchat] 错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = main()
