/**
 * 群路由（批次2修复 C1：自 `routes/ui.ts` 拆出，守卫链/错误码/载荷零变化）——
 * - `GET/POST /api/groups`：群列表 / 建群（human 走既有 gate → 即时执行零审批）
 * - `POST /api/groups/:id/members`：拉人过闸（入群 system 通知在 core/messaging）
 * - `POST /api/groups/:id/members/remove`：F2 移除成员。载荷校验（400 invalid_body）留在本层；
 *   守卫序/稳定码/通知文案全部委托 `core/group-ops.removeGroupMember`（测试端点共用同一实现）：
 *   会话不存在 404 → 非群会话 400 → 目标不在群 404 → 删到仅剩 1 人 409；成功 `{ok:true}`
 * - `POST /api/groups/:id/dissolve`：F2 解散，委托 `core/group-ops.dissolveGroup`
 *   （先广播「群已解散」system 条目，再按外键现实级联删除，事务原子）
 *
 * 人类 UI 专属：不新增 MCP 工具、不新增 WS 事件（两端点均为 message 封套通知）。
 */
import { Hono } from "hono"
import { z } from "zod"
import { dissolveGroup, removeGroupMember, type GroupOpError } from "../core/group-ops"
import {
  addParticipant as gatedAddParticipant,
  createGroup as gatedCreateGroup,
} from "../core/messaging"
import { ensureHuman } from "../core/permissions"
import { groupList } from "../core/ui-queries"
import type { Db } from "../db"

const groupBodySchema = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string()).optional(),
})
const memberBodySchema = z.object({ agentId: z.string().min(1) })

/** group-ops 稳定错误码 → 既有 HTTP 码（F2 冻结映射；两个路径共用同一张表）。 */
const GROUP_OP_STATUS: Record<GroupOpError, 400 | 404 | 409> = {
  conversation_not_found: 404,
  not_group: 400,
  not_in_group: 404,
  cannot_remove_last_member: 409,
}

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
      const outcome = removeGroupMember(database, {
        conversationId: c.req.param("id"),
        agentId: parsed.data.agentId,
      })
      return outcome.ok
        ? c.json({ ok: true })
        : c.json({ ok: false, error: outcome.error }, GROUP_OP_STATUS[outcome.error])
    })
    .post("/api/groups/:id/dissolve", (c) => {
      const outcome = dissolveGroup(resolveDb(db), { conversationId: c.req.param("id") })
      return outcome.ok
        ? c.json({ ok: true })
        : c.json({ ok: false, error: outcome.error }, GROUP_OP_STATUS[outcome.error])
    })
}
