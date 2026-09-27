/**
 * pull 认领在途租约原语（Plan 4 修复波 Phase 1，缺陷 #1）。
 *
 * 从 `store/wake.ts` 抽出（保持单文件 ≤250 纯行）：`POST /internal/wake` 认领积压
 * 时把 job 置 `sending` + `CLAIM_TIMEOUT_MS` 在途租约——**绝不**直接 `accepted`。
 * `accepted` 仅由 `/internal/result {delivered}` 派生（见 core/publish `receiptState`）。
 * 崩溃未回执时，租约过期由 `requeueExpiredClaims`（dispatcher tick）或本模块
 * 的过期重认领分支自愈重投，杜绝「未投递却谎报 delivered」。
 */
import type { Db } from "../db"
import { CLAIM_TIMEOUT_MS, claimWakeJob, getWakeJob, type WakeJob } from "./wake"

/**
 * 认领一条 pull 积压：可认领集合 = job 缺失 ｜ `pending` ｜
 * `sending` 且租约已过期（`retry_at <= now`）。返回认领后的 job，或 `undefined`
 * （已 `accepted`/`refused`/`expired`/`cancelled`，或在途租约仍有效 → 不重复投递）。
 * job 缺失时补建为 `sending`（在途，非 `accepted`）；`pending` 走原子条件认领。
 */
export function claimWakeBacklogJob(
  db: Db,
  input: { readonly messageSeq: number; readonly agentId: string; readonly now: number },
): WakeJob | undefined {
  const existing = getWakeJob(db, input.messageSeq, input.agentId)
  if (existing === undefined) {
    db.prepare<[number, string, number, number], void>(
      `INSERT INTO wake_jobs (message_id, agent_id, state, attempts, retry_at, pending_reason, detail, created_at)
       VALUES (?, ?, 'sending', 1, ?, NULL, '', ?)`,
    ).run(input.messageSeq, input.agentId, input.now + CLAIM_TIMEOUT_MS, input.now)
    return getWakeJob(db, input.messageSeq, input.agentId)
  }
  if (existing.state === "pending") return claimWakeJob(db, { id: existing.id, now: input.now })
  if (existing.state === "sending" && existing.retryAt <= input.now) {
    const { changes } = db
      .prepare<[number, number, number], { changes: number }>(
        `UPDATE wake_jobs
            SET state = 'sending', attempts = attempts + 1,
                retry_at = ?, pending_reason = NULL
          WHERE id = ? AND state = 'sending' AND retry_at <= ?`,
      )
      .run(input.now + CLAIM_TIMEOUT_MS, existing.id, input.now)
    return changes > 0 ? getWakeJob(db, input.messageSeq, input.agentId) : undefined
  }
  return undefined
}

/**
 * 回收过期在途租约（崩溃自愈）：`sending` 且 `retry_at <= now` → 回 `pending`
 * （保留 `attempts`，退避语义不变），等待下一次重投。dispatcher 每轮 tick 调用；
 * 亦为 `claimWakeBacklogJob` 的兜底（dispatcher 未跑时由 wake 认领前自行回收）。
 * 返回受影响消息 seq（调用方发布回执事件）。
 */
export function requeueExpiredClaims(db: Db, now: number): number[] {
  const rows = db
    .prepare<[number], { message_id: number }>(
      `UPDATE wake_jobs SET state = 'pending'
        WHERE state = 'sending' AND retry_at <= ?
        RETURNING message_id`,
    )
    .all(now)
  return rows.map((row) => row.message_id)
}
