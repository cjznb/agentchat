/**
 * 消息编排（spec §5.4/§6/§9 send·inbox·ack·conversation·shout）——
 * MCP 端点与 UI 路由共同调用的唯一业务编排层。
 *
 * - `to` 解析（brief Key facts）：`*` → 喊话广播会话；uuid → 既有会话（成员校验，
 *   human 超级观察者豁免）否则按 agent id 自动建/取 DM；未知 id → `RecipientNotFound`
 * - 四级回执为**派生**读取（决议 4）：`receiptState` = read_states → wake_jobs → queued；
 *   `read` 仅由 ack 触发，失败态不新增阶段（T6 经系统通知表达）
 * - `unreadFor` 双层聚合（决议 5）：自身全部会话（含喊话）+ 全部后代递归求和
 * - 权限闸门（spec §8，Task 7）：建群/拉人/喊话三个入口内调 `permissions.gate` 单点执法
 *   （决议 1：执行器以闭包传入，permissions 不反向依赖本层，无循环依赖）
 */
import type { ReceiptStage } from "../../shared/contracts"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  getAgent,
  listAgents,
  type Agent,
} from "../store/agents"
import {
  addParticipant as storeAddParticipant,
  createDm,
  createGroup as storeCreateGroup,
  directUnreadCounts,
  ensureShoutConversation,
  getConversation,
  getConversationByKey,
  isParticipant,
  listParticipants,
  SHOUT_KEY,
  type AddParticipantInput,
  type Conversation,
  type CreateGroupInput,
} from "../store/conversations"
import {
  DEFAULT_INBOX_LIMIT,
  getById,
  history as storeHistory,
  inboxMessages,
  send,
  type Message,
} from "../store/messages"
import { markRead } from "../store/read_states"
import { enqueueWakeJobs } from "../store/wake"
import { gate, type ApprovalRequested, type Gated } from "./permissions"
import { publishMessage, publishReceipt, receiptState } from "./publish"
import {
  INBOX_WAIT_CONVERSATION,
  messagesSince,
  waitFor,
  type WaitOptions,
  type WaitResult,
} from "./wait"

export { receiptState }

// human 身份（决议 2）实现已迁至 core/permissions（审批通道与人通道同层）；
// 此处保持既有导入路径（`core/messaging.ensureHuman`）不变。
export { ensureHuman } from "./permissions"

// 群原语（决议 6 → Task 7）：建群/拉人入口在此套审批闸门（`gate` 单点执法）。
export function createGroup(db: Db, input: CreateGroupInput): Gated<Conversation>
export function createGroup(db: Db, input: CreateGroupInput): Conversation | ApprovalRequested {
  const payload = { name: input.name, memberIds: input.memberIds ?? [] }
  const outcome = gate(db, "group_create", input.createdBy, payload, () => storeCreateGroup(db, input))
  return "approval" in outcome ? outcome : outcome.approved
}

export function addParticipant(db: Db, input: AddParticipantInput): ApprovalRequested | void {
  const actorId = input.invitedBy ?? getConversation(db, input.conversationId)?.createdBy ?? ""
  const payload = { conversationId: input.conversationId, agentId: input.agentId, role: input.role }
  const outcome = gate(db, "group_add", actorId, payload, () => storeAddParticipant(db, input))
  return "approval" in outcome ? outcome : undefined
}

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
  /** 阻塞等待（spec §6.2）；给出则 `sendMessage` 返回 Promise 并带 `reply`。 */
  readonly wait?: WaitOptions
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
 *
 * 带 `wait`（spec §6.2 三模式）时返回 Promise：投递结果附 `reply`
 * `{timedOut, messages, receipts}`——超时也带回等待期间已收部分（非空手）。
 */
