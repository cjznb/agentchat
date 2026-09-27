/**
 * `approvals` 表读写（spec §8；Task 7）—— 审批单的插入、读取、待处理列表、
 * 条件 UPDATE 决议（并发双决以第一次落库为准）与 24h 过期批量认领。
 * 行（snake_case）→ 域对象（camelCase）映射与 JSON/枚举解析在本层完成；
 * 单语句 UPDATE 自身原子（spec §12 数据安全）。
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Db } from "../db"

// spec §8 的受限动作（与 messaging 三入口一一对应）；Task 8 收敛 io 契约时再并入 shared/contracts.ts。
const approvalActionSchema = z.enum(["shout", "group_create", "group_add"])
// schema.sql approvals.status 的 CHECK 镜像（SQL 无法 import，此处锁定取值）。
const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"])
const payloadSchema = z.record(z.string(), z.unknown())
export type ApprovalAction = z.infer<typeof approvalActionSchema>
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>

export interface Approval {
  readonly id: string
  readonly requesterAgentId: string
  readonly action: ApprovalAction
  readonly payload: Record<string, unknown>
  readonly status: ApprovalStatus
  readonly createdAt: number
  readonly decidedAt: number | undefined
}

interface ApprovalRow {
  readonly id: string
  readonly requester_agent_id: string
  readonly action: string
  readonly payload: string
  readonly status: string
  readonly created_at: number
  readonly decided_at: number | null
}

interface InsertParams {
  readonly id: string
  readonly requesterAgentId: string
  readonly action: ApprovalAction
  readonly payload: string
  readonly createdAt: number
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    requesterAgentId: row.requester_agent_id,
    action: approvalActionSchema.parse(row.action),
    payload: payloadSchema.parse(JSON.parse(row.payload)),
    status: approvalStatusSchema.parse(row.status),
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  }
}

export interface InsertApprovalInput {
  readonly requesterAgentId: string
  readonly action: ApprovalAction
  readonly payload: Record<string, unknown>
  readonly now: number
}

/**
 * 插入一张 `pending` 审批单（`created_at` 为 24h TTL 起点）。
 * 单行写入，语句自身原子；返回值按入参构造，不回查（无冗余验证）。
 */
export function insertApproval(db: Db, input: InsertApprovalInput): Approval {
  const params: InsertParams = {
    id: randomUUID(),
    requesterAgentId: input.requesterAgentId,
    action: input.action,
    payload: JSON.stringify(input.payload),
    createdAt: input.now,
  }
  db.prepare<InsertParams, void>(
    `INSERT INTO approvals (id, requester_agent_id, action, payload, status, created_at)
     VALUES ($id, $requesterAgentId, $action, $payload, 'pending', $createdAt)`,
  ).run(params)
  return {
    id: params.id,
    requesterAgentId: params.requesterAgentId,
    action: params.action,
    payload: input.payload,
    status: "pending",
    createdAt: params.createdAt,
    decidedAt: undefined,
  }
}

export function getApproval(db: Db, id: string): Approval | undefined {
  const row = db.prepare<[string], ApprovalRow>("SELECT * FROM approvals WHERE id = ?").get(id)
  return row === undefined ? undefined : toApproval(row)
}

/** 审批单列表（`GET /api/approvals` 传 `"pending"` 取未处理）；并列 created_at 以 id 定序。 */
export function listApprovals(db: Db, status?: ApprovalStatus): Approval[] {
  const rows =
    status === undefined
      ? db
          .prepare<[], ApprovalRow>("SELECT * FROM approvals ORDER BY created_at ASC, id ASC")
          .all()
      : db
          .prepare<{ status: ApprovalStatus }, ApprovalRow>(
            "SELECT * FROM approvals WHERE status = $status ORDER BY created_at ASC, id ASC",
          )
          .all({ status })
  return rows.map(toApproval)
}

export interface ClaimDecisionInput {
  readonly id: string
  readonly status: "approved" | "rejected"
  readonly now: number
}

/**
 * 条件决议（Global Constraints：并发双决以第一次落库为准）：
 * `UPDATE ... WHERE id=$id AND status='pending' RETURNING *` —— 仅未决单被改写；
 * 返回 `undefined` = 单不存在或已被决议（调用方据此区分 404 / `approval_already_decided`）。
 */
export function claimDecision(db: Db, input: ClaimDecisionInput): Approval | undefined {
  const row = db
    .prepare<ClaimDecisionInput, ApprovalRow>(
      `UPDATE approvals SET status = $status, decided_at = $now
        WHERE id = $id AND status = 'pending' RETURNING *`,
    )
    .get(input)
  return row === undefined ? undefined : toApproval(row)
}

export interface ClaimExpiryInput {
  readonly now: number
  readonly ttlMs: number
}

/**
 * 过期认领：`pending` 且 `created_at + ttl <= now` → `expired`。
 * 单语句批量 UPDATE + RETURNING，命中行即本次认领结果（并发下不重复认领）。
 */
export function claimExpired(db: Db, input: ClaimExpiryInput): Approval[] {
  const rows = db
    .prepare<ClaimExpiryInput, ApprovalRow>(
      `UPDATE approvals SET status = 'expired', decided_at = $now
        WHERE status = 'pending' AND created_at <= $now - $ttlMs RETURNING *`,
    )
    .all(input)
  return rows.map(toApproval)
}
