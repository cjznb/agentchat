/**
 * WorkBuddy 适配器的本地文件读写：`join_token` / 节点 id / 会话台账 / 去重集合 / block 计数。
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server
 * `ensureHubToken`、opencode 适配器同策略）。所有读写失败都不抛错 —— hook 不得因
 * 本地文件问题阻塞宿主。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { appendLog } from "./log.mjs"
import { homeForPath } from "./paths.mjs"
import { errorMessage } from "./util.mjs"

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
 * 可注入读取器的重试读取（照抄 claude-code 适配器的产品侧鲁棒性修复）：
 * - `ENOENT` = 未注册 / 无文件 → 直接 `undefined`（保持静默 skip 语义，**不重试**）；
 * - 其它错误（Windows 新建文件被 Defender 瞬时扫描的 `EPERM`/`EACCES` 等）→ 有限重试
 *   （默认 3 次、间隔 ~20ms）；仍失败则**记含错误码的日志**后按「无」处理（不得抛断宿主）。
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
          appendLog(homeForPath(path), `readText: ${path} unreadable after ${attempt} attempt(s): ${code ?? errorMessage(error)}`)
        }
        return undefined
      }
      sleepSync(delayMs)
    }
  }
}

/** 读文本；不存在/不可读/空白 → `undefined`（一律视同「无」）。 */
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
    return { ok: false, error: errorMessage(error) }
  }
}

/** 写文本 / token（同实现；命名区分语义，便于审计）。 */
export function writeText(path, text) {
  return writeFile(path, text)
}

export function writeToken(path, token) {
  return writeFile(path, token)
}

/** 写 JSON（单行 + 换行）。 */
export function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value)}\n`)
}

/** 删除文件（不存在视为成功）；供陈旧 token 自愈路径使用。 */
export function removeFile(path) {
  try {
    rmSync(path, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 文件大小（字节）；不存在/不可读 → `undefined`。 */
export function fileSize(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.size
  } catch {
    return undefined
  }
}

/** 追加一行（装配器写「受管块」时避免整文件重写；失败不抛）。 */
export function appendText(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, text)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 原子替换（tmp + rename）；配合 `copyFileSync` 备份实现「字节级还原」。 */
export { renameSync }
