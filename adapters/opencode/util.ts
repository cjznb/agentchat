/**
 * 适配器内部小工具：类型守卫 + 串行任务队列。
 *
 * 队列为单消费者、保序、错误自吞——插件的 `event` 钩子只入队即返回（fire-and-forget），
 * 网络重试等耗时工作在后台串行推进，**不阻塞宿主事件循环**；`flush()` 供测试等待排空。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 有界去重集合（FIFO 淘汰最旧）。用于按 messageId 去重「在途租约重投」的消息。 */
export interface BoundedSet {
  has(id: string): boolean
  add(id: string): void
}

export function createBoundedSet(limit: number): BoundedSet {
  const ids = new Map<string, true>()
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return
      ids.set(id, true)
      if (ids.size > limit) {
        const oldest = ids.keys().next().value
        if (oldest !== undefined) ids.delete(oldest)
      }
    },
  }
}

/** 把认领到的消息格式化为 OpenCode 注入文本。 */
export function formatInjection(message: {
  readonly id: string
  readonly fromAgentId: string
  readonly conversationId: string
  readonly body: string
}): string {
  return [
    `[AgentChat] 来自 ${message.fromAgentId} 的消息（会话 ${message.conversationId}，消息 id ${message.id}）`,
    message.body,
    `（如需回复，请用 AgentChat 的 send 工具发给 ${message.fromAgentId}）`,
  ].join("\n")
}

export interface TaskQueue {
  /** 入队一个任务；立即返回，执行结果（含错误）不影响调用方。 */
  push(task: () => Promise<void>): void
  /** 等待当前与等待期间新入队的任务全部完成。 */
  flush(): Promise<void>
}

export function createTaskQueue(): TaskQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    push(task) {
      tail = tail.then(task).catch(() => undefined)
    },
    async flush() {
      let previous: Promise<void>
      do {
        previous = tail
        await previous
      } while (previous !== tail)
    },
  }
}
