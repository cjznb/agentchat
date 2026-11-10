/**
 * 可编程注入器（`adapters/test/lib/inject.mjs`）—— 无头假宿主里**唯一**被替换掉的一步。
 *
 * 真宿主把消息塞进 agent 回合（DSH 的 `followup`/`steer`）；测试里换成"录音 + 可编程结果"，
 * 于是 `flush` 闭环（认领、seen 去重、租约重投、回执）全部仍走 `flush.js` 真实现。
 * 自 `host.mjs` 拆出：本仓红线「单文件 ≤ 250 纯行」，且"注入剧本"本身就是一个内聚单元。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 建注入器。**每次调用都录音**（含被拒/抛错那次），`outcome` 记本次结果：
 * `"delivered"` / `"refused"` / `"throw"`（注入函数抛错 → `flush` 按 refused 计）。
 *
 * @param {{now?: () => number}} [options] `now` 只用于录音的 `at` 时间戳
 * @returns {{
 *   deliver: ((nodeId: string, texts: readonly string[]) => Promise<"delivered" | "refused">) & {
 *     recordOnly: () => unknown,
 *     setOutcome: (value: "delivered" | "refused") => unknown,
 *     refuseNext: (n?: number) => unknown,
 *     failNext: (n?: number, error?: unknown) => unknown,
 *     setDelay: (ms: number) => unknown,
 *     suppressReceiptNext: (n?: number) => unknown,
 *   },
 *   deliveries: {nodeId: string, texts: string[], at: number, outcome: string}[],
 *   state: {outcome: string, refuseLeft: number, failLeft: number, failError: unknown,
 *     delayMs: number, suppressLeft: number, onInject: unknown},
 * }}
 */
export function createProgrammableDeliver(options = {}) {
  const clock = options.now ?? Date.now
  const deliveries = []
  const state = {
    outcome: "delivered",
    refuseLeft: 0,
    failLeft: 0,
    failError: undefined,
    delayMs: 0,
    /** 模拟"注入成功但崩溃未回报执"：接下来 n 次结果上报失败（见 `host.mjs` 的 flushHub）。 */
    suppressLeft: 0,
    /** `(nodeId, texts) => …` 自定义钩子（断言/额外记录）。 */
    onInject: undefined,
  }

  async function deliver(nodeId, texts) {
    const at = clock()
    if (state.delayMs > 0) await sleep(state.delayMs)
    let outcome = state.outcome
    let thrown
    if (state.failLeft > 0) {
      state.failLeft -= 1
      thrown = state.failError ?? new Error("simulated inject failure")
    } else if (state.refuseLeft > 0) {
      state.refuseLeft -= 1
      outcome = "refused"
    }
    deliveries.push({ nodeId, texts: [...texts], at, outcome: thrown === undefined ? outcome : "throw" })
    if (state.onInject !== undefined) await state.onInject(nodeId, texts)
    if (thrown !== undefined) throw thrown
    return outcome
  }

  /** 复位为缺省剧本：始终 `"delivered"`，只录音。 */
  deliver.recordOnly = () => {
    state.outcome = "delivered"
    state.refuseLeft = 0
    state.failLeft = 0
    state.failError = undefined
    state.suppressLeft = 0
    return deliver
  }
  /** 常驻结果（后续每次注入都返回该值；`refuseNext` 优先于它）。 */
  deliver.setOutcome = (value) => {
    if (value !== "delivered" && value !== "refused") throw new Error(`deliver.setOutcome: ${value}`)
    state.outcome = value
    return deliver
  }
  /** 接下来 n 次注入返回 `"refused"`（`flush` 不写 seen → 下次仍会重投）。 */
  deliver.refuseNext = (n = 1) => {
    state.refuseLeft += n
    return deliver
  }
  /** 接下来 n 次注入抛错（`flush` 按 refused 计）。 */
  deliver.failNext = (n = 1, error) => {
    state.failLeft += n
    state.failError = error ?? new Error("simulated inject failure")
    return deliver
  }
  /** 注入前延迟（模拟宿主慢；`flush` 的异步性由此可测）。 */
  deliver.setDelay = (ms) => {
    state.delayMs = ms
    return deliver
  }
  /** 注入成功但"崩在回报执之前"：接下来 n 次结果上报失败（job 停在 `sending` 租约）。 */
  deliver.suppressReceiptNext = (n = 1) => {
    state.suppressLeft += n
    return deliver
  }

  return { deliver, deliveries, state }
}
