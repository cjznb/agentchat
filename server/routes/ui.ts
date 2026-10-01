/**
 * UI 侧 HTTP 路由（spec §11）——`GET /api/roster`；
 * Task 4：路由服务的库同时保证 human 身份就绪（决议 2，人通道即刻可执行）。
 * Task 7：`GET /api/approvals`（待处理列表）、`POST /api/approvals/:id {decision}` ——
 * 决议与执行的汇合点（决议 1：本层可同时 import permissions 与 messaging/store：
 * `decide` 落库返回待执行审批单 → 批准在此执行受限动作 → `postDecision` 发结果回执，
 * message publish 解锁发起方 `wait`）。
 */
import { Hono } from "hono"
import { z } from "zod"
import { conversationRoster, rosterTree } from "../core/agents"
import {
  addParticipant as gatedAddParticipant,
  applyAddParticipant,
  ContainerNotChatTargetError,
  createGroup as gatedCreateGroup,
  NotParticipantError,
  RecipientNotFound,
  sendMessage,
  shout,
} from "../core/messaging"
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  decide,
  ensureHuman,
  groupAddPayloadSchema,
  groupCreatePayloadSchema,
  postDecision,
  postSystem,
  shoutPayloadSchema,
  type DecidedApproval,
} from "../core/permissions"
import { MessageNotFoundError, NotRevocableError, NotSenderError, revokeMessage } from "../core/revoke"
import { agentCard, conversationList, conversationMessages, groupList } from "../core/ui-queries"
import { config } from "../config"
import { openDb, type Db } from "../db"
import { agentDisplayName, getAgent } from "../store/agents"
import { getApproval, listApprovals, type Approval } from "../store/approvals"
import {
  createDm,
  createGroup,
  deleteConversationCascade,
  getConversation,
  isParticipant,
  listParticipants,
  removeParticipant,
} from "../store/conversations"
import { latestInConversation } from "../store/messages"
import { markRead } from "../store/read_states"
import { handleAgentRename } from "./agent-rename"

// 生产缺省连接：首个 roster 请求时按 `config.dbPath` 打开并复用（进程单例）。
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

const decisionBodySchema = z.object({ decision: z.enum(["approve", "reject"]) })
// body + 结构化提及（spec §3.1；仅群会话参与 T 解析，shout 入口忽略 mentions）。
const sendBodySchema = z.object({ body: z.string(), mentions: z.array(z.string()).optional() })
const ensureDmBodySchema = z.object({ to: z.string().min(1) })
const groupBodySchema = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string()).optional(),
})
const memberBodySchema = z.object({ agentId: z.string().min(1) })

/**
 * 批准后的实际执行（决议 1：执行在路由层 —— 本层同时 import permissions 与
 * messaging/store 原语；绕开闸门的是"已批准"路径而非执法点本身）。
 * payload schema 单源在 `core/permissions`（与 `gate` 前置校验同一份，
 * Important #1）；此处解析取类型化字段（parse-don't-validate）。
 */
function executeApproved(db: Db, approval: Approval): void {
  switch (approval.action) {
    case "shout": {
      const { body } = shoutPayloadSchema.parse(approval.payload)
      sendMessage(db, { from: approval.requesterAgentId, to: "*", body })
      return
    }
    case "group_create": {
      const { name, memberIds } = groupCreatePayloadSchema.parse(approval.payload)
      createGroup(db, {
        name,
        createdBy: approval.requesterAgentId,
        ...(memberIds === undefined ? {} : { memberIds }),
      })
      return
    }
    case "group_add": {
      const { conversationId, agentId, role } = groupAddPayloadSchema.parse(approval.payload)
      // 批准执行与闸内执行共用同一落地路径（store 写入 + 入群 system 通知，Task 5）。
      applyAddParticipant(db, {
        conversationId,
        agentId,
        invitedBy: approval.requesterAgentId,
        ...(role === undefined ? {} : { role }),
      })
      return
    }
    case "ask":
      // ask 单的答复走 Task 2 的 respondAsk，不经审批执行路径；显式守卫（类型穷尽 + 运行期防御）。
      throw new Error("ask approvals are not executed via executeApproved")
    default: {
      // 穷尽保护：ApprovalAction 增变体而漏处理时显式失败，而非静默不执行。
      const unreachable: never = approval.action
      throw new Error(`unhandled approval action: ${String(unreachable)}`)
    }
  }
}

