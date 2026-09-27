/**
 * `approvals` 表读写（spec §8 审批 + §17 请求批示；Task 7 → 本任务泛化）—— 一套状态机两用：
 * `kind='action'` 为审批单，`kind='ask'` 为请求批示单。插入、读取、待处理列表、
 * 条件 UPDATE 决议（并发双决以第一次落库为准）、首答落库与 24h 过期批量认领均在本层。
 * 行（snake_case）→ 域对象（camelCase）映射与 JSON/枚举解析在本层完成；
 * 单语句 UPDATE 自身原子（spec §12 数据安全）。通知查询见 `store/notifications.ts`（行数红线拆分）。
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  approvalActionSchema,
  approvalStatusSchema,
  type ApprovalAction,
  type ApprovalStatus,
} from "../../shared/contracts"
import type { Db } from "../db"

// 枚举单源在 shared/contracts（Task 9 上移，REST/WS/前端共用）；此处仅再导出既有类型名。
export type { ApprovalAction, ApprovalStatus }

/** 审批单种类（spec §5.3/§17.2：一套状态机两用）。 */
export const APPROVAL_KINDS = ["action", "ask"] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export const approvalKindSchema = z.enum(APPROVAL_KINDS)

/**
 * ask 单的 `action` 占位（列 NOT NULL）。契约锁定枚举 `APPROVAL_ACTIONS` 不含 `ask`
 * （本任务唯一允许的 contracts 触点仅为 `status` 加 `'answered'`），故在 store 层局部放宽。
 */
export const ASK_ACTION = "ask" as const
export type ApprovalActionValue = ApprovalAction | typeof ASK_ACTION
const approvalActionValueSchema = z.union([approvalActionSchema, z.literal(ASK_ACTION)])

const payloadSchema = z.record(z.string(), z.unknown())

export interface Approval {
  readonly id: string
  readonly requesterAgentId: string
  readonly kind: ApprovalKind
  readonly target: string
  readonly action: ApprovalActionValue
  readonly payload: Record<string, unknown>
  readonly status: ApprovalStatus
  readonly result: Record<string, unknown> | undefined
  readonly createdAt: number
  readonly decidedAt: number | undefined
  readonly readAt: number | undefined
}

/** 行结构（`store/notifications.ts` 复用映射）。 */
export interface ApprovalRow {
  readonly id: string
  readonly requester_agent_id: string
  readonly kind: string
  readonly target: string
  readonly action: string
  readonly payload: string
  readonly status: string
  readonly result: string | null
  readonly created_at: number
  readonly decided_at: number | null
  readonly read_at: number | null
}

function parseJsonObject(text: string): Record<string, unknown> {
  return payloadSchema.parse(JSON.parse(text))
}

/** 行 → 域对象（边界解析；通知查询复用故导出）。 */
export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    requesterAgentId: row.requester_agent_id,
    kind: approvalKindSchema.parse(row.kind),
    target: row.target,
    action: approvalActionValueSchema.parse(row.action),
    payload: parseJsonObject(row.payload),
    status: approvalStatusSchema.parse(row.status),
    result: row.result === null ? undefined : parseJsonObject(row.result),
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    readAt: row.read_at ?? undefined,
  }
}

interface InsertParams {
  readonly id: string
  readonly requesterAgentId: string
  readonly action: ApprovalAction
  readonly payload: string
  readonly createdAt: number
}

export interface InsertApprovalInput {
  readonly requesterAgentId: string
  readonly action: ApprovalAction
  readonly payload: Record<string, unknown>
  readonly now: number
}

