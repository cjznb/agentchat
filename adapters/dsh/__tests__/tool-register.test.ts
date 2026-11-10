/**
 * P8：原生工具面**自动注册重试**单测（`lib/tool-register.js` + `lib/native-tools.js` 的 `startAutoRegister`）。
 *
 * 真机问题：插件加载时 Hub 没起来 → `mcp().list()` 抛错 → `registerAll()` 返回 0 → **此后永不重试**，
 * 症状「收得到消息、但工具列表里没有 agentchat、发不出去」，只能重启 DSH。
 *
 * 覆盖（与 task-18 的验收清单一一对应）：
 * ① Hub 不可用 → 首次 0 个 + 定时重试；Hub 恢复 → 最终注册 12 个（并断言退避间隔 5s→10s→…）；
 * ② 首次即成功 → 不产生任何重试（无悬挂 timer；`dispose()` 后不再有注册调用）；
 * ③ `dispose()` → 反注册已注册工具 + 停掉待触发的重试（含"已取消的回调被手动触发"兜底）；
 * ④ `tools` 服务缺失 → 响亮告警含「Hub 可能未启动」与 `--with-mcp-bridge` 补救提示，且继续重试。
 *
 * 时间控制：**注入**定时器/时钟/随机数（`manualTimers()`），不真等 5s/60s，也不用 fake timers
 * （假定时器与插件内的真实 Promise 链混用历史上会互相等待）。不连真实 Hub：hub/service 全是假对象。
 */
import { describe, expect, it } from "vitest"
import { createNativeTools } from "../lib/native-tools.js"
import { RETRY_BASE_MS, RETRY_CAP_MS } from "../lib/tool-register.js"

interface FakeTimer {
  readonly fn: () => void
  readonly delay: number
  cleared: boolean
}

/** 手控定时器：记录每次排队，`fire()` 触发最早一个（不真等）。 */
function manualTimers() {
  const timers: FakeTimer[] = []
  return {
    setTimeout: (fn: () => void, delay: number): unknown => {
      const entry: FakeTimer = { fn, delay, cleared: false }
      timers.push(entry)
      return entry
    },
    clearTimeout: (id: unknown): void => {
      ;(id as FakeTimer).cleared = true
    },
    all: () => timers,
    /** 待触发（未被取消）的定时器。 */
    pending: () => timers.filter((timer) => !timer.cleared),
    /** 触发最早一个待触发定时器，并排空其 Promise 链。 */
    async fire(): Promise<void> {
      const entry = timers.find((timer) => !timer.cleared)
      if (entry === undefined) throw new Error("没有待触发的重试定时器")
      entry.cleared = true
      entry.fn()
      await flush()
    },
  }
}

/** 排空微任务：尝试链全是已落定的 Promise（无真实计时），几十次足够。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
}

/** 12 个假 Hub 工具（形状满足 `toolDefinition`）。 */
const TOOLS_12 = Array.from({ length: 12 }, (_value, index) => ({
  name: `t${index}`,
  inputSchema: { type: "object", properties: {} },
}))

/** 自动注册用例的依赖：`list()` 行为由 `onList` 决定（抛错 / 返回工具）。 */
function setupAuto(onList: () => Promise<unknown[]>, withService = true) {
  const registered: Record<string, unknown>[] = []
  const unregistered: string[] = []
  const logs: string[] = []
  const native = createNativeTools({
    ctx: { get: () => undefined },
    hub: { mcp: () => ({ list: onList, call: async () => "ok" }) },
    sessions: new Map(),
    log: (message) => void logs.push(message),
    ...(withService
      ? {
          service: {
            register(this: unknown, definition: Record<string, unknown>) {
              if (this === undefined) throw new Error("注册表入口丢失 this")
              registered.push(definition)
              return () => void unregistered.push(String(definition["name"]))
            },
          },
        }
      : {}),
  })
  return { native, registered, unregistered, logs }
}

/** 一组确定性的调度注入（`random: 0.5` → 抖动系数 1.0，间隔可与阶梯精确比对）。 */
function deterministic(timers: ReturnType<typeof manualTimers>) {
  return { ...timers, random: () => 0.5, now: () => 0 }
}

