/**
 * Claude Code hooks 适配器的本地文件读写：join_token / 节点 id / 根回合窗口 /
 * 子代理映射，以及日志追加。
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server
 * `ensureHubToken`、opencode 适配器同策略）。所有读写失败都不抛错——hook 不得因
 * 本地文件问题阻塞宿主。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

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
    subseq: join(agents, "claude-code.subseq.json"),
    stop: join(agents, "claude-code.stop.json"),
    substop: join(agents, "claude-code.substop.json"),
    seen: join(agents, "claude-code.seen.json"),
    log: join(home, "logs", "claude-code-adapter.log"),
  }
}

/** 从落盘路径反推数据目录：`<home>/agents/x` → `<home>`、`<home>/hub_token` → `<home>`。 */
function homeForPath(path) {
  const parent = dirname(path)
  return basename(parent) === "agents" ? dirname(parent) : parent
}

/** 提取 Node fs 错误码（`error.code`）；非对象/无码 → `undefined`。 */
function errorCode(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : undefined
}

/** 同步等待（Node 主线程 / worker 均允许 `Atomics.wait`）；`ms <= 0` 立即返回。 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 可注入读取器的重试读取（产品侧鲁棒性缺口修复）：
 * - `ENOENT` = 未注册 / 无文件 → 直接 `undefined`（保持既有静默 skip 语义，**不重试**）；
 * - 其它错误（Windows 新建文件被 Defender 瞬时扫描的 `EPERM`/`EACCES` 等）→ 有限重试
 *   （默认 3 次、间隔 ~20ms）；仍失败则**记含错误码的日志**后按「无」处理（**不得抛断宿主**）。
 * 此前 `readText` 把一切异常与「未注册」混为一谈 → 瞬时 fs 错误会**静默丢弃一次投递**（flake 根因）。
 */
export function readTextWithRetry(path, options = {}) {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 20
  const read = options.read ?? readFileSync
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = read(path, "utf8").trim()
      return value === "" ? undefined : value
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT" || attempt >= attempts) {
        if (code !== "ENOENT") {
          appendLog(
            homeForPath(path),
            `readText: ${path} unreadable after ${attempt} attempt(s): ${code ?? errorMessage(error)}`,
          )
        }
        return undefined
      }
      sleepSync(delayMs)
    }
  }
}

/** 读文本；不存在/不可读/空白 → `undefined`（一律视同「无」）。瞬时 fs 错误经 {@link readTextWithRetry} 有限重试。 */
export function readText(path) {
  return readTextWithRetry(path)
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

/** 日志轮转阈值：1 MiB（与 OpenCode 适配器侧对齐）。 */
const LOG_ROTATE_BYTES = 1024 * 1024

/**
 * 追加一行带时间戳日志；日志本身失败也不抛错（不得影响宿主）。
 * 写入前日志已 > 1 MiB → 整体改名 `<log>.1`（覆盖旧 `.1`，只保留一份），主文件从新行重新开始。
 */
export function appendLog(home, message) {
  try {
    const path = adapterPaths(home).log
    mkdirSync(dirname(path), { recursive: true })
    try {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat !== undefined && stat.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // 轮转失败（文件被占用等）不阻断本次追加
    }
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 忽略：日志失败不得影响宿主
  }
}

/** 统一错误消息提取。 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
