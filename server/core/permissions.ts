/**
 * 权限审批闸门（spec §8；Task 7）—— 建群/拉人/喊话三个受限入口的单点执法与审批全流程。
 *
 * - `gate(action, actor, payload, executor)`（brief Key facts 签名 + 决议 1 回调执行器）：
 *   人（`vendor==='human'`）→ 即时执行零审批；子（`parent_id !== NULL`）/逻辑节点 →
 *   `Forbidden`（无审批单）；根 → 生成 `pending` 审批单 + 审批卡并返回 `{approval}` 不执行。
 * - **无循环依赖（决议 1）**：本层不 import `core/messaging.ts` —— 受限动作由调用方
 *   （messaging 三入口）以闭包传入；`decide` 只落库并返回待执行的审批单，真正执行由
 *   路由层（`routes/ui.ts`，可同时 import 两边）完成后回调 `postDecision` 发结果回执。
 * - 审批卡与结果回执 = `messages.kind='system'`、进发起方↔用户 DM（不存在则建）；
 *   回执落库即 `message publish` → 发起方若 `wait`/`inbox` 挂着即被解锁
 *   （审批确认走 Task 5 消息通道，非新机制）。
 * - `sweepExpired(now)`：`pending` 满 24h → `expired` + 拒绝语义回执；dispatcher 每轮顺带调用。
 * - 时钟可注入（`now` 参数），测试不 `sleep(24h)`。
 */
import { z } from "zod"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  getAgent,
  getAgentByName,
  hasAgentKey,
  insertAgent,
  type Agent,
} from "../store/agents"
import {
  claimDecision,
  claimExpired,
  getApproval,
  insertApproval,
  type Approval,
  type ApprovalAction,
  type ApprovalActionValue,
} from "../store/approvals"
import { createDm, type Conversation } from "../store/conversations"
import { send } from "../store/messages"
import { emit } from "../ws"
import { publishMessage } from "./publish"

/** 审批 TTL（spec §8/§12 锁定 24h；Global Constraints）。 */
export const APPROVAL_TTL_MS = 86_400_000

const HUMAN_NAME = "用户"

/**
 * human 身份（决议 2）：FK 要求 agents 行 —— 幂等创建
 * `{kind:"logical", vendor:"human", name:"用户", status:"offline"}`；human 可读发任意会话。
 * 自 `core/messaging` 迁入（Task 7）：审批通道与人通道同属权限层；messaging 保持 re-export，
 * 既有导入路径（`core/messaging`）不变。
 */
export function ensureHuman(db: Db): Agent {
  const existing = getAgentByName(db, HUMAN_NAME)
  if (existing !== undefined) return existing
  return insertAgent(db, { name: HUMAN_NAME, kind: "logical", vendor: "human", status: "offline" })
}

/** 子 agent / 逻辑节点发起受限操作（spec §8：直接拒绝，无审批单）。 */
export class Forbidden extends Error {
  readonly code = "forbidden"
  constructor(
    readonly agentId: string,
    readonly action: ApprovalAction,
  ) {
    super(`agent ${agentId} is not allowed to initiate ${action}`)
    this.name = "Forbidden"
  }
}

/** 单不存在（`GET/POST /api/approvals` → 404）。 */
export class ApprovalNotFoundError extends Error {
  readonly code = "approval_not_found"
  constructor(readonly approvalId: string) {
    super(`approval not found: ${approvalId}`)
    this.name = "ApprovalNotFoundError"
  }
}

/** 已决单再决（Global Constraints：明确错误 `approval_already_decided`；并发双决第一次落库为准）。 */
export class ApprovalAlreadyDecidedError extends Error {
  readonly code = "approval_already_decided"
  constructor(readonly approvalId: string) {
    super(`approval already decided: ${approvalId}`)
    this.name = "ApprovalAlreadyDecidedError"
  }
}

/** 闸门前置校验失败（payload 非法，**不产生审批单**）。 */
export class InvalidApprovalPayloadError extends Error {
  readonly code = "invalid_approval_payload"
  constructor(
    readonly action: ApprovalAction,
    readonly detail: string,
  ) {
    super(`invalid payload for ${action}: ${detail}`)
    this.name = "InvalidApprovalPayloadError"
  }
}

/** 闸门返回的 pending 分支（brief Key facts：`{approval}`）。 */
export interface ApprovalRequested {
  readonly approval: Approval
}

