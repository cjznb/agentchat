/**
 * `wake_jobs` 状态机与唤醒队列存储（spec §7/§12；Task 6）。
 *
 * 状态机移植自 claude-codex-mcp-bridge（MIT, WebisityStudio）
 * `src/wake-queue.ts`（原子条件认领 `UPDATE ... WHERE state='pending'`、指数退避、
 * 失败通知 30 分钟合并窗口模式），源码见只读克隆
 * `.slim/clonedeps/repos/WebisityStudio__claude-codex-mcp-bridge/`。
 * 按本仓裁决收敛（Global Constraints 精确值）：
 * - 退避 `min(30000, 500·2^attempts)` ms；`busy` 保留 `24h`、`offline` 不过期
 * - 连续 `refused` 达 `REFUSAL_LIMIT`(2) 次 → 终态 `refused` → 发送方收合并通知
 * - `read` 仅由 ack 触发；回执 `delivered` 由 job `accepted` 派生
 *   （**仅** `/internal/result delivered` → `accepted`，见 core/publish `receiptState`）。
 *   pull 认领（`store/wake-claims.ts` 的 `claimWakeBacklogJob`）只置 `sending` 在途租约，
 *   绝不直接 `accepted`
 *
 * 生成规则（binding）：仅 `kind='runtime' AND status IN (online,busy)` 收件方建 job，
 * `logical`（含 human）与 offline/retired 收件方纯收件箱。
 * **不**再要求该 vendor 已注册适配器（Plan 5 修复 2）：无论推送通道存否，发送时一律为
 * 合格收件方建 job，使回执阶段从此真实（`pending → queued`，而非「无 job 也 queued」）；
 * pull 适配器在 `/internal/wake` 认领、dispatcher 对无适配器 vendor 退避跳过（绝不误注入）。
 * 所有状态写入以条件更新（`WHERE state = ...`）或 `canWakeTransition` 白名单守卫。
 */
import { z } from "zod"
import { agentStatusSchema, type AgentStatus } from "../../shared/contracts"
import type { Db } from "../db"
import { getBySeq } from "./messages"

// ── 常量（计划 Global Constraints 锁定值） ─────────────────────────

/** 退避：`min(BACKOFF_CAP_MS, BACKOFF_BASE_MS · 2^attempts)` ms。 */
export const BACKOFF_BASE_MS = 500
export const BACKOFF_CAP_MS = 30_000
/** `busy` 保留窗口 24h（到期 → `expired`）；`offline` 不过期。 */
export const BUSY_TTL_MS = 86_400_000
/** 失败通知合并窗口：同 (sender, recipient) 对 30 分钟内合并为 1 条。 */
export const NOTICE_WINDOW_MS = 1_800_000
/** 连续 `refused` 达该次数 → 终态 `refused` 并通知发送方（DoD：2 次）。 */
export const REFUSAL_LIMIT = 2
/** 认领后在途时限：超时未回执则回 `pending` 重投。 */
export const CLAIM_TIMEOUT_MS = 30_000

// ── 类型与状态机白名单 ────────────────────────────────────────────

export type WakeState =
  | "pending"
  | "sending"
  | "accepted"
  | "refused"
  | "expired"
  | "cancelled"
export type PendingReason = "busy" | "offline"
export type DeliveryResult = "delivered" | "refused"

const wakeStateSchema = z.enum([
  "pending",
  "sending",
  "accepted",
  "refused",
  "expired",
  "cancelled",
])
const pendingReasonSchema = z.enum(["busy", "offline"]).nullable()

/**
 * 状态机白名单（brief：`pending→sending→accepted|refused|expired|cancelled`；
 * 补投需要的 `sending→pending` 回退与 `/internal/wake` 的 `→accepted` 认领）。
 * `read` 不在此表——由 ack 驱动 `read_states`，与 job 无关。
 */
const WAKE_TRANSITIONS: Record<WakeState, readonly WakeState[]> = {
  pending: ["sending", "accepted", "refused", "expired", "cancelled"],
  sending: ["pending", "accepted", "refused", "cancelled"],
  accepted: ["refused", "pending"],
  refused: [],
  expired: [],
  cancelled: [],
}

export function canWakeTransition(from: WakeState, to: WakeState): boolean {
  return from === to || WAKE_TRANSITIONS[from].includes(to)
}

/** 指数退避（attempts 上限 30 防浮点溢出；超过 cap 恒为 30000）。 */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 30))
}

export interface WakeJob {
  readonly id: number
  readonly messageId: number
  readonly agentId: string
  readonly state: WakeState
  readonly attempts: number
  readonly retryAt: number
  readonly pendingReason: PendingReason | null
  readonly notifiedAt: number | null
  readonly detail: string
  readonly createdAt: number
}

