/**
 * idle 拉取闭环（与 `adapters/opencode/flush.ts` 同一闭环，但**与宿主解耦**）：
 * 上报 idle 心跳 → `POST /internal/wake` 认领积压 → 经 `deliver` 注入宿主 → `POST /internal/result` 回执。
 *
 * 唯一宿主相关操作是注入函数 `deliver(nodeId, texts)`（返回 `"delivered"` / `"refused"`），
 * 由调用方提供；本模块因此可用于任何宿主（DSH 插件、桥、hook）。
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
 * 把认领到的消息渲染为注入文本（措辞与 `adapters/claude-code/common.mjs:formatMessages` 一致）：
 * 头部 + 沟通规则行 + 每条 `- [id] 来自 <fromAgentId>：<body>`；空白正文条目被丢弃。
 *
 * @param {ReadonlyArray<{id: string, fromAgentId: string, body: string}>} messages
 * @returns {string} 注入文本（正文全空白时只剩头部与规则行）
 */
export function formatMessages(messages) {
  const lines = messages
    .filter((message) => message.body.trim() !== "")
    .map((message) => `- [${message.id}] 来自 ${message.fromAgentId}：${message.body}`)
  return [
    "[AgentChat] 你收到了以下来自其他 agent 的消息，请据此继续工作：",
    "沟通规则：消息须有信息增量；禁纯回执/寒暄与复读循环；确认请并入下一步（详见 README「沟通规范」）。",
    ...lines,
  ].join("\n")
}

/**
 * 构造 `flush(nodeId, agentId)`。
 *
 * @param {{
 *   hub: {wake(agentId: string): Promise<ReadonlyArray<{id: string, fromAgentId: string, body: string}>>,
 *     reportResult(agentId: string, items: ReadonlyArray<{messageId: string, result: string}>): Promise<void>},
 *   deliver: (nodeId: string, texts: readonly string[]) => Promise<"delivered" | "refused">,
 *   seen: {has(id: string): boolean, add(id: string): void},
 *   heartbeat: (agentId: string) => Promise<void>,
 *   log: (message: string) => void,
 * }} deps
 * @returns {(nodeId: string, agentId: string) => Promise<boolean>}
 */
export function createIdleFlush(deps) {
  return async (nodeId, agentId) => {
    try {
      await deps.heartbeat(agentId)
    } catch (error) {
      deps.log(`idle heartbeat failed: ${describe(error)}`)
    }
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
