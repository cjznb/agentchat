/**
 * Claude Code 安装器的 IO / 路径层：目标文件解析、真实路径规范化、JSON 读写（备份 + tmp+rename 原子写）。
 *
 * 与合并策略（`install.mjs`）分离，使两文件各自单一职责且均在纯行上限内。
 * `canonicalPath` 用**规范化真实路径**（`realpath` + win32/darwin 大小写折叠）判定「同一文件」，
 * 防大小写变体/符号链接绕过「settings 与 MCP 不得同文件」。纯 JS；无第三方依赖。
 */
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * 大小写折叠：仅大小写不敏感文件系统（win32/darwin）需要。`AGENTCHAT_INSTALLER_PLATFORM`
 * 仅供测试注入判定（跨平台确定地验证大小写变体拒绝）。
 */
function caseFold(path) {
  const platform = process.env.AGENTCHAT_INSTALLER_PLATFORM ?? process.platform
  return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path
}

/**
 * 规范化**真实路径**：目标存在 → `realpath`（解析符号链接/别名/大小写）；不存在 →
 * `realpath(父目录)` + `basename`。父链解析失败时退回词法 `resolve`（后续断言会给出明确错误）。
 */
export function canonicalPath(p) {
  const abs = resolve(p)
  let real
  try {
    real = realpathSync.native(abs)
  } catch {
    let dir
    try {
      dir = realpathSync.native(dirname(abs))
    } catch {
      dir = dirname(abs)
    }
    real = join(dir, basename(abs))
  }
  return caseFold(real)
}

/** Claude Code 配置目录：`$CLAUDE_CONFIG_DIR`（非空）否则 `~/.claude`。 */
function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
    ? env.CLAUDE_CONFIG_DIR
    : join(homedir(), ".claude")
}

export function resolveSettingsPath(explicit, env) {
  if (explicit !== undefined && explicit !== "") return explicit
  if (env.CLAUDE_SETTINGS !== undefined && env.CLAUDE_SETTINGS !== "") return env.CLAUDE_SETTINGS
  return join(claudeConfigDir(env), "settings.json")
}

/**
 * MCP 目标：`--mcp-config` 显式优先；否则官方用户 scope 文件——**设置了 `CLAUDE_CONFIG_DIR`
 * 时 Claude Code 从该目录读 `.claude.json`**（与 settings 同目录），否则 `~/.claude.json`。
 */
export function resolveMcpPath(explicit, env) {
  if (explicit !== undefined && explicit !== "") return explicit
  return env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
    ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json")
}

export function assertParentExists(path, label) {
  const dir = dirname(path)
  if (!existsSync(dir)) throw new Error(`${label} 父目录不存在：${dir}`)
}

export function assertSettingsExists(path) {
  assertParentExists(path, "settings")
  if (!existsSync(path)) throw new Error(`settings 文件不存在：${path}（用 --config <path> 指定，或先创建）`)
}

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

export function readJson(path, label) {
  return parseJson(readFileSync(path, "utf8"), label)
}

export function readJsonIfExists(path, label) {
  return existsSync(path) ? readJson(path, label) : undefined
}

export function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** 备份 `<path>.bak` 后 tmp+rename 原子替换。 */
export function commit(path, text) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
