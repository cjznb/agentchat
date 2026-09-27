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
import { rosterTree } from "../core/agents"
import {
  addParticipant as gatedAddParticipant,
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
  shoutPayloadSchema,
  type DecidedApproval,
} from "../core/permissions"
import { agentCard, conversationList, groupList } from "../core/ui-queries"
import { config } from "../config"
import { openDb, type Db } from "../db"
import { listApprovals, type Approval } from "../store/approvals"
import { addParticipant, createGroup } from "../store/conversations"

// 生产缺省连接：首个 roster 请求时按 `config.dbPath` 打开并复用（进程单例）。
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

const decisionBodySchema = z.object({ decision: z.enum(["approve", "reject"]) })
const sendBodySchema = z.object({ body: z.string() })
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
      addParticipant(db, {
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
    .get("/api/roster", (c) => {
      const database = resolveDb(db)
      ensureHuman(database)
      return c.json(rosterTree(database))
    })
    // Task 4：审批列表只列**审批单**（kind='action'）—— 批示单（ask）归 `/api/notifications`（含 ask）。
    .get("/api/approvals", (c) => c.json(listApprovals(resolveDb(db), "pending", "action")))
    .post("/api/approvals/:id", async (c) => {
      const database = resolveDb(db)
      const parsed = decisionBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
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
    // Task 9：human 在既有会话发言（human 超级观察者，绕成员校验）。
    .post("/api/conversations/:id/messages", async (c) => {
      const database = resolveDb(db)
      const parsed = sendBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      try {
        const result = sendMessage(database, {
          from: ensureHuman(database).id,
          to: c.req.param("id"),
          body: parsed.data.body,
        })
        return c.json({ ok: true, ...result })
      } catch (error) {
        if (error instanceof RecipientNotFound) return c.json({ ok: false, error: error.code }, 404)
        if (error instanceof NotParticipantError) return c.json({ ok: false, error: error.code }, 403)
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
