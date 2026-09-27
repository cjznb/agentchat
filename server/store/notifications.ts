/**
 * 通知查询与已读标记（spec §11.5/§17.3）—— 自 `store/approvals.ts` 拆出
 * （文件行数红线，controller 授权的结构偏差）。单用户 MVP：`read_at` 即全局已读。
 */
import type { Db } from "../db"
import { toApproval, type Approval, type ApprovalRow } from "./approvals"

/** 通知范围：`actionable` = 需我处理；`all` = 全部（含已决与 agent↔agent）。 */
export type NotificationScope = "actionable" | "all"

/**
 * 通知列表（spec §11.5）：
 * - `actionable`（需我处理）= `target='human' AND status='pending'`（含审批单与批示单）；
 * - `all`（全部）= 所有单据（含已决与 agent↔agent —— 用户超级观察者可读）。
 * 最新在前（`created_at DESC`）；**同毫秒并列以 `rowid` 定序**（插入顺序，后插入在前）——
 * `id` 是 `randomUUID()`，以其定序在同 `created_at` 时次序随机（E2E 实证 7.3% 反转），
 * 故以确定性的 `rowid`（单调自增，语义即插入序）替代。
 */
export function listNotifications(db: Db, scope: NotificationScope): Approval[] {
  const rows =
    scope === "actionable"
      ? db
          .prepare<[], ApprovalRow>(
            `SELECT * FROM approvals WHERE target = 'human' AND status = 'pending'
             ORDER BY created_at DESC, rowid DESC`,
          )
          .all()
      : db
          .prepare<[], ApprovalRow>("SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC")
          .all()
  return rows.map(toApproval)
}

/**
 * 已读标记（spec §11.5：单用户 MVP 全局已读，幂等）：仅首次置位 `read_at`，再次调用不变；
 * 返回本次是否新置位（供路由/UI 判定，不影响通知归属 —— 已读只影响未读徽标）。
 */
export function markRead(db: Db, id: string): boolean {
  const changes = db
    .prepare<{ id: string; now: number }, void>(
      "UPDATE approvals SET read_at = $now WHERE id = $id AND read_at IS NULL",
    )
    .run({ id, now: Date.now() }).changes
  return changes > 0
}
