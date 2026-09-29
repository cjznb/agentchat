/**
 * 请求批示（ask）编排（spec §17；Task 2）—— 自 `core/permissions` 拆出
 * （`permissions.ts` ≤250 纯行红线，controller 授权；`permissions` 反向 re-export 保持既有导入路径）。
 *
 * 复用审批底座：同一 `approvals` 表（`kind='ask'`）、同一卡/回执消息形态（`kind='system'` + meta）、
 * 同一 `wait` 阻塞机制、同一首答条件 UPDATE。
 * - `ask`：`to='human'` 落发起方↔用户审批通道；`to=agent` 落双方**既有**可沟通会话（DM 优先，
 *   否则共同群），无 → `conversation_required`；`to==from` → `self_ask`；`to`=群会话 id →
 *   `mentions_required`（群多目标形态在 `core/ask-group`）。建卡 + `publishMessage` + `emitApproval`。
 * - `awaitAsk`：`awaitShoutApproval` 模板 —— 卡会话 `latestInConversation` 取基线 seq →
 *   `waitFor(...,{until:"message"})` 循环 → 每轮复查单据状态 → 超时返回 pending。
 * - 答复编排（`respondAsk`）在 `core/respond.ts`（本文件 ≤250 纯行红线拆分，controller 授权；
 *   `core/permissions` 一并 re-export）。
 */
import type { Db } from "../db"
import { AgentNotFoundError, getAgent } from "../store/agents"
import { getApproval, insertAsk, type Approval } from "../store/approvals"
import {
  dmKey,
  getConversation,
  getConversationByKey,
  isParticipant,
  listConversations,
  type Conversation,
} from "../store/conversations"
import { latestInConversation } from "../store/messages"
import { approvalChannel, emitApproval, postSystem } from "./permissions"
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  messagesSince,
  waitFor,
  type WaitOptions,
} from "./wait"

/** ask 目标哨兵：`'human'` 表示发起方↔用户审批通道（其余为目标 agent id）。 */
const HUMAN_TARGET = "human"

/** 单不存在（`ask`/`respondAsk` 的 id 未命中，或非 ask 单据）。 */
export class AskNotFoundError extends Error {
  readonly code = "ask_not_found"
  constructor(readonly askId: string) {
    super(`ask not found: ${askId}`)
    this.name = "AskNotFoundError"
  }
}

/** 已答单再答（首答生效，第二次不改写 `result`）。 */
export class AskAlreadyAnsweredError extends Error {
  readonly code = "ask_already_answered"
  constructor(readonly askId: string) {
    super(`ask already answered: ${askId}`)
    this.name = "AskAlreadyAnsweredError"
  }
}

/** 选项非法（choice ∉ options / `allowCustom=false` 时给 text / 未给答案）。 */
export class InvalidChoiceError extends Error {
  readonly code = "invalid_choice"
  constructor(readonly detail: string) {
    super(`invalid choice: ${detail}`)
    this.name = "InvalidChoiceError"
  }
}

/** 无应答权限（非 `target` 且非 human 超级观察者）。 */
export class AskForbiddenError extends Error {
  readonly code = "forbidden"
  constructor(
    readonly responderId: string,
    readonly askId: string,
  ) {
    super(`agent ${responderId} is not allowed to answer ask ${askId}`)
    this.name = "AskForbiddenError"
  }
}

/** 目标 agent 与发起方无任何可沟通会话（DM 或共同群），且不自动建会话。 */
export class ConversationRequiredError extends Error {
  readonly code = "conversation_required"
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`no shared conversation between ${from} and ${to} for an ask`)
    this.name = "ConversationRequiredError"
  }
}

/** 发起对自身的 ask（无意义，显式拒绝）。 */
export class SelfAskError extends Error {
  readonly code = "self_ask"
  constructor(readonly agentId: string) {
    super(`agent ${agentId} cannot ask itself`)
    this.name = "SelfAskError"
  }
}

