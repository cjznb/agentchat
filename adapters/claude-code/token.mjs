/**
 * Claude Code hooks 适配器的本地文件读写：join_token / 节点 id / 根回合窗口 /
 * 子代理映射，以及日志追加。
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server
 * `ensureHubToken`、opencode 适配器同策略）。所有读写失败都不抛错——hook 不得因
 * 本地文件问题阻塞宿主。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** `AGENTCHAT_HOME`（空串视同未设）→ 数据目录；默认 `~/.agentchat`（与 Hub 一致）。 */
export function resolveHome(env) {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}

/** 本适配器全部落盘路径的单一来源。 */
export function adapterPaths(home) {
  const agents = join(home, "agents")
  return {
    home,
    token: join(agents, "claude-code.token"),
    agentId: join(agents, "claude-code.id"),
    root: join(agents, "claude-code.root.json"),
    subs: join(agents, "claude-code.subs.json"),
    log: join(home, "logs", "claude-code-adapter.log"),
  }
}

/** 读文本；不存在/不可读/空白 → `undefined`（一律视同「无」）。 */
export function readText(path) {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

/** 读 JSON 对象；不存在/非法/非对象 → `undefined`。 */
export function readJson(path) {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function writeFile(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data, { mode: 0o600 })
    chmodSync(path, 0o600) // Windows 上尽力而为（权限位可能不生效）
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function writeText(path, text) {
  return writeFile(path, text)
}

export function writeToken(path, token) {
  return writeFile(path, token)
}

export function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value)}\n`)
}

/** 删除文件（不存在视为成功）；供陈旧 token 自愈路径使用。 */
export function removeFile(path) {
  try {
    rmSync(path, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 追加一行带时间戳日志；日志本身失败也不抛错（不得影响宿主）。 */
export function appendLog(home, message) {
  try {
    const path = adapterPaths(home).log
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 忽略：日志失败不得影响宿主
  }
}

/** 统一错误消息提取。 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
