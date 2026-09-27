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
import { sendMessage } from "../core/messaging"
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  decide,
  ensureHuman,
  postDecision,
  type DecidedApproval,
} from "../core/permissions"
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
const shoutPayloadSchema = z.object({ body: z.string() })
const groupCreatePayloadSchema = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string()).optional(),
})
const groupAddPayloadSchema = z.object({
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.enum(["owner", "member"]).optional(),
})

/**
 * 批准后的实际执行（决议 1：执行在路由层 —— 本层同时 import permissions 与
 * messaging/store 原语；绕开闸门的是"已批准"路径而非执法点本身）。
 * payload 在 DB 读取边界经 zod 解析（parse-don't-validate）。
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
    .get("/api/approvals", (c) => c.json(listApprovals(resolveDb(db), "pending")))
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
      if (approval.status === "approved") executeApproved(database, approval)
      postDecision(database, approval)
      return c.json({ ok: true, approval })
    })
}
