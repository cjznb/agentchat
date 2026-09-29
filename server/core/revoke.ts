/**
 * 撤回排队中消息（尽力撤回语义）—— Hub 核心编排。
 *
 * 用户已定：范围 = **尽力撤回**。未投递副本全部取消（job → cancelled）；已投递/已读副本
 * **保留原文**，但追加一条 `kind='system'` 提醒（让已收到的 agent 不要据此行动）。
 *
 * - 仅**发送方**可撤；消息不存在或不属于该会话 → `MessageNotFoundError`（404）
 * - 仅 `text` 可撤；`kind='system'` 提醒 → `NotRevocableError`（422，堵死通知自增链）
 * - 读路径经 `maskRevokedForReader` 对**未投递读者**遮蔽原文（发送者/已投递者不受影响）
 * - **幂等**：`revoked_at` 条件写一次落定，二次撤回直接返回旧时间戳、不落第二条提醒
 * - 只取消该消息 `pending`/`sending` 的 job；`accepted`/`refused`/`expired` 不动
 * - 撤回是**独立标记**（`messages.revoked_at`），**不新增第五级回执阶段**（四级回执不变）
 * - 复用既有发布点：`publishMessage` + `publishReceipt`（WS 四事件封套不新增）
 */
import type { Db } from "../db"
import { getConversation } from "../store/conversations"
import { getById, markRevoked, send, type Message } from "../store/messages"
import { getReadState } from "../store/read_states"
import { cancelJobsForMessage, enqueueWakeJobs, getWakeJob } from "../store/wake"
import { recipientsOf } from "./messaging"
import { publishMessage, publishReceipt } from "./publish"

/** 消息不存在，或不属于给定会话（404 `message_not_found`）。 */
export class MessageNotFoundError extends Error {
  readonly code = "message_not_found"
  constructor(readonly messageId: string) {
    super(`message not found: ${messageId}`)
    this.name = "MessageNotFoundError"
  }
}

/** 非发送方尝试撤回（403 `not_sender`）。 */
export class NotSenderError extends Error {
  readonly code = "not_sender"
  constructor(
    readonly messageId: string,
    readonly actorId: string,
  ) {
    super(`agent ${actorId} is not the sender of message ${messageId}`)
    this.name = "NotSenderError"
  }
}

/**
 * 非文本消息不可撤回（422 `not_revocable`）。
 * 提醒（`kind='system'`）的作者就是发起撤回的人，若允许撤回会在自己刚生成的提醒上再生成一条，
 * 形成通知自增链——故服务端**拒绝**一切非 `text` 消息。
 */
export class NotRevocableError extends Error {
  readonly code = "not_revocable"
  constructor(readonly messageId: string) {
    super(`message is not revocable (kind !== text): ${messageId}`)
    this.name = "NotRevocableError"
  }
}

/** 未投递副本读到撤回消息时的正文占位（原文不泄露；`revoked_at` 仍随出参供前端渲染「已撤回」）。 */
export const REVOKED_BODY_PLACEHOLDER = "（此消息已被发送方撤回）"

/**
 * 读路径正文遮蔽（MCP `inbox`/`conversation`/`send·shout` 的 `wait` 回复与 UI 会话消息接口共用）：
 * 对**未投递读者**隐藏撤回消息原文，保留 `revoked_at`（供前端渲染「已撤回」）。
 *
 * 判定为「已投递 / 已读」= job `accepted`（**仅** `/internal/result delivered` 派生的成功终态）
 * **或** `read_states` 已覆盖该消息（读者已 ack）→ 原文保留。
 * 其余（无 job / `pending` / `sending` / `cancelled` / `expired` / `refused`）一律视为未投递 → 遮蔽：
 * 从未成功投递过的终态（`expired` 忙碌 24h、`refused` 连续拒收）与在途态一视同仁。
 * **发送者**（`from_agent_id === readerId`）恒原样返回。
 */
export function maskRevokedForReader(db: Db, message: Message, readerId: string): Message {
  if (message.revokedAt === undefined || message.fromAgentId === readerId) return message
  return deliveredOrRead(db, message, readerId)
    ? message
    : { ...message, body: REVOKED_BODY_PLACEHOLDER }
}

/** 已投递（job `accepted`）或已读（`read_states.last_read_seq >= seq`）——单一判定点。 */
function deliveredOrRead(db: Db, message: Message, readerId: string): boolean {
  if (getWakeJob(db, message.seq, readerId)?.state === "accepted") return true
  const read = getReadState(db, message.conversationId, readerId)
  return read !== undefined && read.lastReadSeq >= message.seq
}

export interface RevokeInput {
  readonly conversationId: string
  readonly messageId: string
  /** 撤回发起方（UI = human），须等于原消息 `from_agent_id`。 */
  readonly actorId: string
  readonly now: number
}

/** 提醒正文摘要上限（原始正文压缩空白后截断）。 */
const NOTICE_SUMMARY_CHARS = 40

function noticeBody(body: string): string {
  const summary = body.replace(/\s+/g, " ").trim().slice(0, NOTICE_SUMMARY_CHARS)
  return `（系统）此消息已被发送方撤回：${summary === "" ? "（无正文）" : summary}`
}

/**
 * 撤回一条消息，返回其 `revoked_at`（幂等：已撤回则返回既有时间戳）。
 * 事务内：置 `revoked_at`（条件写）→ 取消未投递 job → 落一条 system 提醒（并为其建 job）。
 */
export function revokeMessage(db: Db, input: RevokeInput): number {
  const message = getById(db, input.messageId)
  if (message === undefined || message.conversationId !== input.conversationId) {
    throw new MessageNotFoundError(input.messageId)
  }
  if (message.fromAgentId !== input.actorId) {
    throw new NotSenderError(input.messageId, input.actorId)
  }
  // 仅文本可撤回：提醒（system）作者即撤回者，撤回它会在自身之上再生成一条（通知自增链）。
  if (message.kind !== "text") {
    throw new NotRevocableError(input.messageId)
  }
  const conversation = getConversation(db, message.conversationId)
  const recipientIds =
    conversation === undefined ? [] : recipientsOf(db, conversation, input.actorId)

  const changed = db
    .transaction((): boolean => {
      if (markRevoked(db, { id: message.id, now: input.now }) === 0) return false
      cancelJobsForMessage(db, message.seq, "Revoked")
      const notice = send(db, {
        conversationId: message.conversationId,
        fromAgentId: input.actorId,
        kind: "system",
        meta: { reason: "revoke", revokedMessageId: message.id },
        body: noticeBody(message.body),
        idempotencyKey: `revoke:${message.id}`,
      })
      // 提醒自身按普通消息投递（生成自己的 job），供已收到原消息的 agent 刷新认知。
      enqueueWakeJobs(db, { messageId: notice.seq, recipientIds, now: input.now })
      return true
    })
    .immediate()

  if (!changed) return message.revokedAt ?? input.now
  publishMessage(db, message.conversationId)
  publishReceipt(db, message.conversationId)
  return input.now
}