export function sendMessage(
  db: Db,
  input: SendMessageInput & { readonly wait: WaitOptions },
): Promise<SendMessageResult & { readonly reply: WaitResult<Receipt> }>
export function sendMessage(db: Db, input: SendMessageInput): SendMessageResult
export function sendMessage(
  db: Db,
  input: SendMessageInput,
): SendMessageResult | Promise<SendMessageResult & { readonly reply: WaitResult<Receipt> }> {
  const result = deliver(db, input)
  if (input.wait === undefined) return result
  const { message, receipts } = result
  const baseline = new Map(receipts.map((r) => [r.agentId, r.stage] as const))
  return waitFor<Receipt>(
    {
      conversationId: message.conversationId,
      waiterId: input.from,
      checkMessages: () =>
        messagesSince(db, {
          conversationId: message.conversationId,
          waiterId: input.from,
          afterSeq: message.seq,
        }),
      checkReceipts: () =>
        receipts
          .map((r) => ({ agentId: r.agentId, stage: receiptState(db, message, r.agentId) }))
          .filter((r) => baseline.get(r.agentId) !== r.stage),
    },
    input.wait,
  ).then((reply) => ({ ...result, reply }))
}

/** 同步投递核心（无 `wait` 路径与 `wait` 路径共用）：入库后发布消息事件（决议 5 发布点 1）。 */
function deliver(db: Db, input: SendMessageInput): SendMessageResult {
  const sender = getAgent(db, input.from)
  if (sender === undefined) throw new AgentNotFoundError(input.from)
  const conversation = resolveConversation(db, sender, input.to)
  const message = send(db, {
    conversationId: conversation.id,
    fromAgentId: input.from,
    body: input.body,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  })
  publishMessage(conversation.id)
  const recipientIds = recipientsOf(db, conversation, input.from)
  // 发送即生成唤醒任务（Task 6；资格与适配器门控见 store/wake.enqueueWakeJobs）。
  enqueueWakeJobs(db, { messageId: message.seq, recipientIds })
  const receipts = recipientIds.map((agentId) => ({
    agentId,
    stage: receiptState(db, message, agentId),
  }))
  return { message, receipts }
}

/** 喊话（`to='*'`）：写入唯一广播会话，全部节点收件箱可见（决议 3）；入口经 `gate`（Task 7）。 */
export function shout(db: Db, from: string, body: string): Gated<SendMessageResult>
export function shout(db: Db, from: string, body: string): SendMessageResult | ApprovalRequested {
  const outcome = gate(db, "shout", from, { body }, () => sendMessage(db, { from, to: "*", body }))
  return "approval" in outcome ? outcome : outcome.approved
}

export interface InboxOptions {
  /** 游标（seq，不含）；缺省 0 = 从头。 */
  readonly after?: number
  readonly limit?: number
  /** 阻塞等待（spec §9 `inbox.timeout` = §6.2 语义）；给出则返回 Promise 的等待结果。 */
  readonly wait?: WaitOptions
}

/**
 * 收件箱：可见会话（参与 + 喊话）中游标之后的消息，全局 seq 升序。
 * 带 `wait` 时挂起至新消息先到（`received` 模式无回执事件可言 → 恒超时），返回
 * `{timedOut, messages, receipts}`（决议 6：inbox 委托 wait.ts；receipts 恒为 []）。
 */
export function inbox(
  db: Db,
  agentId: string,
  options: InboxOptions & { readonly wait: WaitOptions },
): Promise<WaitResult<never>>
export function inbox(db: Db, agentId: string, options?: InboxOptions): Message[]
export function inbox(
  db: Db,
  agentId: string,
  options: InboxOptions = {},
): Message[] | Promise<WaitResult<never>> {
  const page = (): Message[] =>
    inboxMessages(db, {
      agentId,
      shoutConversationId: shoutConversationId(db),
      after: options.after ?? 0,
      limit: options.limit ?? DEFAULT_INBOX_LIMIT,
    })
  if (options.wait === undefined) return page()
  return waitFor<never>(
    {
      conversationId: INBOX_WAIT_CONVERSATION,
      waiterId: agentId,
      checkMessages: () => page().filter((m) => m.fromAgentId !== agentId),
      checkReceipts: () => [],
    },
    options.wait,
  )
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
  // 回执事件发布（决议 5 发布点 2：ack 之后，事务提交、复查可见）。
  for (const conversationId of latestByConversation.keys()) publishReceipt(conversationId)
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

// 四级回执派生 `receiptState` 与 wake 状态映射在 publish.ts（回执事件源），
// 本模块顶部 `export { receiptState }` 保持既有导入路径不变。
