/**
 * 未注册会话的**补注册重试**定时器。
 *
 * 为什么需要（真机事故）：插件只在 ①加载期回填、②`agent/created`、③`agent/status` 三个时机尝试注册。
 * 若 Hub 恰好在加载那一刻不可达、或插件挂监听之前会话就已创建（`ctx.agents.list()` 在启动瞬间为空且
 * `agent/created` 已错过），该会话会一直不可见，直到**下一次回合边界**才被收养——期间它在 Hub 里没有
 * 节点、消息无处投递。本定时器把"补注册"从"等宿主事件"改成"自己的节奏"：
 *
 * - 每轮**重新枚举** `ctx.agents.list()`（`enumerateAgents`）并并入 `known`——启动瞬间漏掉的会话
 *   也会在下一轮被发现，不依赖任何宿主事件；
 * - 对 `known` 中尚未注册（`!sessions.has`）的 agent 调 `ensure`；
 * - 复用 `IdlePoller`：无重叠执行、失败指数退避（上限 60s）、成功即回基础间隔、定时器 `unref()`。
 *
 * `known` 由调用方维护；本模块**绝不抛错**。
 *
 * @param {{intervalMs: number, ctx: {get?: (name: string) => unknown},
 *   known: Map<string, unknown>, sessions: Map<string, unknown>,
 *   ensure: (agent: unknown) => Promise<unknown>, log: (message: string) => void, limit?: number}} options
 * @returns {() => void} `stop()`（**构造即启动**：调用方只需在卸载时停）
 */
import { enumerateAgents } from "./backfill.js"
import { IdlePoller } from "./poll.js"

export function createRegistrationRetry(options) {
  const limit = options.limit ?? 256

  /** 重新枚举并入 `known`（有界 FIFO），返回尚未注册的 agent。 */
  function pendingAgents() {
    for (const agent of enumerateAgents(options.ctx)) {
      const sessionId = agent?.session?.header?.id
      if (typeof sessionId !== "string" || sessionId === "") continue
      options.known.delete(sessionId)
      options.known.set(sessionId, agent)
    }
    if (options.known.size > limit) {
      const oldest = options.known.keys().next().value
      if (oldest !== undefined) options.known.delete(oldest)
    }
    const missing = []
    for (const [sessionId, agent] of options.known) {
      if (!options.sessions.has(sessionId)) missing.push(agent)
    }
    return missing
  }

  const poller = new IdlePoller({
    intervalMs: options.intervalMs,
    run: async () => {
      const agents = pendingAgents()
      if (agents.length === 0) return true
      let allDone = true
      for (const agent of agents) {
        const entry = await options.ensure(agent)
        if (entry === undefined) allDone = false
      }
      if (!allDone) options.log(`仍有 ${agents.length} 个会话未注册，稍后重试`)
      return allDone
    },
  })
  poller.start()
  return () => poller.stop()
}