/** 路由表：`db` 缺省时惰性取进程配置库（测试显式注入临时库）。 */
export function uiRoutes(db?: Db): Hono {
  return new Hono()
    .patch("/api/agents/:id", (c) => handleAgentRename(c, resolveDb(db)))
    .get("/api/roster", (c) => {
      const database = resolveDb(db)
      const human = ensureHuman(database)
      // Task 5：`?conversation=` 只返回该会话成员（人类 UI 视图 → 以 human 身份过闸，
      // 超观察者豁免；shout/未知会话按核心口径返回空数组）。缺省/空值行为与现状一致。
      const conversation = c.req.query("conversation")
      if (conversation === undefined || conversation === "") return c.json(rosterTree(database))
      return c.json(conversationRoster(database, human.id, conversation))
    })
    // Task 4：审批列表只列**审批单**（kind='action'）—— 批示单（ask）归 `/api/notifications`（含 ask）。
    .get("/api/approvals", (c) => c.json(listApprovals(resolveDb(db), "pending", "action")))
    .post("/api/approvals/:id", async (c) => {
      const database = resolveDb(db)
      const parsed = decisionBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      // Fix 1：先按 id 取单再决定 —— asks（kind='ask'）不认审批端点，必须在 `decide` **之前**拒绝，
      // 否则 `claimDecision` 会先把 pending ask 误改为 approved，令其永久无法答复（respondAsk→AskForbiddenError）。
      // 语义：asks 经 `/api/asks/:id/respond` 答复，审批端点 404 `ask_not_found`。
      const existing = getApproval(database, c.req.param("id"))
      if (existing === undefined) {
        return c.json({ ok: false, error: new ApprovalNotFoundError(c.req.param("id")).code }, 404)
      }
      if (existing.kind === "ask") return c.json({ ok: false, error: "ask_not_found" }, 404)
      let approval: DecidedApproval
      try {
        approval = decide(database, c.req.param("id"), parsed.data.decision, Date.now())
      } catch (error) {
        if (error instanceof ApprovalNotFoundError) {
          return c.json({ ok: false, error: error.code }, 404)
        }
        if (error instanceof ApprovalAlreadyDecidedError) {
          return c.json({ ok: false, error: error.code }, 409)
        }
        throw error
      }
      if (approval.status === "approved") {
        // 回执不变式（Important #1）：执行失败也必须发出回执（meta/正文如实报失败），
        // HTTP 如实反映失败；单保持 approved，再决仍由条件 UPDATE 409 锁死。
        try {
          executeApproved(database, approval)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          postDecision(database, approval, detail)
          return c.json(
            { ok: false, error: "approval_execution_failed", detail, approval },
            500,
          )
        }
      }
      postDecision(database, approval)
      return c.json({ ok: true, approval })
    })
    // Task 9：会话列表（双层聚合未读 + 最后预览）。
    .get("/api/conversations", (c) => c.json(conversationList(resolveDb(db))))
    // Plan 3 T6：确保 human↔节点 DM（取或建，幂等）——资料卡「发消息」在无既有 DM 时建会话。
    .post("/api/conversations", async (c) => {
      const database = resolveDb(db)
      const parsed = ensureDmBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const target = getAgent(database, parsed.data.to)
      if (target === undefined) return c.json({ ok: false, error: "recipient_not_found" }, 404)
      // human 自身不建 DM（human 走超级观察者直读任意会话，不参与 DM 成员表语义）。
      if (target.vendor === "human") return c.json({ ok: false, error: "invalid_recipient" }, 400)
      // F3：退役节点不可开新 DM（灰显保留资料卡/历史，仅禁发消息）——明确错误码 + 409。
      if (target.status === "retired") return c.json({ ok: false, error: "recipient_retired" }, 409)
      // M1：分组容器不是聊天对象，不可开 DM（与核心发送路径同一判定）——明确错误码 + 409。
      if (target.roleTag === "container") return c.json({ ok: false, error: "container_not_chat_target" }, 409)
      const conversation = createDm(database, ensureHuman(database).id, target.id)
      return c.json({ ok: true, conversation })
    })
    // Plan 3 T3：会话历史分页（`before` = seq 不含，缺省最新一页，seq 升序）；未知会话 404。
    .get("/api/conversations/:id/messages", (c) => {
      const database = resolveDb(db)
      const id = c.req.param("id")
      if (getConversation(database, id) === undefined) {
        return c.json({ ok: false, error: "conversation_not_found" }, 404)
      }
      const rawBefore = c.req.query("before")
      const before = rawBefore === undefined || rawBefore === "" ? undefined : Number(rawBefore)
      if (before !== undefined && (!Number.isInteger(before) || before < 0)) {
        return c.json({ ok: false, error: "invalid_before" }, 400)
      }
      const rawLimit = c.req.query("limit")
      const limit = rawLimit === undefined || rawLimit === "" ? undefined : Number(rawLimit)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
        return c.json({ ok: false, error: "invalid_limit" }, 400)
      }
      // Plan 3 T5：自有文本消息附四级回执 + 聚合 stage（决议 1）。
      return c.json({
        messages: conversationMessages(database, id, ensureHuman(database).id, before, limit),
      })
    })
    // Task 1：human 会话读位点推进到该会话**最新 seq**（幂等，只前进不回退）；未知会话 404。
    .post("/api/conversations/:id/read", (c) => {
      const database = resolveDb(db)
      const id = c.req.param("id")
      if (getConversation(database, id) === undefined) {
        return c.json({ ok: false, error: "conversation_not_found" }, 404)
      }
      const lastReadSeq = latestInConversation(database, id)?.seq ?? 0
      markRead(database, { conversationId: id, agentId: ensureHuman(database).id, lastReadSeq })
      return c.json({ ok: true, lastReadSeq })
    })
    // Task 9：human 在既有会话发言（human 超级观察者，绕成员校验）。
    .post("/api/conversations/:id/messages", async (c) => {
      const database = resolveDb(db)
      const parsed = sendBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      try {
        const result = sendMessage(database, {
          from: ensureHuman(database).id,
          to: c.req.param("id"),
          ...parsed.data, // { body, mentions? }
        })
        return c.json({ ok: true, ...result })
      } catch (error) {
        // 自发消息守卫（BUG-SELF-SEND，core/messaging SelfSendError）：与 MCP 径同码，HTTP 侧 409。
        if (error instanceof Error && error.name === "SelfSendError") {
          return c.json({ ok: false, error: "self_send" }, 409)
        }
        if (error instanceof RecipientNotFound) return c.json({ ok: false, error: error.code }, 404)
        if (error instanceof NotParticipantError) return c.json({ ok: false, error: error.code }, 403)
        if (error instanceof ContainerNotChatTargetError) {
          return c.json({ ok: false, error: error.code }, 409)
        }
        throw error
      }
    })
    // feat/revoke-queued：撤回排队中消息（仅发送方；尽力撤回，不新增 MCP 工具）。
    .post("/api/conversations/:id/messages/:messageId/revoke", (c) => {
      const database = resolveDb(db)
      try {
        const revokedAt = revokeMessage(database, {
          conversationId: c.req.param("id"),
          messageId: c.req.param("messageId"),
          actorId: ensureHuman(database).id,
          now: Date.now(),
        })
        return c.json({ ok: true, revokedAt })
      } catch (error) {
        if (error instanceof MessageNotFoundError) {
          return c.json({ ok: false, error: error.code }, 404)
        }
        if (error instanceof NotSenderError) return c.json({ ok: false, error: error.code }, 403)
        // 仅 text 可撤回（system 提醒作者即撤回者，撤回会再生成一条 → 422 no-op）。
        if (error instanceof NotRevocableError) return c.json({ ok: false, error: error.code }, 422)
        throw error
      }
    })
    // Task 9：群列表 / 建群（human 走既有 gate → 即时执行零审批）。
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
    // 批次2轮D F2：移除群成员（仅人类 UI，不新增 MCP 工具）。守卫序：非法 body 400 →
    // 会话不存在 404 → 非群会话 400 → 目标不在群 404 → 删到仅剩 1 人 409（稳定码）。
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
    // 批次2轮D F2：解散群聊（仅人类 UI）。先广播「群已解散」system 条目（复用既有
    // message 封套、0 wake，在线端即时看到并移除会话），再按外键现实级联删除。
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
    // Task 9：全员喊话（human → gate 即时执行）。
    .post("/api/shout", async (c) => {
      const database = resolveDb(db)
      const parsed = sendBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const outcome = shout(database, ensureHuman(database).id, parsed.data.body)
      return "approved" in outcome
        ? c.json({ ok: true, ...outcome.approved })
        : c.json({ ok: true, approval: outcome.approval })
    })
    // Task 9：资料卡（roster 节点 + 参与会话入口）。
    .get("/api/agents/:id", (c) => {
      const card = agentCard(resolveDb(db), c.req.param("id"))
      return card === undefined
        ? c.json({ ok: false, error: "agent_not_found" }, 404)
        : c.json(card)
    })
}
