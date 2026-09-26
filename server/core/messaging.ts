/**
 * 消息编排（spec §5.4/§6/§9 send·inbox·ack·conversation·shout）——
 * MCP 端点与 UI 路由共同调用的唯一业务编排层。
 *
 * - `to` 解析（brief Key facts）：`*` → 喊话广播会话；uuid → 既有会话（成员校验，
 *   human 超级观察者豁免）否则按 agent id 自动建/取 DM；未知 id → `RecipientNotFound`
 * - 四级回执为**派生**读取（决议 4）：`receiptState` = read_states → wake_jobs → queued；
 *   `read` 仅由 ack 触发，失败态不新增阶段（T6 经系统通知表达）
 * - `unreadFor` 双层聚合（决议 5）：自身全部会话（含喊话）+ 全部后代递归求和
 * - 权限闸门不在本层（决议 6）：建群/拉人/喊话的审批由 Task 7 在这些入口外包裹
 */
import { z } from "zod"
import type { ReceiptStage } from "../../shared/contracts"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  getAgent,
  getAgentByName,
  insertAgent,
  listAgents,
  type Agent,
} from "../store/agents"
import {
  createDm,
  directUnreadCounts,
  ensureShoutConversation,
  getConversation,
  getConversationByKey,
  isParticipant,
  listParticipants,
  SHOUT_KEY,
  type Conversation,
} from "../store/conversations"
import {
  DEFAULT_INBOX_LIMIT,
  getById,
  history as storeHistory,
  inboxMessages,
  send,
  type Message,
} from "../store/messages"
import { getReadState, markRead } from "../store/read_states"

// 群原语（决议 6：本任务不带闸门）。Task 7 在此入口外包裹审批闸门。
export { addParticipant, createGroup } from "../store/conversations"

const HUMAN_NAME = "用户"

/** `to` 解析失败：既非 `*`、也找不到会话或节点（brief：未知 id → RecipientNotFound）。 */
export class RecipientNotFound extends Error {
  readonly code = "recipient_not_found"
  constructor(readonly recipientId: string) {
    super(`recipient not found: ${recipientId}`)
    this.name = "RecipientNotFound"
  }
}

/** 非成员向既有会话发消息（成员表即授权边界，决议 1；human 豁免）。 */
export class NotParticipantError extends Error {
  readonly code = "not_participant"
  constructor(
    readonly agentId: string,
    readonly conversationId: string,
  ) {
    super(`agent ${agentId} is not a participant of conversation ${conversationId}`)
    this.name = "NotParticipantError"
  }
}

/**
 * human 身份（决议 2）：FK 要求 agents 行 —— 幂等创建
 * `{kind:"logical", vendor:"human", name:"用户", status:"offline"}`；human 可读发任意会话。
 */
export function ensureHuman(db: Db): Agent {
  const existing = getAgentByName(db, HUMAN_NAME)
  if (existing !== undefined) return existing
  return insertAgent(db, { name: HUMAN_NAME, kind: "logical", vendor: "human", status: "offline" })
}

function isHuman(agent: Agent): boolean {
  return agent.vendor === "human"
}

/** 喊话广播会话 id；尚不存在时为 `""`（该哨兵在 SQL 中恒不匹配真实会话 id）。 */
function shoutConversationId(db: Db): string {
  return getConversationByKey(db, SHOUT_KEY)?.id ?? ""
}

/** `to` 解析：`*` → 喊话广播会话；既有会话直用（成员校验）；否则按 agent id 自动建/取 DM。 */
function resolveConversation(db: Db, sender: Agent, to: string): Conversation {
  if (to === "*") return ensureShoutConversation(db, sender.id)
  const existing = getConversation(db, to)
  if (existing !== undefined) {
    if (!isHuman(sender) && !isParticipant(db, existing.id, sender.id)) {
      throw new NotParticipantError(sender.id, existing.id)
    }
    return existing
  }
  if (getAgent(db, to) === undefined) throw new RecipientNotFound(to)
  return createDm(db, sender.id, to)
}

/** 收件方：DM/群 = 其余成员；喊话 = 全部节点（决议 3）。均不含发送者本人。 */
function recipientsOf(db: Db, conversation: Conversation, senderId: string): readonly string[] {
  const ids =
    conversation.key === SHOUT_KEY
      ? listAgents(db).map((agent) => agent.id)
      : listParticipants(db, conversation.id).map((participant) => participant.agentId)
  return ids.filter((id) => id !== senderId)
}

