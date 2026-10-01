/**
 * 群路由（批次2修复 C1：自 `routes/ui.ts` 拆出，守卫链/错误码/载荷零变化）——
 * - `GET/POST /api/groups`：群列表 / 建群（human 走既有 gate → 即时执行零审批）
 * - `POST /api/groups/:id/members`：拉人过闸（入群 system 通知在 core/messaging）
 * - `POST /api/groups/:id/members/remove`：F2 移除成员。守卫序：非法 body 400 →
 *   会话不存在 404 → 非群会话 400 → 目标不在群 404 → 删到仅剩 1 人 409（稳定码）；
 *   成功删 participants 行 → 余下成员 system 通知（沿 joinNotice 同款：kind=system、
 *   postSystem 直写+publish、0 wake，meta `{action:"group_remove"}`）→ `{ok:true}`
 * - `POST /api/groups/:id/dissolve`：F2 解散。先广播「群已解散」system 条目（复用既有
 *   message 封套、0 wake，meta `{action:"group_dissolve"}`），再按外键现实级联删除
 *   （wake_jobs→messages→read_states→participants→conversations，事务原子）
 *
 * 人类 UI 专属：不新增 MCP 工具、不新增 WS 事件（两端点均为 message 封套通知）。
 */
import { Hono } from "hono"
import { z } from "zod"
import {
  addParticipant as gatedAddParticipant,
  createGroup as gatedCreateGroup,
} from "../core/messaging"
import { ensureHuman, postSystem } from "../core/permissions"
import { groupList } from "../core/ui-queries"
import type { Db } from "../db"
import { agentDisplayName, getAgent } from "../store/agents"
import {
  deleteConversationCascade,
  getConversation,
  isParticipant,
  listParticipants,
  removeParticipant,
} from "../store/conversations"

const groupBodySchema = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string()).optional(),
})
const memberBodySchema = z.object({ agentId: z.string().min(1) })

/**
 * 挂载群路由（由 ui 路以 `.route("/", groupRoutes(db, resolveDb))` 接线）：
 * `db` 捕获注册时上下文（可为 undefined），`resolveDb` 保持生产缺省惰性单例语义。
 */
export function groupRoutes(db: Db | undefined, resolveDb: (db: Db | undefined) => Db): Hono {
  return new Hono()
    .get("/api/groups", (c) => c.json({ groups: groupList(resolveDb(db)) }))
    .post("/api/groups", async (c) => {
      const database = resolveDb(db)
      const parsed = groupBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const outcome = gatedCreateGroup(database, {
        name: parsed.data.name,
        createdBy: ensureHuman(database).id,
        ...(parsed.data.memberIds === undefined ? {} : { memberIds: parsed.data.memberIds }),
      })
      return "approved" in outcome
        ? c.json({ ok: true, group: outcome.approved })
        : c.json({ ok: true, approval: outcome.approval })
    })
    .post("/api/groups/:id/members", async (c) => {
      const database = resolveDb(db)
      const parsed = memberBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const outcome = gatedAddParticipant(database, {
        conversationId: c.req.param("id"),
        agentId: parsed.data.agentId,
        invitedBy: ensureHuman(database).id,
      })
      return "approved" in outcome
        ? c.json({ ok: true })
        : c.json({ ok: true, approval: outcome.approval })
    })
    .post("/api/groups/:id/members/remove", async (c) => {
      const database = resolveDb(db)
      const parsed = memberBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const conversation = getConversation(database, c.req.param("id"))
      if (conversation === undefined) {
        return c.json({ ok: false, error: "conversation_not_found" }, 404)
      }
      if (conversation.kind !== "group") return c.json({ ok: false, error: "not_group" }, 400)
      const targetId = parsed.data.agentId
      if (!isParticipant(database, conversation.id, targetId)) {
        return c.json({ ok: false, error: "not_in_group" }, 404)
      }
      if (listParticipants(database, conversation.id).length <= 1) {
        return c.json({ ok: false, error: "cannot_remove_last_member" }, 409)
      }
      const target = getAgent(database, targetId)
      removeParticipant(database, conversation.id, targetId)
      // 移出通知沿入群通知（joinNotice）同款：kind=system、postSystem 直写+publish、0 wake。
      const roster = listParticipants(database, conversation.id).flatMap((participant) => {
        const agent = getAgent(database, participant.agentId)
        return agent === undefined ? [] : [`${agentDisplayName(agent)}(${agent.id.slice(0, 8)})`]
      })
      postSystem(database, {
        conversationId: conversation.id,
        fromAgentId: ensureHuman(database).id,
        body: `「${target === undefined ? targetId : agentDisplayName(target)}」已移出群「${conversation.name ?? conversation.key}」。成员：${roster.join("、")}`,
        meta: { action: "group_remove", agentId: targetId },
        idempotencyKey: `group-remove:${conversation.id}:${targetId}`,
      })
      return c.json({ ok: true })
    })
    .post("/api/groups/:id/dissolve", (c) => {
      const database = resolveDb(db)
      const conversation = getConversation(database, c.req.param("id"))
      if (conversation === undefined) {
        return c.json({ ok: false, error: "conversation_not_found" }, 404)
      }
      if (conversation.kind !== "group") return c.json({ ok: false, error: "not_group" }, 400)
      postSystem(database, {
        conversationId: conversation.id,
        fromAgentId: ensureHuman(database).id,
        body: `群「${conversation.name ?? conversation.key}」已解散。`,
        meta: { action: "group_dissolve", agentId: conversation.id },
        idempotencyKey: `group-dissolve:${conversation.id}`,
      })
      deleteConversationCascade(database, conversation.id)
      return c.json({ ok: true })
    })
}