/**
 * 插入一张 `pending` 审批单（`kind='action'`/`target='human'`；`created_at` 为 24h TTL 起点）。
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
    `INSERT INTO approvals (id, requester_agent_id, kind, target, action, payload, status, created_at)
     VALUES ($id, $requesterAgentId, 'action', 'human', $action, $payload, 'pending', $createdAt)`,
  ).run(params)
  return {
    id: params.id,
    requesterAgentId: params.requesterAgentId,
    kind: "action",
    target: "human",
    action: params.action,
    payload: input.payload,
    status: "pending",
    result: undefined,
    createdAt: params.createdAt,
    decidedAt: undefined,
    readAt: undefined,
  }
}

export interface InsertAskInput {
  readonly requesterAgentId: string
  readonly target: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom?: boolean
  readonly now: number
}

interface InsertAskParams {
  readonly id: string
  readonly requesterAgentId: string
  readonly target: string
  readonly payload: string
  readonly createdAt: number
}

/**
 * 插入一张 `pending` 请求批示单（spec §17.1）：`kind='ask'`，payload 存
 * `{question, options, allowCustom}`（`allowCustom` 缺省 true）；`target` 为 `'human'` 或目标 agent id。
 * 单行写入，语句自身原子；返回值按入参构造，不回查。
 */
export function insertAsk(db: Db, input: InsertAskInput): Approval {
  const payload: Record<string, unknown> = {
    question: input.question,
    options: [...input.options],
    allowCustom: input.allowCustom ?? true,
  }
  const params: InsertAskParams = {
    id: randomUUID(),
    requesterAgentId: input.requesterAgentId,
    target: input.target,
    payload: JSON.stringify(payload),
    createdAt: input.now,
  }
  db.prepare<InsertAskParams, void>(
    `INSERT INTO approvals (id, requester_agent_id, kind, target, action, payload, status, created_at)
     VALUES ($id, $requesterAgentId, 'ask', $target, 'ask', $payload, 'pending', $createdAt)`,
  ).run(params)
  return {
    id: params.id,
    requesterAgentId: params.requesterAgentId,
    kind: "ask",
    target: params.target,
    action: ASK_ACTION,
    payload,
    status: "pending",
    result: undefined,
    createdAt: params.createdAt,
    decidedAt: undefined,
    readAt: undefined,
  }
}

export function getApproval(db: Db, id: string): Approval | undefined {
  const row = db.prepare<[string], ApprovalRow>("SELECT * FROM approvals WHERE id = ?").get(id)
  return row === undefined ? undefined : toApproval(row)
}

/** 单据列表（`GET /api/approvals` 传 `"pending"` 取未处理）；并列 created_at 以 id 定序。 */
export function listApprovals(db: Db, status?: ApprovalStatus): Approval[] {
  const rows =
    status === undefined
      ? db.prepare<[], ApprovalRow>("SELECT * FROM approvals ORDER BY created_at ASC, id ASC").all()
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
 * 过期认领：`pending` 且 `created_at + ttl <= now` → `expired`（**两种 kind 同扫**）。
 * 单语句批量 UPDATE + RETURNING，命中行即本次认领结果（并发下不重复认领）。
 * `UPDATE...RETURNING` 无便携 ORDER BY → claim 后按 `created_at/id` 定序
 * （先到先处理，供 sweep 的单条隔离循环拿到确定顺序）。
 */
export function claimExpired(db: Db, input: ClaimExpiryInput): Approval[] {
  const rows = db
    .prepare<ClaimExpiryInput, ApprovalRow>(
      `UPDATE approvals SET status = 'expired', decided_at = $now
        WHERE status = 'pending' AND created_at <= $now - $ttlMs RETURNING *`,
    )
    .all(input)
  return rows
    .map(toApproval)
    .sort((a, b) =>
      a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
}

/**
 * 首答落库（spec §17.1：首答生效，同审批幂等）：仅 `pending` 单被改写为 `answered` 并落
 * 答复 `result`（JSON）+ `decided_at`；返回本次是否生效（竞争下第二次为 false，`result` 不被覆盖）。
 */
export function markAnswered(db: Db, id: string, result: Record<string, unknown>): boolean {
  const changes = db
    .prepare<{ id: string; result: string; now: number }, void>(
      `UPDATE approvals SET status = 'answered', result = $result, decided_at = $now
        WHERE id = $id AND status = 'pending'`,
    )
    .run({ id, result: JSON.stringify(result), now: Date.now() }).changes
  return changes > 0
}