export interface SendMessageInput {
  readonly from: string
  readonly to: string
  readonly body: string
  readonly idempotencyKey?: string
}

/** 单收件方回执（四级锁枚举来自 shared/contracts，禁止另立）。 */
export interface Receipt {
  readonly agentId: string
  readonly stage: ReceiptStage
}

export interface SendMessageResult {
  readonly message: Message
  readonly receipts: readonly Receipt[]
}

/**
 * 发送一条消息并返回入库消息与各收件方的当前回执（决议 4：回执是派生读取，
 * 发送时无 wake_jobs 行 → 恒为 `queued`，即 DoD「发送即生成 queued 回执记录」）。
 */
export function sendMessage(db: Db, input: SendMessageInput): SendMessageResult {
  const sender = getAgent(db, input.from)
  if (sender === undefined) throw new AgentNotFoundError(input.from)
  const conversation = resolveConversation(db, sender, input.to)
  const message = send(db, {
    conversationId: conversation.id,
    fromAgentId: input.from,
    body: input.body,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  })
  const receipts = recipientsOf(db, conversation, input.from).map((agentId) => ({
    agentId,
    stage: receiptState(db, message, agentId),
  }))
  return { message, receipts }
}

/** 喊话（`to='*'`）：写入唯一广播会话，全部节点收件箱可见（决议 3）。 */
export function shout(db: Db, from: string, body: string): SendMessageResult {
  return sendMessage(db, { from, to: "*", body })
}

export interface InboxOptions {
  /** 游标（seq，不含）；缺省 0 = 从头。 */
  readonly after?: number
  readonly limit?: number
}

/** 收件箱：可见会话（参与 + 喊话）中游标之后的消息，全局 seq 升序。 */
export function inbox(db: Db, agentId: string, options: InboxOptions = {}): Message[] {
  return inboxMessages(db, {
    agentId,
    shoutConversationId: shoutConversationId(db),
    after: options.after ?? 0,
    limit: options.limit ?? DEFAULT_INBOX_LIMIT,
  })
}

/**
 * 显式已读（spec §9 `ack`）：按会话归组取给定消息的最大 seq，`BEGIN IMMEDIATE`
 * 内 upsert `read_states`（只前进，决议 4：`read` 仅由此触发）。返回确认到的条数。
 */
export function ack(db: Db, agentId: string, ids: readonly string[]): number {
  const latestByConversation = new Map<string, number>()
  let confirmed = 0
  for (const id of ids) {
    const message = getById(db, id)
    if (message === undefined) continue
    confirmed += 1
    const latest = latestByConversation.get(message.conversationId) ?? 0
    latestByConversation.set(message.conversationId, Math.max(latest, message.seq))
  }
  if (latestByConversation.size === 0) return 0
  db.transaction((): void => {
    for (const [conversationId, lastReadSeq] of latestByConversation) {
      markRead(db, { conversationId, agentId, lastReadSeq })
    }
  }).immediate()
  return confirmed
}

/**
 * 未读双层聚合（决议 5）：自身全部会话（含喊话广播）+ **全部后代**递归求和；
 * spec §11.3「根行徽标 = 根自身 + 嵌套子会话」即本递归的两层用例。
 */
export function unreadFor(db: Db, agentId: string): number {
  const direct = directUnreadCounts(db, shoutConversationId(db))
  const childrenByParent = new Map<string, string[]>()
  for (const agent of listAgents(db)) {
    if (agent.parentId === undefined) continue
    const siblings = childrenByParent.get(agent.parentId)
    if (siblings === undefined) childrenByParent.set(agent.parentId, [agent.id])
    else siblings.push(agent.id)
  }
  const walk = (id: string): number =>
    (direct.get(id) ?? 0) +
    (childrenByParent.get(id) ?? []).reduce((sum, childId) => sum + walk(childId), 0)
  return walk(agentId)
}

/** 会话历史分页（spec §9 `conversation`）：`before`（seq，不含）向上翻页，缺省最新一页。 */
export function history(
  db: Db,
  conversationId: string,
  before?: number,
  limit?: number,
): Message[] {
  return storeHistory(db, {
    conversationId,
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  })
}

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