interface WakeJobRow {
  readonly id: number
  readonly message_id: number
  readonly agent_id: string
  readonly state: string
  readonly attempts: number
  readonly retry_at: number
  readonly pending_reason: string | null
  readonly notified_at: number | null
  readonly detail: string
  readonly created_at: number
}

function toWakeJob(row: WakeJobRow): WakeJob {
  return {
    id: row.id,
    messageId: row.message_id,
    agentId: row.agent_id,
    state: wakeStateSchema.parse(row.state),
    attempts: row.attempts,
    retryAt: row.retry_at,
    pendingReason: pendingReasonSchema.parse(row.pending_reason),
    notifiedAt: row.notified_at,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

/** 按 (message, recipient) 取 job（回执派生与认领判定共用）。 */
export function getWakeJob(db: Db, messageSeq: number, agentId: string): WakeJob | undefined {
  const row = db
    .prepare<[number, string], WakeJobRow>(
      "SELECT * FROM wake_jobs WHERE message_id = ? AND agent_id = ?",
    )
    .get(messageSeq, agentId)
  return row === undefined ? undefined : toWakeJob(row)
}

// ── 生成（发送路径接线点） ────────────────────────────────────────

export interface EnqueueInput {
  readonly messageId: number
  readonly recipientIds: readonly string[]
  /** 缺省 `Date.now()`；测试可注入。 */
  readonly now?: number
}

/**
 * 发送即生成唤醒任务（spec §7）：`INSERT OR IGNORE` 幂等（幂等重发安全）；
 * `retry_at = now + backoff(0)`；`status='busy'` 落 `pending_reason='busy'`。
 * 仅 runtime + online/busy 的收件方建 job（**不**看 vendor 是否已注册适配器；见文件头规则）。
 */
export function enqueueWakeJobs(db: Db, input: EnqueueInput): number {
  if (input.recipientIds.length === 0) return 0
  const now = input.now ?? Date.now()
  const placeholders = input.recipientIds.map(() => "?").join(",")
  const candidates = db
    .prepare<string[], { id: string; status: string }>(
      `SELECT id, status FROM agents
        WHERE kind = 'runtime' AND status IN ('online','busy') AND id IN (${placeholders})`,
    )
    .all(...input.recipientIds)
  const insert = db.prepare<[number, string, number, string | null, number], { changes: number }>(
    `INSERT OR IGNORE INTO wake_jobs
       (message_id, agent_id, state, attempts, retry_at, pending_reason, detail, created_at)
     VALUES (?, ?, 'pending', 0, ?, ?, '', ?)`,
  )
  let created = 0
  for (const candidate of candidates) {
    const reason = candidate.status === "busy" ? "busy" : null
    created += insert.run(input.messageId, candidate.id, now + backoffMs(0), reason, now).changes
  }
  return created
}

// ── 调度原语（dispatcher 每轮调用） ───────────────────────────────

export interface DueWakeJob extends WakeJob {
  readonly recipientStatus: AgentStatus
  readonly recipientVendor: string
}

/** 到期 `pending` job（含收件方状态/vendor，供 dispatcher 分流认领/退避）。 */
export function dueWakeJobs(db: Db, now: number): DueWakeJob[] {
  const rows = db
    .prepare<[number], WakeJobRow & { status: string; vendor: string }>(
      `SELECT j.*, a.status AS status, a.vendor AS vendor
         FROM wake_jobs j JOIN agents a ON a.id = j.agent_id
        WHERE j.state = 'pending' AND j.retry_at <= ?
        ORDER BY j.id`,
    )
    .all(now)
  return rows.map((row) => ({
    ...toWakeJob(row),
    recipientStatus: agentStatusSchema.parse(row.status),
    recipientVendor: row.vendor,
  }))
}

/**
 * 原子认领（brief Constraints：`UPDATE ... WHERE state='pending'` 条件更新）：
 * `pending→sending`，`attempts+1`，在途时限 `CLAIM_TIMEOUT_MS`。
 */
export function claimWakeJob(
  db: Db,
  input: { readonly id: number; readonly now: number },
): WakeJob | undefined {
  const row = db
    .prepare<{ id: number; now: number; timeout: number }, WakeJobRow>(
      `UPDATE wake_jobs
          SET state = 'sending', attempts = attempts + 1,
              retry_at = $now + $timeout, pending_reason = NULL
        WHERE id = $id AND state = 'pending'
        RETURNING *`,
    )
    .get({ ...input, timeout: CLAIM_TIMEOUT_MS })
  return row === undefined ? undefined : toWakeJob(row)
}

/** 使该收件方全部 `pending` job 立即到期（上报 idle、根重连补投）。 */
export function makeJobsDue(db: Db, input: { readonly agentId: string; readonly now: number }): number {
  return db
    .prepare<{ agentId: string; now: number }, void>(
      "UPDATE wake_jobs SET retry_at = $now WHERE agent_id = $agentId AND state = 'pending'",
    )
    .run(input).changes
}

// ── 投递结果与失败处理 ────────────────────────────────────────────

/**
 * 落投递结果（dispatcher 推送路径与 `POST /internal/result` 共用）：
 * `delivered` → `accepted`（已终态则保持）；`refused` → 连续第 N 次拒收，
 * `N < REFUSAL_LIMIT` 回 `pending` 按退避重投，`N >= REFUSAL_LIMIT` 终态 `refused`
 * （随后由 dispatcher 失败扫描通知发送方，30min 同对合并）。
 * 拒收次数记于 `detail` JSON `{"refusals":n}`（schema 无独立计数列）。
 */
export function applyDeliveryResult(
  db: Db,
  input: {
    readonly agentId: string
    readonly messageSeq: number
    readonly result: DeliveryResult
    readonly now: number
  },
): { readonly state: WakeState; readonly stateChanged: boolean; readonly conversationId: string | undefined } {
  const conversationId = getBySeq(db, input.messageSeq)?.conversationId
  let job = getWakeJob(db, input.messageSeq, input.agentId)
  if (job === undefined) {
    // 结果先于 job 到达（发送时收件方 offline 无 job）：补建行再进状态机。
    db.prepare<[number, string, number, number], void>(
      `INSERT INTO wake_jobs (message_id, agent_id, state, attempts, retry_at, pending_reason, detail, created_at)
       VALUES (?, ?, 'pending', 0, ?, NULL, '', ?)`,
    ).run(input.messageSeq, input.agentId, input.now, input.now)
    job = getWakeJob(db, input.messageSeq, input.agentId)
    if (job === undefined) return { state: "pending", stateChanged: false, conversationId }
  }
  switch (input.result) {
    case "delivered": {
      if (job.state === "accepted" || !canWakeTransition(job.state, "accepted")) {
        return { state: job.state, stateChanged: false, conversationId }
      }
      db.prepare<[number, WakeState], void>(
        "UPDATE wake_jobs SET state = 'accepted', detail = '' WHERE id = ? AND state = ?",
      ).run(job.id, job.state)
      return { state: "accepted", stateChanged: true, conversationId }
    }
    case "refused": {
      const refusals = refusalsOf(job.detail) + 1
      const target: WakeState = refusals >= REFUSAL_LIMIT ? "refused" : "pending"
      // 白名单守卫（与 delivered 分支对称）：终态（expired/cancelled/refused）不得被复活。
      if (!canWakeTransition(job.state, target)) {
        return { state: job.state, stateChanged: false, conversationId }
      }
      const retryAt = target === "pending" ? input.now + backoffMs(job.attempts) : job.retryAt
      db.prepare<[WakeState, string, number, number, WakeState], void>(
        "UPDATE wake_jobs SET state = ?, detail = ?, retry_at = ? WHERE id = ? AND state = ?",
      ).run(target, JSON.stringify({ refusals }), retryAt, job.id, job.state)
      return { state: target, stateChanged: target !== job.state, conversationId }
    }
  }
}

const refusalsSchema = z.object({ refusals: z.number().int().nonnegative() })

function refusalsOf(detail: string): number {
  if (detail === "") return 0
  try {
    const parsed = refusalsSchema.safeParse(JSON.parse(detail))
    return parsed.success ? parsed.data.refusals : 0
  } catch {
    return 0 // 非 JSON 历史文本按 0 计
  }
}

/**
 * 原子认领一条待通知的失败 job（bridge `claimFailure` 模式）：
 * `state IN (refused, expired) AND notified_at IS NULL` 条件更新。
 */
export function claimFailedNotice(db: Db, now: number): WakeJob | undefined {
  const row = db
    .prepare<{ now: number }, WakeJobRow>(
      `UPDATE wake_jobs SET notified_at = $now WHERE id = (
         SELECT id FROM wake_jobs
          WHERE state IN ('refused','expired') AND notified_at IS NULL
          ORDER BY id LIMIT 1
       ) AND notified_at IS NULL
       RETURNING *`,
    )
    .get({ now })
  return row === undefined ? undefined : toWakeJob(row)
}
