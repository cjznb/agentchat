/**
 * 空闲轮询调度（与 `adapters/opencode/poll.ts` **同语义**）。
 *
 * 宿主只在事件上拉取消息；消息若在 agent **已经 idle 之后**到达，则没有任何事件触发者，
 * 永久停在「排队中」。本模块提供 idle 期间周期性 `run()` 的定时链（同一拉取路径），
 * 并让失败按指数退避拉长、成功即回到基础间隔——Hub 不可达时不刷屏/不自旋。
 *
 * 纪律：
 * - **无重叠执行**：`tick` 期间不再排下一个定时器，`run()` 的 Promise 未落定前绝不重入；
 * - 定时器经 `unref()`（尽力而为）不阻塞宿主进程退出；`stop()` 后不再有任何回调；
 * - `start()`/`stop()` **可安全重复调用**（重复 `start` 不叠加定时器）；
 * - `run()` 抛错按失败处理（记退避），**绝不冒泡**到宿主的定时器回调里。
 */

/** 默认轮询间隔（10s）。 */
export const DEFAULT_POLL_MS = 10_000
/** 允许的最小间隔（1s），防止 env 配成 busy-loop。 */
export const MIN_POLL_MS = 1_000
/** 允许的最大间隔（1h）。 */
export const MAX_POLL_MS = 3_600_000
/** 连续失败时的退避上限（60s）。 */
export const POLL_BACKOFF_CAP_MS = 60_000

/**
 * 解析 `AGENTCHAT_POLL_MS`：非数值/非正数回落 `DEFAULT_POLL_MS`；
 * 合法值钳制到 `[MIN_POLL_MS, MAX_POLL_MS]`（取整）。
 *
 * @param {string | undefined} raw 环境变量原值
 * @returns {number}
 */
export function parsePollMs(raw) {
  const value = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(value)))
}

/**
 * 单会话空闲轮询器：`start()` 后按间隔调用 `run()`（幂等）。
 * 失败 `run()` 后下一次间隔按 `min(cap, interval · 2^failures)` 拉长；成功后立即复位。
 */
export class IdlePoller {
  /**
   * @param {{intervalMs: number, backoffCapMs?: number,
   *   run: () => Promise<boolean> | boolean}} options
   */
  constructor(options) {
    this.options = options
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined
    this.failures = 0
    this.active = false
  }

  get isRunning() {
    return this.active
  }

  /** 启动（重复调用无效果）；清空历史失败计数，从基础间隔开始。 */
  start() {
    if (this.active) return
    this.active = true
    this.failures = 0
    this.schedule(this.options.intervalMs)
  }

  /** 停止并清理定时器（可安全重复调用）。 */
  stop() {
    this.active = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** @private 排下一次 tick；定时器尽力 `unref()` 以免阻塞宿主退出。 */
  schedule(delay) {
    const timer = setTimeout(() => {
      void this.tick()
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    this.timer = timer
  }

  /** @private 单次执行：吞掉 `run()` 的异常，按成功/失败决定下一次间隔。 */
  async tick() {
    this.timer = undefined
    if (!this.active) return
    let ok = false
    try {
      ok = await this.options.run()
    } catch {
      ok = false
    }
    if (!this.active) return
    if (ok) {
      this.failures = 0
    } else {
      this.failures += 1
    }
    const cap = this.options.backoffCapMs ?? POLL_BACKOFF_CAP_MS
    const delay = ok
      ? this.options.intervalMs
      : Math.min(cap, this.options.intervalMs * 2 ** Math.min(this.failures, 30))
    this.schedule(delay)
  }
}
