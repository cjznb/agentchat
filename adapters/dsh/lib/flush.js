/**
 * 空闲/忙时拉取闭环（与 `adapters/opencode/flush.ts` 同一闭环，但**与宿主解耦**）：
 * 上报心跳（`idle` / `busy`）→ `POST /internal/wake` 认领积压 → 经 `deliver` 注入宿主 →
 * `POST /internal/result` 回执。
 *
 * 唯一宿主相关操作是注入函数 `deliver(nodeId, texts)`（返回 `"delivered"` / `"refused"`），
 * 由调用方提供；本模块因此可用于任何宿主（DSH 插件、桥、hook）。
 *
 * ## 心跳状态（`options.state`）
 * 心跳**必须携带会话的真实忙闲**：忙时发 `idle` 会把 Hub 上的 `busy` 反翻成 `online`
 * （状态回退、roster 显示错误、回执语义漂移）。忙时取件的调用方须传 `state: "busy"`。
 *
 * ## 只心跳、不认领（`options.claim === false`）
 * 忙时注入配额用尽等场景下，调用方可以只要心跳：本轮**不** `wake`。这保证绝不出现
 * 「认领了却投不出去」——那要么留下未回执的在途租约（消息延迟到租约过期才重投），
 * 要么把消息误报成 `refused` 并累计成 Hub 侧终态。
 *
 * ## 去重（闭环的**唯一权威**）
 * `seen` 有界去重集记录**已成功注入**的 messageId：
 * - Hub 的 `sending` 在途租约到期重投时，已注入的消息**绝不重复注入**，只幂等补回执；
 * - 同一轮里混合新旧消息时，**只注入新消息**的文本（旧消息仍补回执）；
 * - `refused` **不写入 `seen`**（注入被拒 = 尚未注入，下次仍须尝试），与 OpenCode 一致。
 *
 * ## 纪律
 * 返回 `true` = 本轮 Hub 往返成功（供轮询器复位退避）；`false` = 本轮失败（拉长退避）。
 * `heartbeat` 失败只记日志、**不中断本轮**；wake/回执失败记日志后返回 `false`；
 * `deliver` 抛错按 `refused` 计（逐条回执）。本函数**绝不抛错**。
 */
import { describe } from "./util.js"

/**
 * 把认领到的消息渲染为注入文本：
 * 头部 + 三条沟通规则（R1 = agent 对 agent 只回一次 / R2 = 不对人类复述工具输出）
 * + 每条 `- [id] 来自 <fromAgentId>（会话 <conversationId>）：<body>` + 回复指引；空白正文条目被丢弃。
 *
 * **前缀是外部契约**：`- [<id>] 来自 <from>` 必须保持原样（测试适配器 `host.mjs:injectedIds`
 * 与矩阵 `assertInjectionPrefix` 用它解析 messageId）；会话 id 只能**追加在其后**的括号里。
 * `conversationId` 缺失（旧 Hub / 非会话消息）时省略括号，不影响前缀。
 *
 * @param {ReadonlyArray<{id: string, fromAgentId: string, body: string, conversationId?: string}>} messages
 * @returns {string} 注入文本（正文全空白时只剩头部、规则与指引）
 */
export function formatMessages(messages) {
  const lines = messages
    .filter((message) => message.body.trim() !== "")
    .map((message) => {
      const session =
        typeof message.conversationId === "string" && message.conversationId !== ""
          ? `（会话 ${message.conversationId}）`
          : ""
      return `- [${message.id}] 来自 ${message.fromAgentId}${session}：${message.body}`
    })
  return [
    "[AgentChat] 你收到了以下来自其他 agent 的消息，请据此继续工作：",
    "沟通规则：消息须有信息增量；禁纯回执/寒暄与复读循环；确认请并入下一步（详见 README「沟通规范」）。",
    "沟通规则：交流双方均为 agent 时，回复结果只写入 reply 一次，不要既 reply 又向会话重发一遍同样内容——没有观众。",
    "沟通规则：agent 回复人类时工具输出已可见，回话后不要再把工具结果复述一遍。",
    ...lines,
    "要回复就用 send 工具：私聊发给发送者 id，群消息发给会话（群）id —— 每条消息的会话标注里已给出。",
  ].join("\n")
}

/**
 * 构造 `flush(nodeId, agentId, options)`。
 *
 * @param {{
 *   hub: {wake(agentId: string): Promise<ReadonlyArray<{id: string, fromAgentId: string, body: string}>>,
 *     reportResult(agentId: string, items: ReadonlyArray<{messageId: string, result: string}>): Promise<void>},
 *   deliver: (nodeId: string, texts: readonly string[]) => Promise<"delivered" | "refused">,
 *   seen: {has(id: string): boolean, add(id: string): void},
 *   heartbeat: (agentId: string, state: "idle" | "busy") => Promise<void>,
 *   log: (message: string) => void,
 * }} deps
 * @returns {(nodeId: string, agentId: string,
 *   options?: {state?: "idle" | "busy", claim?: boolean}) => Promise<boolean>}
 *   `options.state` 缺省 `"idle"`；`options.claim === false` = 本轮只心跳、不认领。
 */
export function createIdleFlush(deps) {
  return async (nodeId, agentId, options) => {
    const state = options?.state ?? "idle"
    try {
      await deps.heartbeat(agentId, state)
    } catch (error) {
      deps.log(`${state} heartbeat failed: ${describe(error)}`)
    }
    // 只心跳不认领：配额用尽的忙回合绝不能 wake（否则认领了却没注入，只能等租约过期重投）。
    if (options?.claim === false) return true
    let messages
    try {
      messages = await deps.hub.wake(agentId)
    } catch (error) {
      deps.log(`wake failed: ${describe(error)}`)
      return false
    }
    if (messages.length === 0) return true

    const fresh = messages.filter((message) => !deps.seen.has(message.id))
    /** 租约重投的重复消息：已注入过，绝不重复注入，仅补回执（幂等）。 */
    const receipts = messages
      .filter((message) => deps.seen.has(message.id))
      .map((message) => ({ messageId: message.id, result: "delivered" }))

    if (fresh.length === 0) return report(deps, agentId, receipts)

    let outcome = "refused"
    let deliveredIds = []
    try {
      const texts = [formatMessages(fresh)]
      const result = await deps.deliver(nodeId, texts)
      if (result === "delivered") {
        outcome = "delivered"
        deliveredIds = fresh.map((message) => message.id)
      } else {
        deps.log(`inject refused for ${fresh.map((message) => message.id).join(",")}`)
      }
    } catch (error) {
      deps.log(`inject failed for ${fresh.map((message) => message.id).join(",")}: ${describe(error)}`)
    }
    for (const id of deliveredIds) deps.seen.add(id)
    return report(deps, agentId, [
      ...receipts,
      ...fresh.map((message) => ({ messageId: message.id, result: outcome })),
    ])
  }
}

/** 上报回执；成功 `true`、失败记日志并 `false`（供轮询器退避）。**绝不抛错**。 */
async function report(deps, agentId, items) {
  try {
    await deps.hub.reportResult(agentId, items)
    return true
  } catch (error) {
    deps.log(`result report failed: ${describe(error)}`)
    return false
  }
}
