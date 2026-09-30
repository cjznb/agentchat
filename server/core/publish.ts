/**
 * 回执派生与等待事件发布钩子（spec §6.3；Task 5 决议 4/5）。
 *
 * 从 `messaging.ts` 抽出（controller 授权偏差，保持编排层 ≤250 纯 LOC）：
 * - 四级回执派生 `receiptState`（`read_states` → `wake_jobs` → `queued`）；
 *   `accepted` 只由 `/internal/result delivered` 产生（pull 认领仅置 `sending` 租约）
 * - 两个事件发布点的小钩子：`sendMessage` 入库后 → `publishMessage`；
 *   `ack` 事务提交后 → `publishReceipt`（均委托 `wait.publish`，同步 bump+notify）
 */
import { z } from "zod"
import type { ReceiptStage } from "../../shared/contracts"
import type { Db } from "../db"
import { latestInConversation, type Message } from "../store/messages"
import { getReadState } from "../store/read_states"
import { emit } from "../ws"
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
 * 否则看该收件方的 wake_jobs 行：`sending`（pull 在途租约）→ `sending`，
 * `accepted`（**仅** `/internal/result delivered` 派生）→ `delivered`，其余 → `queued`；
 * 无行 → `queued`。每收件方独立、互不串扰。
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

/**
 * 回执收件人集合（spec §14.2 唯一来源）：该消息 `wake_jobs` 行的 agent 集合（= T）。
 * 读时一律以此为准（send 时已与 `enqueueWakeJobs` 同源同一数组）；无行 → 空集。
 * DM / 喊话 / 人类不带@ 时 jobs 即原全员 → 行为逐字节不变；被@群聊只回执被@者。
 */
export function wakeRecipients(db: Db, messageId: number): readonly string[] {
  return db
    .prepare<[number], { agent_id: string }>(
      "SELECT agent_id FROM wake_jobs WHERE message_id = ? ORDER BY rowid",
    )
    .all(messageId)
    .map((row) => row.agent_id)
}

/**
 * 消息事件发布（决议 5 发布点 1：`sendMessage` 入库后）——
 * 同步 bump+notify（wait.ts）+ 构造 `message` WS 载荷（Task 9）。
 */
export function publishMessage(db: Db, conversationId: string): void {
  publish(conversationId, "message")
  const message = latestInConversation(db, conversationId)
  if (message === undefined) return
  emit("message", {
    conversationId,
    messageId: message.id,
    seq: message.seq,
    from: message.fromAgentId,
    body: message.body,
    kind: message.kind,
    createdAt: message.createdAt,
  })
}

/**
 * 回执事件发布（决议 5 发布点 2：`ack` 事务提交后）——
 * 同步 bump+notify + `receipt` WS 载荷（Task 9：最新消息 id + 各收件方当前 stage）。
 */
export function publishReceipt(db: Db, conversationId: string): void {
  publish(conversationId, "receipt")
  const message = latestInConversation(db, conversationId)
  if (message === undefined) return
  emit("receipt", {
    conversationId,
    messageId: message.id,
    seq: message.seq,
    receipts: wakeRecipients(db, message.seq).map((agentId) => ({
      agentId,
      stage: receiptState(db, message, agentId),
    })),
  })
}

/** 单会话批量回执：`(message.seq, agentId) → stage` 的内存映射。 */
export type ReceiptStageMap = ReadonlyMap<number, ReadonlyMap<string, ReceiptStage>>

/**
 * 每请求一次批量回执派生（Plan 3 T5 复审 I3 + spec §14.2 集合口径）：一次读该会话的
 * `read_states`，一次按「本页消息 seq」读 `wake_jobs`，再内存映射。**收件人集合 =
 * 各消息 wake_jobs 行**（唯一来源，不再由调用方传入全员枚举）；语义与逐条
 * `receiptState` 逐字一致（`read_states.last_read_seq ≥ seq → read`；否则 wake 映射；
 * 无行 → 该收件方不在集合），仅把每个 own 消息的 O(M) 查询降为**每请求常数次**（O(N+M) 内存）。
 */
export function batchReceiptStates(
  db: Db,
  conversationId: string,
  messages: readonly Message[],
): ReceiptStageMap {
  const result = new Map<number, Map<string, ReceiptStage>>()
  if (messages.length === 0) return result
  const readRows = db
    .prepare<[string], { agent_id: string; last_read_seq: number }>(
      "SELECT agent_id, last_read_seq FROM read_states WHERE conversation_id = ?",
    )
    .all(conversationId)
  const readByAgent = new Map(readRows.map((row) => [row.agent_id, row.last_read_seq] as const))
  const seqPlaceholders = messages.map(() => "?").join(", ")
  const jobRows = db
    .prepare<unknown[], { messageId: number; agentId: string; state: string }>(
      `SELECT message_id AS messageId, agent_id AS agentId, state FROM wake_jobs
       WHERE message_id IN (${seqPlaceholders})`,
    )
    .all(...messages.map((message) => message.seq))
  const jobStage = new Map<string, ReceiptStage>()
  const agentsByMessage = new Map<number, string[]>()
  for (const row of jobRows) {
    jobStage.set(`${row.messageId}:${row.agentId}`, WAKE_STATE_STAGE[wakeStateSchema.parse(row.state)])
    const agents = agentsByMessage.get(row.messageId)
    if (agents === undefined) agentsByMessage.set(row.messageId, [row.agentId])
    else if (!agents.includes(row.agentId)) agents.push(row.agentId)
  }
  for (const message of messages) {
    const perAgent = new Map<string, ReceiptStage>()
    for (const agentId of agentsByMessage.get(message.seq) ?? []) {
      const readSeq = readByAgent.get(agentId)
      const stage: ReceiptStage =
        readSeq !== undefined && readSeq >= message.seq
          ? "read"
          : (jobStage.get(`${message.seq}:${agentId}`) ?? "queued")
      perAgent.set(agentId, stage)
    }
    result.set(message.seq, perAgent)
  }
  return result
}
