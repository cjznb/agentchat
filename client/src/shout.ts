/**
 * 喊话投递汇总纯函数（spec §11.4「发出后显示每节点投递汇总（在线 N / 排队 M / 离场 X）」；Plan 3 T7）。
 *
 * 把 `POST /api/shout` 或会话历史里逐收件方的回执（`ReceiptView`）聚合为三桶：
 * - `delivered | read`                         → 在线
 * - `queued | sending`                         → 排队
 * - `failed | refused | expired | cancelled`   → 离场
 *
 * 契约锁定的四级阶段（`RECEIPT_STAGES`）只覆盖前两桶；后两类与「未知」为**前向兼容**：
 * `stage` 放宽为 `string`，契约外的新阶段计入 `unknown` 并保留在 `total` 内——
 * 绝不静默丢弃任何收件方（未知计数由视图显式呈现、报告注明）。
 */

/** 参与汇总的最小回执形状（结构兼容 `ReceiptView`）。 */
export interface ShoutDelivery {
  readonly agentId: string
  readonly stage: string
}

/** 投递汇总（各桶计数之和恒等于 `total`）。 */
export interface ShoutSummary {
  readonly online: number
  readonly queued: number
  readonly left: number
  readonly unknown: number
  readonly total: number
}

const ONLINE_STAGES = new Set(["delivered", "read"])
const QUEUED_STAGES = new Set(["queued", "sending"])
const LEFT_STAGES = new Set(["failed", "refused", "expired", "cancelled"])

/** 逐收件方回执 → 在线 / 排队 / 离场 / 未知（纯函数；空数组 → 全零）。 */
export function summarizeShout(deliveries: readonly ShoutDelivery[]): ShoutSummary {
  let online = 0
  let queued = 0
  let left = 0
  let unknown = 0
  for (const delivery of deliveries) {
    if (ONLINE_STAGES.has(delivery.stage)) online += 1
    else if (QUEUED_STAGES.has(delivery.stage)) queued += 1
    else if (LEFT_STAGES.has(delivery.stage)) left += 1
    else unknown += 1
  }
  return { online, queued, left, unknown, total: deliveries.length }
}