/** 群 ask 未给 `mentions`（spec §6：替代旧 `conversation_required` 歧义；`to` 为群会话 id 即触发）。 */
export class MentionsRequiredError extends Error {
  readonly code = "mentions_required"
  constructor(readonly conversationId: string) {
    super(`mentions are required for a group ask: ${conversationId}`)
    this.name = "MentionsRequiredError"
  }
}

/** 群 ask 的提及全部未命中（spec §3.2：含未命中名单，杜绝「以为问了其实没问」）。 */
export class MentionNotFoundError extends Error {
  readonly code = "mention_not_found"
  constructor(readonly unmatched: readonly string[]) {
    super(`ask mentions not found: ${unmatched.join(", ")}`)
    this.name = "MentionNotFoundError"
  }
}

/** 被 @ 者是真实节点但不在该群可提及集（非成员 / 分组容器 / 发起方自身，spec §6）。 */
export class MentionNotParticipantError extends Error {
  readonly code = "mention_not_participant"
  constructor(readonly outsiders: readonly string[]) {
    super(`ask mentions are not group participants: ${outsiders.join(", ")}`)
    this.name = "MentionNotParticipantError"
  }
}

export interface AskInput {
  /** `'human'` 或目标 agent id。 */
  readonly to: string
  readonly question: string
  readonly options: readonly string[]
  /** 缺省 true：允许自由答复（text）；false 时仅接受选项。 */
  readonly allowCustom?: boolean
  /** 给出则阻塞至答复/超时（`awaitAsk`）。 */
  readonly wait?: WaitOptions
}

/** 建卡结果（无 wait）。 */
export interface AskResult {
  readonly ask: Approval
}

/** 等待结果（带 wait）：已决 `timedOut:false`；超时仍 pending `timedOut:true`。 */
export interface AskWaitResult {
  readonly ask: Approval
  readonly timedOut: boolean
}

/**
 * agent 目标的可沟通会话：既有 DM 优先，否则首个共同群；皆无 → `undefined`
 * （**不自动建会话** —— spec §17 要求「已有可沟通会话」，故 `to=agent` 只取不建）。
 */
function sharedConversation(db: Db, a: string, b: string): Conversation | undefined {
  const dm = getConversationByKey(db, dmKey(a, b))
  if (dm !== undefined) return dm
  for (const conversation of listConversations(db)) {
    if (
      conversation.kind === "group" &&
      isParticipant(db, conversation.id, a) &&
      isParticipant(db, conversation.id, b)
    ) {
      return conversation
    }
  }
  return undefined
}

/** `to` 是否为群会话 id（`kind='group'`，含喊话广播会话）—— `ask` 群分支的入口判定。 */
export function groupConversation(db: Db, to: string): Conversation | undefined {
  const conversation = getConversation(db, to)
  return conversation?.kind === "group" ? conversation : undefined
}

/** 解析 ask 目标 + 卡所在会话（human → 审批通道；agent → 既有共同会话，无则 `conversation_required`）。 */
function resolveTarget(
  db: Db,
  from: string,
  to: string,
): { readonly target: string; readonly conversation: Conversation } {
  if (to === HUMAN_TARGET) {
    return { target: HUMAN_TARGET, conversation: approvalChannel(db, from) }
  }
  if (getAgent(db, to) === undefined) throw new ConversationRequiredError(from, to)
  const conversation = sharedConversation(db, from, to)
  if (conversation === undefined) throw new ConversationRequiredError(from, to)
  return { target: to, conversation }
}

/** 卡所在会话（`respondAsk` 回退复用 ask 的定位规则；目标会话消失 → `conversation_required`）。 */
export function cardConversation(db: Db, ask: Approval): Conversation {
  if (ask.target === HUMAN_TARGET) return approvalChannel(db, ask.requesterAgentId)
  const conversation = sharedConversation(db, ask.requesterAgentId, ask.target)
  if (conversation === undefined) {
    throw new ConversationRequiredError(ask.requesterAgentId, ask.target)
  }
  return conversation
}

