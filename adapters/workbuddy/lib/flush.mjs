/**
 * 取件闭环（指南 §4.4 的**唯一正确顺序**）：
 *
 * ```
 * 心跳(会话节点 + 实例节点, always) → wake 认领 → 按 messageId 过滤已注入
 *   ├─ 全是重复 → 只补 result(delivered)
 *   └─ 有新消息 → 注入(格式化成一条文本) → 成功记入去重集合 → result(delivered)
 *                  注入失败/被拒 → result(refused)，**不写去重集合**
 * ```
 *
 * 铁律：
 * - `wake` 是**在途租约**（约 30s）：未回执会重投，故必须按 `messageId` **有界去重**；
 * - `result: refused` ＝ **尚未投递**（计入 Hub 拒绝预算）→ **不得**写入去重集合，否则永久丢失；
 * - `idle` 在 Hub 侧映射为 `online` 且**同态上报等价心跳触碰** → 空闲轮询每轮都要上报；
 * - **搭车心跳**：上报会话状态时同时触碰实例容器，否则长回合/长期空闲会让容器先被判 offline；
 * - 任何失败只记日志，绝不抛给宿主。
 */
import { reportResult, reportState, wake } from "./hub.mjs"
import { readJson, writeJson } from "./token.mjs"
import { errorMessage, isRecord } from "./util.mjs"

/** 已注入 `messageId` 去重集合的**有界**上限（FIFO 淘汰最旧）。 */
export const SEEN_LIMIT = 200

/** 读取去重集合（文件缺失/损坏 → 空）；供租约重投时不重复注入。 */
export function loadSeen(paths) {
  const state = readJson(paths.seen)
  const ids = state !== undefined && Array.isArray(state["ids"]) ? state["ids"] : []
  return new Set(ids.filter((id) => typeof id === "string"))
}

/** 记住已注入的 messageId，保持有界（防无界内存/文件增长）。 */
export function rememberSeen(paths, ids) {
  if (ids.length === 0) return
  const seen = loadSeen(paths)
  for (const id of ids) seen.add(id)
  writeJson(paths.seen, { ids: [...seen].slice(-SEEN_LIMIT), at: Date.now() })
}

/** 把认领到的消息格式化为注入上下文（稳定前缀 `[AgentChat]` + 携带 `messageId` 便于对账）。 */
export function formatMessages(messages) {
  const lines = messages.map((m) => `- [${m.id}] 来自 ${m.fromAgentId}：${m.body}`)
  return [
    "[AgentChat] 你收到了以下来自其他 agent 的消息，请据此继续工作：",
    "沟通规则：消息须有信息增量；禁纯回执/寒暄与复读循环；确认请并入下一步（详见 README「沟通规范」）。",
    "沟通规则：交流双方均为 agent 时，回复结果只写入 reply 一次，不要既 reply 又向会话重发一遍同样内容——没有观众。",
    "沟通规则：agent 回复人类时工具输出已可见，回话后不要再把工具结果复述一遍。",
    "回复请用 AgentChat MCP 工具（send / ask / group 等）；本消息即为你的输入，无需等待用户。",
    ...lines,
  ].join("\n")
}

/** 把消息转成 `/internal/result` 的投递回执项。 */
export function deliveredItems(messages) {
  return messages.map((m) => ({ messageId: m.id, result: "delivered" }))
}

/** 把消息转成 `refused` 回执项（**尚未投递**；不计入去重集合）。 */
export function refusedItems(messages) {
  return messages.map((m) => ({ messageId: m.id, result: "refused" }))
}

/** 回执上报：失败只记日志。「绝不因回执失败而中断注入流程」纪律的单一落点。 */
export async function reportResultSafe(config, agentId, items, log) {
  try {
    await reportResult(config, agentId, items)
  } catch (error) {
    log(`result report failed: ${errorMessage(error)}`)
  }
}

/**
 * 心跳：会话节点上报 `state`，并**搭车**触碰实例容器（`idle`）。
 * 容器触碰失败只记日志（不影响会话节点的投递）。
 */
export async function heartbeat(config, sessionAgentId, containerId, state, log) {
  if (containerId !== undefined && containerId !== sessionAgentId) {
    try {
      await reportState(config, containerId, "idle")
    } catch (error) {
      log(`container heartbeat failed: ${errorMessage(error)}`)
    }
  }
  await reportState(config, sessionAgentId, state)
}

/**
 * 执行一次取件闭环。`deliver(messages) -> boolean` 由宿主侧注入：
 * 返回 `true` 表示「注入载荷已经产出」（Stop 的决策 JSON / SessionStart 的 additionalContext）；
 * `false` 表示本环境无注入通道（如仅上报状态的事件），此时**不得**报 `delivered`。
 *
 * 返回 `{ fresh, dup, text }`：`fresh` = 本次真正需要注入的**新**消息（已按 `deliver` 结果处理）。
 */
export async function flush(options) {
  const { config, paths, agentId, containerId, state = "idle", deliver, log } = options
  try {
    await heartbeat(config, agentId, containerId, state, log)
  } catch (error) {
    log(`heartbeat failed: ${errorMessage(error)}`)
    return { fresh: [], dup: [], text: undefined }
  }

  let messages
  try {
    messages = await wake(config, agentId)
  } catch (error) {
    log(`wake failed: ${errorMessage(error)}`)
    return { fresh: [], dup: [], text: undefined }
  }
  if (messages.length === 0) return { fresh: [], dup: [], text: undefined }

  const seen = loadSeen(paths)
  const fresh = messages.filter((m) => !seen.has(m.id))
  const dup = messages.filter((m) => seen.has(m.id))

  // 仅租约重投的重复消息：绝不重复注入，仅补回执。
  if (fresh.length === 0) {
    await reportResultSafe(config, agentId, deliveredItems(dup), log)
    return { fresh: [], dup, text: undefined }
  }

  const text = formatMessages(fresh)
  let ok = false
  try {
    ok = deliver(fresh, text) !== false
  } catch (error) {
    log(`deliver failed: ${errorMessage(error)}`)
    ok = false
  }
  if (!ok) {
    // 注入失败/被拒 → refused，**不写去重集合**（指南 §1.2：refused ＝ 尚未投递）。
    await reportResultSafe(config, agentId, refusedItems(fresh), log)
    return { fresh: [], dup, text: undefined }
  }
  rememberSeen(
    paths,
    fresh.map((m) => m.id),
  )
  await reportResultSafe(config, agentId, [...deliveredItems(fresh), ...deliveredItems(dup)], log)
  return { fresh, dup, text }
}

export { isRecord }
