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
import { resolveMentions, type MentionTarget, type MentionsEcho } from "../../shared/mentions"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  agentDisplayName,
  getAgent,
  listAgents,
  type Agent,
} from "../store/agents"
import {
  addParticipant as storeAddParticipant,
  createDm,
  createGroup as storeCreateGroup,
  directUnreadSeqs,
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
  latestInConversation,
  send,
  type Message,
} from "../store/messages"
import { markRead } from "../store/read_states"
import { enqueueWakeJobs } from "../store/wake"
import { getApproval, type Approval } from "../store/approvals"
import { approvalChannel, gate, postSystem, type Gated } from "./permissions"
import { publishMessage, publishReceipt, receiptState } from "./publish"
import {
  DEFAULT_WAIT_TIMEOUT_MS,
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

// 群原语（决议 6 → Task 7）：建群/拉人入口在此套审批闸门（`gate` 单点执法）；
// 返回与 `GateOutcome` 同构的判别联合（裁决 D2），调用方以 `"approved" in result` 解包。
export function createGroup(db: Db, input: CreateGroupInput): Gated<Conversation> {
  const payload = { name: input.name, memberIds: input.memberIds ?? [] }
  return gate(db, "group_create", input.createdBy, payload, () => storeCreateGroup(db, input))
}

/**
 * 入群系统通知（Task 5，spec §4.4）：拉人成功后给该会话落一条 `kind:"system"` 消息，
 * 正文含「你被拉入群「X」。成员：<名>(<id前8>)、…」名单（新增成员在列）。
 * 复用 `postSystem`（`store send` 直写 + message publish）—— **不经 `enqueueWakeJobs`**：
 * `kind:"system"` 豁免即既有语义，入群通知 0 wake job（测试回归锁）。
 */
function joinNotice(db: Db, input: AddParticipantInput): void {
  const conversation = getConversation(db, input.conversationId)
  // store 写入已过 participants 外键 → 会话必在；此处仅类型收窄（不可达分支）。
  if (conversation === undefined) return
  const roster = listParticipants(db, conversation.id).flatMap((participant) => {
    const agent = getAgent(db, participant.agentId)
    return agent === undefined ? [] : [`${agentDisplayName(agent)}(${agent.id.slice(0, 8)})`]
  })
  postSystem(db, {
    conversationId: conversation.id,
    fromAgentId: input.invitedBy ?? conversation.createdBy,
    body: `你被拉入群「${conversation.name ?? conversation.key}」。成员：${roster.join("、")}`,
    meta: { action: "group_add", agentId: input.agentId },
    idempotencyKey: `group-add:${conversation.id}:${input.agentId}`,
  })
}

/**
 * 拉人落地（store 写入 + 入群通知）的**唯一业务路径**：闸内执行器与「已批准执行」
 *（`routes/ui.ts.executeApproved` 的 group_add 分支）共用 —— 即时与审批两条入口
 * 一条业务，通知逻辑不复制。
 */
export function applyAddParticipant(db: Db, input: AddParticipantInput): void {
  storeAddParticipant(db, input)
  joinNotice(db, input)
}

export function addParticipant(db: Db, input: AddParticipantInput): Gated<void> {
  const actorId = input.invitedBy ?? getConversation(db, input.conversationId)?.createdBy ?? ""
  const payload = { conversationId: input.conversationId, agentId: input.agentId, role: input.role }
  return gate(db, "group_add", actorId, payload, () => applyAddParticipant(db, input))
}

/** `to` 解析失败：既非 `*`、也找不到会话或节点（brief：未知 id → RecipientNotFound）。 */
export class RecipientNotFound extends Error {
  readonly code = "recipient_not_found"
  constructor(readonly recipientId: string) {
    super(`recipient not found: ${recipientId}`)
    this.name = "RecipientNotFound"
  }
}

/**
 * 以**分组容器**（`role_tag === "container"`，如 `opencode@<host>` 实例节点）为收件方的 DM 被拒
 * （`container_not_chat_target`）。容器只是抽象分组、不是聊天实体：其会话不得出现在聊天栏、
 * 也不得作为回复来源。内部系统消息（`kind==='system'`）经 `store/messages.send` 直写，不经此守卫，
 * 故投递失败/撤回提醒等不受限。
 */
export class ContainerNotChatTargetError extends Error {
  readonly code = "container_not_chat_target"
  constructor(readonly containerId: string) {
    super(`container ${containerId} is a grouping container, not a chat target`)
    this.name = "ContainerNotChatTargetError"
  }
}

/** 分组容器判定（`role_tag === "container"`；adapter 注册实例节点时标记）。 */
export function isContainer(agent: Agent): boolean {
  return agent.roleTag === "container"
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

/** 发起对自身的发送（无意义，显式拒绝）—— 与 `SelfAskError`（self_ask）同风格先例。 */
export class SelfSendError extends Error {
  readonly code = "self_send"
  constructor(readonly agentId: string) {
    super(`agent ${agentId} cannot send a message to itself`)
    this.name = "SelfSendError"
  }
}

function isHuman(agent: Agent): boolean {
  return agent.vendor === "human"
}

/** 喊话广播会话 id；尚不存在时为 `""`（该哨兵在 SQL 中恒不匹配真实会话 id）。 */
function shoutConversationId(db: Db): string {
  return getConversationByKey(db, SHOUT_KEY)?.id ?? ""
}

/**
 * DM 收件方含分组容器 → 拒绝（容器只作分组，不是聊天实体）；群/喊话不在此限
 * （喊话的收件方集合由 `recipientsOf` 主动排除容器）。
 */
function assertNoContainerTarget(db: Db, conversation: Conversation): void {
  if (conversation.kind !== "dm") return
  for (const participant of listParticipants(db, conversation.id)) {
    const agent = getAgent(db, participant.agentId)
    if (agent !== undefined && isContainer(agent)) throw new ContainerNotChatTargetError(agent.id)
  }
}

/** `to` 解析：`*` → 喊话广播会话；既有会话直用（成员校验）；否则按 agent id 自动建/取 DM。 */
function resolveConversation(db: Db, sender: Agent, to: string): Conversation {
  if (to === "*") return ensureShoutConversation(db, sender.id)
  const existing = getConversation(db, to)
  if (existing !== undefined) {
    if (!isHuman(sender) && !isParticipant(db, existing.id, sender.id)) {
      throw new NotParticipantError(sender.id, existing.id)
    }
    assertNoContainerTarget(db, existing)
    return existing
  }
  const recipient = getAgent(db, to)
  if (recipient === undefined) throw new RecipientNotFound(to)
  if (isContainer(recipient)) throw new ContainerNotChatTargetError(recipient.id)
  return createDm(db, sender.id, to)
}

/**
 * 收件方：DM/群 = 其余成员；喊话 = 全部节点（决议 3）。**分组容器恒排除**
 * （容器不是聊天实体，不应产生回执/唤醒任务 —— M1 喊话既有、Task 3 延伸至群成员）。
 * 均不含发送者本人。
 */
export function recipientsOf(db: Db, conversation: Conversation, senderId: string): readonly string[] {
  const ids =
    conversation.key === SHOUT_KEY
      ? listAgents(db)
          .filter((agent) => !isContainer(agent))
          .map((agent) => agent.id)
      : listParticipants(db, conversation.id)
          .map((participant) => participant.agentId)
          .filter((id) => {
            // 群/DM 成员含分组容器时同样排除（Task 3 延伸 M1）；agent 行缺失 → 非容器。
            const agent = getAgent(db, id)
            return agent === undefined || !isContainer(agent)
          })
  return ids.filter((id) => id !== senderId)
}

export interface SendMessageInput {
  readonly from: string
  readonly to: string
  readonly body: string
  readonly idempotencyKey?: string
  /** 结构化提及（spec §3.1）：名字 / id / id 前 8 位 / `"*"`；仅群会话参与解析。 */
  readonly mentions?: string[] | undefined
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
  /** 提及回声（spec §3.2/§3.3；仅群会话产出 → DM/喊话出参逐字节不变）。 */
  readonly mentions?: MentionsEcho | undefined
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

/** 唤醒路由结果：T（进 `enqueueWakeJobs`）+ 群会话的 `messages.meta` 与提及回声。 */
interface WakeRoute {
  readonly wakeIds: readonly string[]
  readonly meta: Record<string, unknown> | undefined
  readonly mentions: MentionsEcho | undefined
}

/**
 * 唤醒集合 T（spec §2，Task 3）：仅**普通群**（kind=group 且 key≠shout）解析提及并
 * 落 `messages.meta`；DM/喊话不走此路由（语义逐字节不变，T = 既有收件方）。
 * 规则：M（=命中 matched）为唤醒集；M 空时人类 → 全体参与者、agent → ∅；
 * 发送者恒排除；分组容器在参与者映射阶段即排除（不是聊天实体，不可提及/唤醒，M1）。
 * 解析只经 `resolveMentions`（Task 1 单点）。
 */
function routeWake(
  db: Db,
  input: {
    readonly conversation: Conversation
    readonly sender: Agent
    readonly body: string
    readonly mentions: string[] | undefined
    readonly recipientIds: readonly string[]
  },
): WakeRoute {
  const { conversation, sender } = input
  if (conversation.kind !== "group" || conversation.key === SHOUT_KEY) {
    return { wakeIds: input.recipientIds, meta: undefined, mentions: undefined }
  }
  const targets: MentionTarget[] = []
  for (const participant of listParticipants(db, conversation.id)) {
    const agent = getAgent(db, participant.agentId)
    if (agent === undefined || isContainer(agent)) continue
    targets.push({ id: agent.id, name: agentDisplayName(agent) })
  }
  const echo = resolveMentions({ body: input.body, mentions: input.mentions, participants: targets })
  const mentioned = echo.matched.map((target) => target.id)
  const base =
    mentioned.length > 0
      ? mentioned
      : isHuman(sender)
        ? targets.map((target) => target.id)
        : []
  const wakeIds = base.filter((id) => id !== sender.id)
  return { wakeIds, meta: { mentions: mentioned, mentionScope: echo.scope }, mentions: echo }
}

/** 同步投递核心（无 `wait` 路径与 `wait` 路径共用）：入库后发布消息事件（决议 5 发布点 1）。 */
function deliver(db: Db, input: SendMessageInput): SendMessageResult {
  // 自发消息守卫（BUG-SELF-SEND）：先于一切解析单点拒绝，MCP 与 HTTP 两径共用。
  if (input.to === input.from) {
    console.warn(`[agentchat] self-send rejected (agent=${input.from})`)
    throw new SelfSendError(input.from)
  }
  const sender = getAgent(db, input.from)
  if (sender === undefined) throw new AgentNotFoundError(input.from)
  const conversation = resolveConversation(db, sender, input.to)
  const recipientIds = recipientsOf(db, conversation, input.from)
  const route = routeWake(db, {
    conversation,
    sender,
    body: input.body,
    mentions: input.mentions,
    recipientIds,
  })
  const message = send(db, {
    conversationId: conversation.id,
    fromAgentId: input.from,
    body: input.body,
    ...(route.meta === undefined ? {} : { meta: route.meta }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  })
  publishMessage(db, conversation.id)
  // 发送即按 T 生成唤醒任务（Task 3/6；资格见 store/wake.enqueueWakeJobs：runtime+online/busy）。
  enqueueWakeJobs(db, { messageId: message.seq, recipientIds: route.wakeIds })
  // 回执收件人集合 = 同一 T 数组（spec §14.2）：与 enqueueWakeJobs 同源同一数组，
  // 不再按 recipientsOf 全员枚举 —— 无任务成员恒 queued 会把「取最落后」聚合拖死。
  const receipts = route.wakeIds.map((agentId) => ({
    agentId,
    stage: receiptState(db, message, agentId),
  }))
  return {
    message,
    receipts,
    ...(route.mentions === undefined ? {} : { mentions: route.mentions }),
  }
}

/** 喊话结果（带 `wait` 时附等待结果；spec §9 `shout` 工具用）。 */
export interface ShoutWaitResult extends SendMessageResult {
  readonly reply: WaitResult<Receipt>
}

/** 喊话带 `wait` 且被闸时的返回：阻塞至审批出结果（spec §9 `shout.wait` 忠实语义）。 */
export interface ShoutApprovalWaitResult {
  readonly approval: Approval
  /** 等待超时（单仍 `pending`）时为 true；已决不带此字段。 */
  readonly timedOut?: boolean
}

/**
 * 闸后阻塞（spec §9 `shout.wait` 对根的忠实语义）：等待发起方↔用户审批通道的结果消息
 * （`postDecision` 已 publish，复用 `wait.ts` 消息通道），解锁即查审批状态；无结果则超时
 * 返回 `pending` + `timedOut`。
 */
async function awaitShoutApproval(
  db: Db,
  from: string,
  approval: Approval,
  wait: WaitOptions,
): Promise<ShoutApprovalWaitResult> {
  const channelId = approvalChannel(db, from).id
  const afterSeq = latestInConversation(db, channelId)?.seq ?? 0
  const deadline = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  for (;;) {
    const decided = getApproval(db, approval.id)
    if (decided !== undefined && decided.status !== "pending") return { approval: decided }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { approval: decided ?? approval, timedOut: true }
    const reply = await waitFor<never>(
      {
        conversationId: channelId,
        waiterId: from,
        checkMessages: () =>
          messagesSince(db, { conversationId: channelId, waiterId: from, afterSeq }),
        checkReceipts: () => [],
      },
      { until: "message", timeoutMs: remaining },
    )
    if (reply.timedOut) {
      const final = getApproval(db, approval.id)
      if (final !== undefined && final.status !== "pending") return { approval: final }
      return { approval: final ?? approval, timedOut: true }
    }
  }
}

/** 喊话（`to='*'`）：写入唯一广播会话，全部节点收件箱可见（决议 3）；入口经 `gate`（Task 7）。 */
export function shout(db: Db, from: string, body: string): Gated<SendMessageResult>
export function shout(
  db: Db,
  from: string,
  body: string,
  wait: WaitOptions,
): Promise<ShoutWaitResult | ShoutApprovalWaitResult>
export function shout(
  db: Db,
  from: string,
  body: string,
  wait?: WaitOptions,
): Gated<SendMessageResult> | Promise<ShoutWaitResult | ShoutApprovalWaitResult> {
  if (wait === undefined) {
    return gate(db, "shout", from, { body }, () => sendMessage(db, { from, to: "*", body }))
  }
  const bounded: WaitOptions = {
    ...(wait.until === undefined ? {} : { until: wait.until }),
    ...(wait.timeoutMs === undefined ? {} : { timeoutMs: wait.timeoutMs }),
  }
  const outcome = gate(db, "shout", from, { body }, () =>
    sendMessage(db, { from, to: "*", body, wait: bounded }),
  )
  return "approved" in outcome
    ? outcome.approved
    : awaitShoutApproval(db, from, outcome.approval, bounded)
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
  for (const conversationId of latestByConversation.keys()) publishReceipt(db, conversationId)
  return confirmed
}

/**
 * 未读双层聚合（决议 5 + 裁决）：自身全部会话（含喊话广播）+ **全部后代**递归；
 * 子树内**按 message seq 去重** —— 同一条消息被多名子树成员未读只计一次，
 * 任一成员未读即计、多成员未读不重复计（自发消息排除不变）。
 * spec §11.3「根行徽标 = 根自身 + 嵌套子会话」即本聚合的两层用例。
 */
export function unreadFor(db: Db, agentId: string): number {
  const direct = directUnreadSeqs(db, shoutConversationId(db))
  const childrenByParent = new Map<string, string[]>()
  for (const agent of listAgents(db)) {
    if (agent.parentId === undefined) continue
    const siblings = childrenByParent.get(agent.parentId)
    if (siblings === undefined) childrenByParent.set(agent.parentId, [agent.id])
    else siblings.push(agent.id)
  }
  const collected = new Set<number>()
  const walk = (id: string): void => {
    for (const seq of direct.get(id) ?? []) collected.add(seq)
    for (const childId of childrenByParent.get(id) ?? []) walk(childId)
  }
  walk(agentId)
  return collected.size
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