function cardBody(question: string, options: readonly string[], allowCustom: boolean): string {
  const optionsText = options.length === 0 ? "" : `（选项：${options.join(" / ")}）`
  return `❓ 请求批示：${question}${optionsText}${allowCustom ? "，也可自由答复" : ""}`
}

/** 建卡入参（单卡与群多卡共用；`conversation` = 卡所在会话）。 */
export interface AskCardParams {
  readonly from: string
  readonly target: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom: boolean
  readonly conversation: Conversation
}

/** 建一张批示卡：插单 + 卡消息（幂等键按单）+ approval 事件（`ask` 与 `askGroup` 共用原语）。 */
export function createAskCard(db: Db, params: AskCardParams): Approval {
  const stored = insertAsk(db, {
    requesterAgentId: params.from,
    target: params.target,
    question: params.question,
    options: params.options,
    allowCustom: params.allowCustom,
    conversationId: params.conversation.id,
    now: Date.now(),
  })
  postSystem(db, {
    conversationId: params.conversation.id,
    fromAgentId: params.from,
    body: cardBody(params.question, params.options, params.allowCustom),
    meta: {
      askId: stored.id,
      kind: "ask",
      question: params.question,
      options: [...params.options],
      allowCustom: params.allowCustom,
    },
    idempotencyKey: `ask-card:${stored.id}`,
  })
  emitApproval(stored)
  return stored
}

/**
 * 发起请求批示；`wait` 时阻塞至答复（已决）或超时（仍 pending）。
 * `to` 为**群会话 id** 时走 `askGroup`（`core/ask-group`）—— 本入口不收 `mentions`，
 * 故群 id 恒报 `mentions_required`（spec §3.2：取代旧 `conversation_required` 歧义）。
 */
export function ask(
  db: Db,
  from: string,
  input: AskInput & { readonly wait: WaitOptions },
): Promise<AskWaitResult>
export function ask(db: Db, from: string, input: AskInput): AskResult
export function ask(db: Db, from: string, input: AskInput): AskResult | Promise<AskWaitResult> {
  if (getAgent(db, from) === undefined) throw new AgentNotFoundError(from)
  if (input.to === from) throw new SelfAskError(from)
  if (groupConversation(db, input.to) !== undefined) throw new MentionsRequiredError(input.to)
  const allowCustom = input.allowCustom ?? true
  const { target, conversation } = resolveTarget(db, from, input.to)
  const stored = createAskCard(db, {
    from,
    target,
    question: input.question,
    options: input.options,
    allowCustom,
    conversation,
  })
  if (input.wait === undefined) return { ask: stored }
  return awaitAsk(db, from, stored, conversation.id, input.wait)
}

/** 等待答复（`awaitShoutApproval` 模板）：被答复消息 unlock → 复查单据状态；超时返回 pending。 */
export async function awaitAsk(
  db: Db,
  waiterId: string,
  ask: Approval,
  conversationId: string,
  wait: WaitOptions,
): Promise<AskWaitResult> {
  let afterSeq = latestInConversation(db, conversationId)?.seq ?? 0
  const deadline = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  for (;;) {
    const current = getApproval(db, ask.id)
    if (current !== undefined && current.status !== "pending") return { ask: current, timedOut: false }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ask: current ?? ask, timedOut: true }
    const reply = await waitFor<never>(
      {
        conversationId,
        waiterId,
        checkMessages: () => messagesSince(db, { conversationId, waiterId, afterSeq }),
        checkReceipts: () => [],
      },
      { until: "message", timeoutMs: remaining },
    )
    if (reply.timedOut) {
      const final = getApproval(db, ask.id)
      if (final !== undefined && final.status !== "pending") return { ask: final, timedOut: false }
      return { ask: final ?? ask, timedOut: true }
    }
    // 非超时唤醒：把基线推进到本次返回消息的最大 seq —— 否则群会话中第三方成员消息会令
    // `checkMessages` 反复命中同一批消息，外层紧循环忙旋直到 deadline（review #2）。
    afterSeq = reply.messages.reduce((max, message) => Math.max(max, message.seq), afterSeq)
  }
}

