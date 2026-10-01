/**
 * DSH 适配器的本地文件读写：join_token / 节点 id / JSON 状态，以及**安全读取**。
 *
 * 落盘路径（vendor id = `dsh`，与 OpenCode 的 `opencode.token` / `opencode.id` 同构）：
 * - `<home>/agents/dsh.token` — Hub 注册返回的 join_token（重连认领用）
 * - `<home>/agents/dsh.id`    — Hub 分配的**实例节点** agent id（桥的出站身份兜底值）
 * - `<home>/agents/dsh.current` — **当前会话节点** id 提示（仅「恰好一个顶层会话」时存在，见
 *   `currentPath` 与 `lib/session-hint.js`）；桥优先用它作 `x-agent-id`，回复因此能到达会话节点
 * - `<home>/agents/dsh.seen.json` — 已注入 messageId 去重集合（见 `seenPath`）
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server 侧
 * `writeTokenFile`、Claude Code / OpenCode 适配器同策略）。
 *
 * 纪律：**所有文件操作都不抛错**——`readToken`/`readJson` 读不到一律视为「无」，
 * 写入返回 `{ok, error}` 由调用方报告后继续（不得因本地文件问题中断注册或阻塞宿主）。
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createFileLog } from "./log.js"

/** 本适配器的 vendor id（路径与日志 scope 的单一来源）。 */
export const VENDOR = "dsh"

/** 本适配器的 join_token 落盘路径。 */
export function tokenPath(home) {
  return join(home, "agents", `${VENDOR}.token`)
}

/** 本适配器注册得到的**节点 agent id** 落盘路径（本地桥逐请求读取作 `x-agent-id`）。 */
export function agentIdPath(home) {
  return join(home, "agents", `${VENDOR}.id`)
}

/**
 * 「当前顶层会话节点」提示文件路径 `<home>/agents/dsh.current`（内容 = Hub 会话节点 id 原文）。
 *
 * 由插件在**恰好一个顶层会话**（父 = 实例节点）存活时写入、0 个或 ≥2 个时删除（见
 * `lib/session-hint.js`）；MCP 桥逐请求读它并与 `<home>/agents/dsh.id` 做「先提示、后实例」的
 * 解析。为什么需要它：Hub 只在 `initialize` 时认 `x-agent-id`，且容器节点**不可作为 DM 收件方**，
 * 故进程级身份必须是会话节点，否则对端无法回复。
 */
export function currentPath(home) {
  return join(home, "agents", `${VENDOR}.current`)
}

/** 已注入 messageId 去重集合的落盘路径（可选持久化；内存去重见 `util.createBoundedSet`）。 */
export function seenPath(home) {
  return join(home, "agents", `${VENDOR}.seen.json`)
}

/**
 * 从落盘路径反推数据目录：`<home>/agents/x` → `<home>`、`<home>/hub_token` → `<home>`
 * （两种布局都覆盖，供失败日志定位 `<home>/logs/`）。
 */
function homeForPath(path) {
  const parent = dirname(path)
  return basename(parent) === "agents" ? dirname(parent) : parent
}

/** 提取 Node fs 错误码（`error.code`）；非对象/无码 → `undefined`。 */
function errorCode(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string"
    ? error.code
    : undefined
}

/** 同步等待（Node 主线程 / worker 均允许 `Atomics.wait`）；`ms <= 0` 立即返回。 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 读 token / 节点 id（带**有限重试**）。
 *
 * - `ENOENT` = 未注册 / 无 token → 直接 `undefined`（保持既有静默语义，**不重试**）；
 * - 其它错误（Windows 上新建文件被 Defender 瞬时抢占的 `EPERM`/`EACCES` 等）→ 有限重试；
 * - 重试仍失败 → **记一条含错误码的日志**后按「无」处理（绝不抛断宿主）；
 * - 内容去空白后为空串 → `undefined`（空文件等同无 token）。
 *
 * @param {string} path 目标文件
 * @param {{attempts?: number, delayMs?: number, read?: (path: string, encoding: string) => string,
 *   log?: (message: string) => void}} [options] 注入点（单测用）
 * @returns {string | undefined}
 */
export function readToken(path, options = {}) {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 20
  const read = options.read ?? ((target, encoding) => readFileSync(target, encoding))
  const log = options.log ?? createFileLog({ AGENTCHAT_HOME: homeForPath(path) }, "plugin")
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = read(path, "utf8").trim()
      return value === "" ? undefined : value
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT" || attempt >= attempts) {
        if (code !== "ENOENT") {
          log(`readToken: ${path} unreadable after ${attempt} attempt(s): ${code ?? String(error)}`)
        }
        return undefined
      }
      sleepSync(delayMs)
    }
  }
}

/**
 * 读 JSON 对象（不存在/非法/非对象 → `undefined`；绝不抛错）。
 *
 * @param {string} path 目标文件
 * @param {{attempts?: number, delayMs?: number, read?: (path: string, encoding: string) => string,
 *   log?: (message: string) => void}} [options] 透传给 `readToken`
 * @returns {Record<string, unknown> | undefined}
 */
export function readJson(path, options = {}) {
  const text = readToken(path, options)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 写文件（`mkdir -p` + 0600 尽力而为）；失败返回 `{ok:false, error}`，**绝不抛错**。 */
function writeFile(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 写 join_token（`<home>/agents/dsh.token`）。 */
export function writeToken(path, value) {
  return writeFile(path, value)
}

/** 写任意文本。 */
export function writeText(path, text) {
  return writeFile(path, text)
}

/** 写 JSON（末尾补换行，便于人工查看）。 */
export function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value)}\n`)
}

/** 清除陈旧 token（文件不存在视为成功）；供 `invalid_join_token` 回退路径使用。 */
export function clearToken(path) {
  try {
    rmSync(path, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