/** `gate` 返回（brief Key facts：`{approved:立即执行} | {approval}`）。 */
export type GateOutcome<T> = { readonly approved: T } | ApprovalRequested

/**
 * 受限入口的对外返回（裁决 D2 收敛）：与 `GateOutcome<T>` 同构的判别联合 ——
 * `{approved}` 即时执行 / `{approval}` 待审批。调用方以 `"approved" in result` 判别。
 */
export type Gated<T> = { readonly approved: T } | ApprovalRequested

/** 已决议的审批单（`decide`/`sweepExpired` 的返回，供 `postDecision` 按状态发回执）。 */
export type DecidedApproval = Approval & {
  readonly status: "approved" | "rejected" | "expired"
}

const ACTION_LABEL: Record<ApprovalActionValue, string> = {
  shout: "全员喊话",
  group_create: "创建群聊",
  group_add: "拉人入会话",
  ask: "请求批示",
}

/**
 * 受限动作 payload 的**单一 schema 源**（Important #1）：`gate` 前置校验与路由执行端
 * （`routes/ui.ts.executeApproved`）共用同一份定义 —— 杜绝"入口/store 宽、批准执行严"
 * 的错位（如 `createGroup(name:"")` 立单后批准时才在 zod `.parse` 炸掉）。
 */
export const shoutPayloadSchema = z.object({ body: z.string() })
export const groupCreatePayloadSchema = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string()).optional(),
})
export const groupAddPayloadSchema = z.object({
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.enum(["owner", "member"]).optional(),
})

function payloadSchema(action: ApprovalAction) {
  switch (action) {
    case "shout":
      return shoutPayloadSchema
    case "group_create":
      return groupCreatePayloadSchema
    case "group_add":
      return groupAddPayloadSchema
  }
}

/**
 * 按 action 解析 payload：`gate` 在 `insertApproval` **之前**调用（非法 → 直接拒绝，
 * 无审批单落库），执行端以同一 schema 复解析取类型化字段（parse-don't-validate）。
 */
export function parseApprovalPayload(
  action: ApprovalAction,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = payloadSchema(action).safeParse(payload)
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ")
    throw new InvalidApprovalPayloadError(action, detail)
  }
  return result.data
}

/**
 * 审批通道 = 发起方↔用户 DM（决议 3：不存在则建）。导出供 messaging 定位 `shout.wait`
 * 的闸后等待会话（审批卡与结果回执同落此 DM）。
 */
export function approvalChannel(db: Db, requesterId: string): Conversation {
  return createDm(db, requesterId, ensureHuman(db).id)
}

interface SystemPost {
  readonly conversationId: string
  readonly fromAgentId: string
  readonly body: string
  readonly meta: Record<string, unknown>
  readonly idempotencyKey: string
}

/** system 消息落库 + `message publish`（发起方 `wait` 解锁的唯一通道；幂等键按单去重）。 */
function postSystem(db: Db, post: SystemPost): void {
  send(db, { ...post, kind: "system" })
  publishMessage(db, post.conversationId)
}

/** `approval` WS 事件发布（Task 9 发布点：审批卡产生/决定/过期处，单据快照）。 */
function emitApproval(approval: Approval): void {
  emit("approval", {
    approval: {
      id: approval.id,
      requesterAgentId: approval.requesterAgentId,
      action: approval.action,
      payload: approval.payload,
      status: approval.status,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt ?? null,
    },
  })
}

/**
 * 审批闸门（brief Key facts：`gate(action, actor, payload) → {approved:立即执行} | {approval}`；
 * 决议 1：执行器由调用方闭包传入，本层不依赖 messaging）。
 *
 * 根 agent 判定（决议 4）：`parent_id IS NULL AND kind='runtime'` 的注册根 —— spec §9 身份 =
 * `agent_keys`，生产根必经 `registerRoot`（同事务写 `agent_keys`）；未持 hub 身份的裸 runtime 根
 * 只可能由 store 直造（测试夹具，生产无此路径），不构成审批对象。
 */
