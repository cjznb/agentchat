/**
 * 原生工具面的**自动注册重试**（P8）：把「注册一次失败就永不再试」改成「指数退避重试到成功为止」。
 *
 * 真机事故（测试员A 报告，已核实）：DSH 加载插件时 Hub 还没起来 → `mcp().list()` 抛错 / 注册 0 个 →
 * 此后不再尝试。症状是「消息收得到、工具列表里没有任何 agentchat、发不出去」，只能重启 DSH。
 *
 * 纪律（与适配器其余部分一致）：
 * - 本模块**绝不抛错**（连注入的 `log` 抛错也吞掉）：失败只体现在返回值与日志里；
 * - 同一时刻最多一个定时器 + 一个在途尝试；`stop()` 之后不再有任何回调（`dispose()` 据此证明无悬挂 timer）；
 * - 同一失败原因不逐轮刷屏：首次失败、原因变化、每 `logEveryAttempts` 次、或距上次日志超过
 *   `logEveryMs` 才记一条；
 * - 定时器 / 时钟 / 随机数**全部可注入**：单测不真等 5s/60s，也不依赖 fake timers。
 *
 * @module lib/tool-register
 */
import { describe } from "./util.js"

/** 首次重试间隔（毫秒）：5s → 10s → 20s → 40s → 封顶 60s（±抖动）。 */
export const RETRY_BASE_MS = 5_000
/** 重试间隔上限（毫秒）。 */
export const RETRY_CAP_MS = 60_000
/** 同一原因的日志节流：每 N 次尝试最多一条。 */
export const LOG_EVERY_ATTEMPTS = 5
/** 同一原因的日志节流：每 N 毫秒最多一条（缺省 5 分钟）。 */
export const LOG_EVERY_MS = 300_000
/** 默认抖动幅度（±10%）。 */
export const RETRY_JITTER = 0.1

/**
 * 建自动注册调度器。
 *
 * @param {{
 *   attempt: () => Promise<{count: number, captured?: readonly string[]}>} attempt 单次尝试
 *     （`count > 0` 即成功；`captured` 是该轮内部的诊断行，由本调度按节流策略决定是否 flush）
 * @param {(message: string) => void} log 诊断（写文件日志 + `ctx.logger.warn`，绝不写 stdout）
 * @param {number} [baseMs] 首次重试间隔
 * @param {number} [capMs] 重试间隔上限
 * @param {number} [logEveryAttempts] 同原因日志的尝试次数节流
 * @param {number} [logEveryMs] 同原因日志的时间节流
 * @param {number} [jitter] 抖动幅度（0 = 不抖动；0.1 = ±10%）
 * @param {() => number} [now] 时钟
 * @param {() => number} [random] 随机数（注入后单测可得到确定间隔）
 * @param {(fn: () => void, ms: number) => unknown} [setTimeout] 定时器
 * @param {(id: unknown) => void} [clearTimeout] 取消定时器
 * @returns {{
 *   start: () => void, stop: () => void, attempts: () => number, failures: () => number,
 *   succeeded: () => boolean, running: () => boolean, nextDelayMs: () => number | undefined,
 * }} 句柄：`attempts`/`failures`/`succeeded` 供测试与排查；`nextDelayMs` = 当前待触发重试的间隔。
 */
