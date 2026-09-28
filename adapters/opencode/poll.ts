/**
 * 空闲轮询调度（Plan 5 修复 1，缺陷 A）。
 *
 * OpenCode 插件只在 `session.idle`/`session.status(idle)` **事件**上拉取（`/internal/wake`）；
 * 消息若在 agent **已经 idle 之后**到达，则没有任何事件触发者，永久停在「排队中」。
 * 本模块提供 idle 期间周期性 `run()` 的定时链（同一拉取路径），并让失败按指数退避拉长、
 * 成功即回到基础间隔——Hub 不可达时不刷屏/不自旋。
 *
 * 定时器经 `unref()`（尽力而为）不阻塞宿主进程退出；调用方在 `dispose` 时 `stop()` 清理。
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
 */
export function parsePollMs(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(value)))
}

export interface IdlePollerOptions {
  /** 成功后的基础间隔。 */
  readonly intervalMs: number
  /** 失败退避上限（缺省 `POLL_BACKOFF_CAP_MS`）。 */
  readonly backoffCapMs?: number
  /** 单次轮询：`true` = 成功（重置退避），`false`/抛错 = 失败（拉长间隔）。 */
  readonly run: () => Promise<boolean>
}

/**
 * 单会话空闲轮询器：`start()` 后按间隔调用 `run()`（幂等，重复 `start` 不叠加定时器）。
 * 失败 `run()` 后下一次间隔按 `min(cap, interval · 2^failures)` 拉长；成功后立即复位。
 */
export class IdlePoller {
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private active = false

  constructor(private readonly options: IdlePollerOptions) {}

  get isRunning(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.failures = 0
    this.schedule(this.options.intervalMs)
  }

  stop(): void {
    this.active = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(delay: number): void {
    const timer = setTimeout(() => {
      void this.tick()
    }, delay)
    const unrefable = timer as { unref?: () => void }
    if (typeof unrefable.unref === "function") unrefable.unref()
    this.timer = timer
  }

  private async tick(): Promise<void> {
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