export function gate<T>(
  db: Db,
  action: ApprovalAction,
  actorId: string,
  payload: Record<string, unknown>,
  execute: () => T,
): GateOutcome<T> {
  const actor = getAgent(db, actorId)
  if (actor === undefined) throw new AgentNotFoundError(actorId)
  if (actor.vendor === "human") return { approved: execute() }
  if (actor.parentId !== undefined || actor.kind !== "runtime") {
    throw new Forbidden(actorId, action)
  }
  if (!hasAgentKey(db, actorId)) return { approved: execute() }
  // 批准的对象是"将来执行"的载荷：与执行端同一 schema 前置校验（单源，Important #1）——
  // 非法 payload 到此为止（`invalid_approval_payload`，不产生审批单）。
  const storedPayload = parseApprovalPayload(action, payload)
  const approval = insertApproval(db, {
    requesterAgentId: actorId,
    action,
    payload: storedPayload,
    now: Date.now(),
  })
  const channel = approvalChannel(db, actorId)
  postSystem(db, {
    conversationId: channel.id,
    fromAgentId: actorId,
    body: `🔒 审批请求：${actor.name} 发起「${ACTION_LABEL[action]}」，等待你同意或拒绝。`,
    meta: { approvalId: approval.id, action, payload },
    idempotencyKey: `approval-card:${approval.id}`,
  })
  emitApproval(approval)
  return { approval }
}

/**
 * 决议（brief Key facts：`decide(approvalId, decision, now)`）：条件 UPDATE（仅 `pending` 落库，
 * 并发双决以第一次为准），返回**待执行的审批单**（`DecidedApproval` = 决议状态 + action/payload/
 * requester）；执行与回执由调用方（路由层）完成 —— 本层不执行动作、不发消息。
 * 已决单再决 → `ApprovalAlreadyDecidedError`；单不存在 → `ApprovalNotFoundError`。
 */
export function decide(
  db: Db,
  approvalId: string,
  decision: "approve" | "reject",
  now: number,
): DecidedApproval {
  const status = decision === "approve" ? "approved" : "rejected"
  const decided = claimDecision(db, { id: approvalId, status, now })
  if (decided === undefined) {
    if (getApproval(db, approvalId) === undefined) throw new ApprovalNotFoundError(approvalId)
    throw new ApprovalAlreadyDecidedError(approvalId)
  }
  return { ...decided, status }
}

function receiptBody(approval: DecidedApproval, error?: string): string {
  const label = ACTION_LABEL[approval.action]
  switch (approval.status) {
    case "approved":
      // 带 error = 执行已批准但失败：如实描述，不得谎称"已执行"（Important #1）。
      return error === undefined
        ? `✅ 审批已通过：「${label}」已执行。`
        : `⚠️ 审批已通过但执行失败：「${label}」未生效（${error}）。`
    case "rejected":
      return `❌ 审批已拒绝：「${label}」未执行。`
    case "expired":
      return `⏳ 审批已过期：「${label}」满 24 小时未处理，按拒绝回执，未执行。`
  }
}

/**
 * 结果回执（决议 3）：system 消息进发起方收件箱 + `message publish` —— 发起方若在
 * `wait`/`inbox` 挂着即被解锁。**回执不变式（Important #1）**：每张已决单恰发出一条
 * 回执 —— 批准执行失败时 `error` 一并入 `meta` 与正文，如实报"执行失败"；
 * 幂等键按单去重，重复调用不落两条。
 */
export function postDecision(db: Db, approval: DecidedApproval, error?: string): void {
  const channel = approvalChannel(db, approval.requesterAgentId)
  postSystem(db, {
    conversationId: channel.id,
    fromAgentId: ensureHuman(db).id,
    body: receiptBody(approval, error),
    meta: {
      approvalId: approval.id,
      action: approval.action,
      result: approval.status,
      ...(error === undefined ? {} : { error }),
    },
    idempotencyKey: `approval-receipt:${approval.id}`,
  })
  emitApproval(approval)
}

/**
 * 24h 过期清扫（brief Key facts：`sweepExpired(now)`；spec §8/§12）：`pending` 满 TTL →
 * `expired` + 拒绝语义回执给发起方。`now` 可由调用方注入（dispatcher 每轮顺带调用），
 * 测试不 `sleep(24h)`。**单条隔离（Important #1）**：每条回执独立 try/catch ——
 * 一条失败不中断其余、不回滚已 claim 的 `expired` 状态，仅记录错误。
 * 返回本次过期的单数。
 */
export function sweepExpired(
  db: Db,
  now: number,
  ttlMs: number = APPROVAL_TTL_MS,
): number {
  const expired = claimExpired(db, { now, ttlMs }).map(
    (approval): DecidedApproval => ({ ...approval, status: "expired" }),
  )
  for (const approval of expired) {
    try {
      postDecision(db, approval)
    } catch (error) {
      console.error("[agentchat] approval expiry receipt failed", approval.id, error)
    }
  }
  return expired.length
}
