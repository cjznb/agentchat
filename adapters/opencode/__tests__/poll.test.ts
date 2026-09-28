/**
 * 空闲轮询调度单测（Plan 5 修复 1）——`parsePollMs` 解析/钳制 + `IdlePoller`
 * 定时链、失败退避与恢复（全部用假定时器，无 sleep）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_POLL_MS,
  IdlePoller,
  MAX_POLL_MS,
  MIN_POLL_MS,
  parsePollMs,
} from "../poll"

describe("parsePollMs", () => {
  it("falls back to the default on unset or non-numeric values", () => {
    expect(parsePollMs(undefined)).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("abc")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("0")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("-5")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("NaN")).toBe(DEFAULT_POLL_MS)
  })

  it("accepts a valid override and clamps it into the sane range", () => {
    expect(parsePollMs("5000")).toBe(5000)
    expect(parsePollMs("500")).toBe(MIN_POLL_MS)
    expect(parsePollMs("99999999")).toBe(MAX_POLL_MS)
  })
})

describe("IdlePoller", () => {
  afterEach(() => vi.useRealTimers())

  it("runs on the base interval and keeps rescheduling after success", async () => {
    vi.useFakeTimers()
    const runs: number[] = []
    const poller = new IdlePoller({ intervalMs: 1000, run: async () => (runs.push(Date.now()), true) })
    poller.start()
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toHaveLength(2)
    poller.stop()
  })

  it("back offs on failure and returns to the base interval after recovery", async () => {
    vi.useFakeTimers()
    let runs = 0
    let remainingFailures = 2
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: async () => {
        runs += 1
        if (remainingFailures > 0) {
          remainingFailures -= 1
          return false
        }
        return true
      },
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(1000) // run1 fail → 下次 +2000
    await vi.advanceTimersByTimeAsync(1999)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // run2（t=3000）fail → 下次 +4000
    await vi.advanceTimersByTimeAsync(3999)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1) // run3（t=7000）success → 下次 +1000
    await vi.advanceTimersByTimeAsync(999)
    expect(runs).toBe(3)
    await vi.advanceTimersByTimeAsync(1) // run4（t=8000）
    expect(runs).toBe(4)
    poller.stop()
  })

  it("caps the backoff delay and stops cleanly without leaking timer callbacks", async () => {
    vi.useFakeTimers()
    let runs = 0
    const poller = new IdlePoller({
      intervalMs: 1000,
      backoffCapMs: 4000,
      run: async () => ((runs += 1), false),
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(1000) // fail → +2000
    await vi.advanceTimersByTimeAsync(2000) // fail → +4000
    await vi.advanceTimersByTimeAsync(4000) // fail → capped +4000
    expect(runs).toBe(3)
    poller.stop()
    expect(poller.isRunning).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toBe(3)
  })

  it("is idempotent on start and swallows a thrown run callback", async () => {
    vi.useFakeTimers()
    let runs = 0
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: async () => {
        runs += 1
        if (runs === 1) throw new Error("boom")
        return true
      },
    })
    poller.start()
    poller.start() // 重复 start 不应叠加定时器
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(2000) // 抛错按失败退避 → 第二次在 +2000
    expect(runs).toBe(2)
    poller.stop()
  })
})
