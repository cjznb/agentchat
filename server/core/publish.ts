/**
 * 回执派生与等待事件发布钩子（spec §6.3；Task 5 决议 4/5）。
 *
 * 从 `messaging.ts` 抽出（controller 授权偏差，保持编排层 ≤250 纯 LOC）：
 * - 四级回执派生 `receiptState`（`read_states` → `wake_jobs` → `queued`）
 * - 两个事件发布点的小钩子：`sendMessage` 入库后 → `publishMessage`；
 *   `ack` 事务提交后 → `publishReceipt`（均委托 `wait.publish`，同步 bump+notify）
 */
import { z } from "zod"
import type { ReceiptStage } from "../../shared/contracts"
import type { Db } from "../db"
import type { Message } from "../store/messages"
import { getReadState } from "../store/read_states"
import { publish } from "./wait"

// wake_jobs 状态镜像 schema.sql 的 CHECK（Task 6 落 store 后收敛到 store/wake）。
const wakeStateSchema = z.enum([
  "pending",
  "sending",
  "accepted",
  "refused",
  "expired",
  "cancelled",
])

/** wake_jobs 状态 → 四级回执（决议 4：失败态回 `queued`，不新增阶段）。 */
const WAKE_STATE_STAGE: Record<z.infer<typeof wakeStateSchema>, ReceiptStage> = {
  pending: "queued",
  sending: "sending",
  accepted: "delivered",
  refused: "queued",
  expired: "queued",
  cancelled: "queued",
}

/**
 * 四级回执派生（决议 4）：`read_states.last_read_seq ≥ seq` → `read`（仅 ack 触发）；
 * 否则看该收件方的 wake_jobs 行（T6 前恒无行 → `queued`）。每收件方独立、互不串扰。
 */
export function receiptState(db: Db, message: Message, recipient: string): ReceiptStage {
  const read = getReadState(db, message.conversationId, recipient)
  if (read !== undefined && read.lastReadSeq >= message.seq) return "read"
  const job = db
    .prepare<[number, string], { state: string }>(
      "SELECT state FROM wake_jobs WHERE message_id = ? AND agent_id = ?",
    )
    .get(message.seq, recipient)
  return job === undefined ? "queued" : WAKE_STATE_STAGE[wakeStateSchema.parse(job.state)]
}

/** 消息事件发布（决议 5 发布点 1：`sendMessage` 入库后）。 */
export function publishMessage(conversationId: string): void {
  publish(conversationId, "message")
}

/** 回执事件发布（决议 5 发布点 2：`ack` 事务提交后）。 */
export function publishReceipt(conversationId: string): void {
  publish(conversationId, "receipt")
}