describe("原生工具面自动注册（P8）", () => {
  it("Hub 未启动 → 首次注册 0 个并定时重试（5s→10s→…）；Hub 恢复后自动注册 12 个", async () => {
    const timers = manualTimers()
    let hubUp = false
    const { native, registered, logs } = setupAuto(async () => {
      if (!hubUp) throw new Error("connect ECONNREFUSED 127.0.0.1:4646")
      return TOOLS_12
    })
    const retry = native.startAutoRegister(deterministic(timers))

    await flush() // 首次尝试立即发生
    expect(retry?.attempts()).toBe(1)
    expect(retry?.failures()).toBe(1)
    expect(retry?.succeeded()).toBe(false)
    expect(registered).toHaveLength(0) // Hub 不在 = 一个工具都没注册
    expect(retry?.nextDelayMs()).toBe(RETRY_BASE_MS) // 5s
    expect(timers.pending()).toHaveLength(1)

    // 响亮告警：说清「Hub 可能未启动」+ 补救建议 + 下次重试间隔
    const first = logs.join("\n")
    expect(first).toContain("原生工具面自动注册失败")
    expect(first).toContain("Hub 可能未启动")
    expect(first).toContain("--with-mcp-bridge")
    expect(first).toContain("5s 后重试")

    // 第二次仍失败：同原因**不刷屏**（只有首次那一条失败告警），间隔翻倍到 10s
    await timers.fire()
    expect(retry?.attempts()).toBe(2)
    expect(retry?.nextDelayMs()).toBe(RETRY_BASE_MS * 2)
    expect(logs.filter((line) => line.includes("自动注册失败"))).toHaveLength(1)

    // Hub 恢复 → 下一次重试直接成功，注册 12 个并**停止重试**
    hubUp = true
    await timers.fire()
    expect(retry?.attempts()).toBe(3)
    expect(retry?.succeeded()).toBe(true)
    expect(registered).toHaveLength(12)
    expect(native.definitions).toHaveLength(12)
    expect(retry?.nextDelayMs()).toBeUndefined()
    expect(timers.pending()).toHaveLength(0)
    expect(logs.some((line) => line.includes("自动注册成功") && line.includes("12 个工具"))).toBe(true)
    native.dispose()
  })

  it("首次即成功 → 不产生任何重试（无悬挂 timer）；成功后重复调用不叠加、不重复注册", async () => {
    const timers = manualTimers()
    const { native, registered, logs } = setupAuto(async () => TOOLS_12)
    const retry = native.startAutoRegister(deterministic(timers))

    await flush()
    expect(retry?.attempts()).toBe(1)
    expect(retry?.succeeded()).toBe(true)
    expect(registered).toHaveLength(12)
    expect(retry?.running()).toBe(false)
    expect(timers.pending()).toHaveLength(0) // 成功 → 没有排任何重试
    expect(logs.some((line) => line.includes("自动注册失败"))).toBe(false)

    // 幂等：再调一次拿同一句柄，不新增尝试、不重复注册（避免宿主出现两套同名工具）
    expect(native.startAutoRegister(deterministic(timers))).toBe(retry)
    await flush()
    expect(retry?.attempts()).toBe(1)
    expect(registered).toHaveLength(12)

    native.dispose()
    await flush()
    expect(retry?.attempts()).toBe(1) // dispose 后不再有任何注册调用
    expect(timers.pending()).toHaveLength(0)
  })

  it("dispose()：反注册已注册工具 + 停掉待触发的重试（已取消的回调被触发也不再生效）", async () => {
    // ① 成功态：全部反注册
    const ok = setupAuto(async () => TOOLS_12)
    const okRetry = ok.native.startAutoRegister(deterministic(manualTimers()))
    await flush()
    expect(ok.registered).toHaveLength(12)
    ok.native.dispose()
    expect(ok.unregistered).toHaveLength(12)
    expect(ok.native.definitions).toHaveLength(0)
    expect(okRetry?.running()).toBe(false)

    // ② 失败态：待触发的重试被取消，且**即便**有人手动触发那个已取消的回调也不再注册
    const timers = manualTimers()
    let calls = 0
    const bad = setupAuto(async () => {
      calls += 1
      throw new Error("connect ECONNREFUSED")
    })
    const badRetry = bad.native.startAutoRegister(deterministic(timers))
    await flush()
    expect(calls).toBe(1)
    expect(timers.pending()).toHaveLength(1)

    bad.native.dispose()
    expect(badRetry?.running()).toBe(false)
    expect(timers.pending()).toHaveLength(0) // 定时器已被 clearTimeout

    const stale = timers.all()[0]
    stale?.fn() // 兜底：stopped 之后回调不得再发起尝试
    await flush()
    expect(calls).toBe(1)
    expect(badRetry?.attempts()).toBe(1)
  })

  it("tools 服务缺失 → 响亮告警含「Hub 可能未启动」与 --with-mcp-bridge，且仍在重试", async () => {
    const timers = manualTimers()
    const { native, logs } = setupAuto(async () => TOOLS_12, false) // 无 service 且 ctx 也取不到
    const retry = native.startAutoRegister(deterministic(timers))

    await flush()
    expect(retry?.attempts()).toBe(1)
    expect(retry?.failures()).toBe(1)
    expect(timers.pending()).toHaveLength(1) // 宿主可能升级 DSH 后才出现 tools 服务 → 继续试

    const text = logs.join("\n")
    expect(text).toContain("宿主没有 tools 服务") // registerAll 的原始诊断（首次失败会被 flush）
    expect(text).toContain("Hub 可能未启动")
    expect(text).toContain("--with-mcp-bridge")

    native.dispose()
    expect(timers.pending()).toHaveLength(0)
  })

  it("退避阶梯带抖动：同原因每 5 次尝试 / 每 5 分钟才记一条（不刷屏）", async () => {
    const timers = manualTimers()
    let clock = 0
    const { native, logs } = setupAuto(async () => {
      throw new Error("connect ECONNREFUSED")
    })
    const retry = native.startAutoRegister({
      ...timers,
      random: () => 1, // 抖动上界：间隔 = 1.1 × 原始值
      now: () => clock,
    })
    await flush()
    const ladder: number[] = [Math.round(RETRY_BASE_MS * 1.1)]
    for (let index = 0; index < 5; index += 1) {
      clock += 1000
      await timers.fire()
      const delay = retry?.nextDelayMs()
      if (delay !== undefined) ladder.push(delay)
    }
    // 5s,10s,20s,40s,60s（封顶）× 1.1，且不超过 capMs×1.1
    expect(ladder).toEqual([
      Math.round(5000 * 1.1),
      Math.round(10000 * 1.1),
      Math.round(20000 * 1.1),
      Math.round(40000 * 1.1),
      Math.round(RETRY_CAP_MS * 1.1),
      Math.round(RETRY_CAP_MS * 1.1),
    ])
    // 第 6 次尝试时「尝试数-上次记录」= 5 → 才允许第二条失败日志（首次 1 条 + 这条）
    expect(retry?.attempts()).toBe(6)
    expect(logs.filter((line) => line.includes("自动注册失败"))).toHaveLength(2)
    native.dispose()
  })
})