export function createAutoRegister(deps) {
  const baseMs = deps.baseMs ?? RETRY_BASE_MS
  const capMs = deps.capMs ?? RETRY_CAP_MS
  const logEveryAttempts = deps.logEveryAttempts ?? LOG_EVERY_ATTEMPTS
  const logEveryMs = deps.logEveryMs ?? LOG_EVERY_MS
  const jitter = deps.jitter ?? RETRY_JITTER
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const schedule = deps.setTimeout ?? setTimeout
  const unschedule = deps.clearTimeout ?? clearTimeout

  /** 待触发的重试定时器（`undefined` = 没有待触发重试）。 */
  let timer
  /** 上面那个定时器的间隔（`nextDelayMs()` 用；`timer` 为 undefined 时无意义）。 */
  let delayMs
  let inFlight = false
  let stopped = false
  /** 已成功（`count > 0`）：此后**永不再试**，避免重复注册出两套同名工具。 */
  let done = false
  let attemptCount = 0
  let failureCount = 0
  /** 最近一次被记下的失败原因 + 节流位点。 */
  let lastReason
  let lastLoggedAt = 0
  let lastLoggedAttempt = 0

  /** 注入的 `log` 抛错不得影响重试（本模块的唯一纪律：绝不抛给宿主）。 */
  function safeLog(message) {
    try {
      deps.log(message)
    } catch {
      // 日志失败忽略
    }
  }

  /** 尽力而为的 `unref()`（Node 定时器才有；注入的手控定时器是 no-op）。 */
  function unref(handle) {
    try {
      if (typeof handle === "object" && handle !== null && typeof handle.unref === "function") handle.unref()
    } catch {
      // unref 失败忽略
    }
  }

  /** 第 `failures` 次失败后的等待：`min(cap, base · 2^(failures-1))` × (1 ± jitter)。 */
  function nextDelay(failures) {
    const raw = Math.min(capMs, baseMs * 2 ** Math.min(failures - 1, 20))
    const factor = 1 - jitter + 2 * jitter * random()
    return Math.max(1, Math.round(raw * factor))
  }

  /** 这次失败该不该记日志：首次 / 原因变化 / 每 N 次 / 距上次超过 N 毫秒。 */
  function shouldLog(reason) {
    if (attemptCount === 1) return true
    if (reason !== lastReason) return true
    if (attemptCount - lastLoggedAttempt >= logEveryAttempts) return true
    return now() - lastLoggedAt >= logEveryMs
  }

  /** 失败一轮：按需响亮告警 + 排下一次重试。 */
  function fail(reason, captured) {
    failureCount += 1
    const wait = nextDelay(failureCount)
    if (shouldLog(reason)) {
      for (const line of captured) safeLog(line)
      safeLog(
        `原生工具面自动注册失败（第 ${attemptCount} 次尝试）：${reason}。` +
          "Hub 可能未启动——启动 Hub 后会自动重试；若日志提示宿主缺少 tools 服务，" +
          "请用 `node adapters/dsh/install.mjs --with-mcp-bridge` 重装以保留 MCP 桥工具行。" +
          `约 ${Math.round(wait / 1000)}s 后重试`,
      )
      lastReason = reason
      lastLoggedAt = now()
      lastLoggedAttempt = attemptCount
    }
    if (stopped || done) return
    delayMs = wait
    timer = schedule(() => {
      void run()
    }, wait)
    // 尽力而为：重试定时器不该单独把宿主进程（或测试 worker）挂住——与 `lib/poll.js` 同策略。
    // 注入的手控定时器没有该方法，此处即 no-op。
    unref(timer)
  }

  /** 尝试一轮（**绝不抛**）：成功即收尾并停表；失败走 `fail`。 */
  async function run() {
    timer = undefined
    delayMs = undefined
    if (stopped || done || inFlight) return
    inFlight = true
    attemptCount += 1
    let count = 0
    let captured = []
    let reason
    try {
      const result = await deps.attempt()
      count = typeof result?.count === "number" ? result.count : 0
      captured = Array.isArray(result?.captured) ? result.captured : []
      if (count <= 0) reason = "注册数为 0（宿主没有 tools 服务，或 Hub 工具列表为空/不可达）"
    } catch (error) {
      reason = describe(error)
    } finally {
      inFlight = false
    }
    if (stopped) return
    if (count > 0) {
      done = true
      for (const line of captured) safeLog(line)
      safeLog(`原生工具面自动注册成功（第 ${attemptCount} 次尝试）：已注册 ${count} 个工具，停止重试`)
      return
    }
    fail(reason ?? "未知原因", captured)
  }

  return {
    /** 立即尝试一次（幂等：已有定时器/在途尝试/已成功/已停止时不重复启动）。 */
    start() {
      if (stopped || done || inFlight || timer !== undefined) return
      void run().catch(() => undefined) // run 自身不抛；双保险，绝不产生未处理拒绝
    },
    /** 停止：取消待触发的重试，此后不再有任何回调（在途尝试返回后也不再排下一次）。 */
    stop() {
      stopped = true
      delayMs = undefined
      if (timer !== undefined) {
        try {
          unschedule(timer)
        } catch {
          // 取消失败忽略：`stopped` 已保证回调不再排下一次
        }
        timer = undefined
      }
    },
    attempts: () => attemptCount,
    failures: () => failureCount,
    succeeded: () => done,
    running: () => timer !== undefined || inFlight,
    nextDelayMs: () => (timer === undefined ? undefined : delayMs),
  }
}
