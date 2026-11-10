/**
 * 群操作**唯一实现**（批次2修复 F2 抽出；`/api/test/*` 复用）——
 * `routes/groups.ts`（生产端点）与 `routes/test.ts`（测试端点）共用本层，
 * 守卫序、错误码、通知文案、幂等键**逐字一致**：两份实现会在无回归网处漂移，
 * 故行为只在这里定义一次。
 *
 * 本层只做业务判定与落库编排，**不抛 HTTP**：返回 `{ok:false,error}` 判别联合，
 * 由路由层映射既有状态码（conversation_not_found→404、not_group→400、
 * not_in_group→404、cannot_remove_last_member→409）。
 *
 * 两个操作都会写 `kind=system` 通知后再落库删除（0 wake；`postSystem` 直写 + publish）。
 */
import type { Db } from "../db"
import { agentDisplayName, getAgent } from "../store/agents"
import {
  deleteConversationCascade,
  getConversation,
  isParticipant,
  listParticipants,
  removeParticipant,
} from "../store/conversations"
import { ensureHuman, postSystem } from "./permissions"

export type GroupOpError =
  | "conversation_not_found"
  | "not_group"
  | "not_in_group"
  | "cannot_remove_last_member"

/**
 * 移除群成员（`POST /api/groups/:id/members/remove` 与测试端点共用）。
 *
 * 守卫序与旧 `routes/groups.ts` 逐字一致：会话不存在 → `conversation_not_found`；
 * 非群会话 → `not_group`；目标不在群 → `not_in_group`；删到仅剩 1 人 → `cannot_remove_last_member`。
 * 通过后删 participants 行 → 余下成员 system 通知（沿 joinNotice 同款：kind=system、
 * postSystem 直写+publish、0 wake、meta `{action:"group_remove", agentId}`、幂等键
 * `group-remove:<cid>:<aid>`）。`actorId` 缺省 = human（UI/test 同款缺省执行主体）。
 */
export function removeGroupMember(
  db: Db,
  input: { readonly conversationId: string; readonly agentId: string; readonly actorId?: string },
): { readonly ok: true } | { readonly ok: false; readonly error: GroupOpError } {
  const conversation = getConversation(db, input.conversationId)
  if (conversation === undefined) return { ok: false, error: "conversation_not_found" }
  if (conversation.kind !== "group") return { ok: false, error: "not_group" }
  if (!isParticipant(db, conversation.id, input.agentId)) {
    return { ok: false, error: "not_in_group" }
  }
  if (listParticipants(db, conversation.id).length <= 1) {
    return { ok: false, error: "cannot_remove_last_member" }
  }
  const target = getAgent(db, input.agentId)
  removeParticipant(db, conversation.id, input.agentId)
  // 移出通知沿入群通知（joinNotice）同款：kind=system、postSystem 直写+publish、0 wake。
  const roster = listParticipants(db, conversation.id).flatMap((participant) => {
    const agent = getAgent(db, participant.agentId)
    return agent === undefined ? [] : [`${agentDisplayName(agent)}(${agent.id.slice(0, 8)})`]
  })
  postSystem(db, {
    conversationId: conversation.id,
    fromAgentId: input.actorId ?? ensureHuman(db).id,
    body: `「${target === undefined ? input.agentId : agentDisplayName(target)}」已移出群「${conversation.name ?? conversation.key}」。成员：${roster.join("、")}`,
    meta: { action: "group_remove", agentId: input.agentId },
    idempotencyKey: `group-remove:${conversation.id}:${input.agentId}`,
  })
  return { ok: true }
}

/**
 * 解散群（`POST /api/groups/:id/dissolve` 与测试端点共用）。
 *
 * 守卫：会话不存在 → `conversation_not_found`；非群会话 → `not_group`。
 * 通过后**先**广播「群已解散」system 条目（meta `{action:"group_dissolve", agentId:cid}`、
 * 幂等键 `group-dissolve:<cid>`），再按外键现实级联删除（`deleteConversationCascade`，
 * 事务原子）。`actorId` 缺省 = human。
 */
export function dissolveGroup(
  db: Db,
  input: { readonly conversationId: string; readonly actorId?: string },
): {
  readonly ok: true
} | { readonly ok: false; readonly error: "conversation_not_found" | "not_group" } {
  const conversation = getConversation(db, input.conversationId)
  if (conversation === undefined) return { ok: false, error: "conversation_not_found" }
  if (conversation.kind !== "group") return { ok: false, error: "not_group" }
  postSystem(db, {
    conversationId: conversation.id,
    fromAgentId: input.actorId ?? ensureHuman(db).id,
    body: `群「${conversation.name ?? conversation.key}」已解散。`,
    meta: { action: "group_dissolve", agentId: conversation.id },
    idempotencyKey: `group-dissolve:${conversation.id}`,
  })
  deleteConversationCascade(db, conversation.id)
  return { ok: true }
}
