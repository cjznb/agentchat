/**
 * 请求批示（ask）编排（spec §17；Task 2）—— 自 `core/permissions` 拆出
 * （`permissions.ts` ≤250 纯行红线，controller 授权；`permissions` 反向 re-export 保持既有导入路径）。
 *
 * 复用审批底座：同一 `approvals` 表（`kind='ask'`）、同一卡/回执消息形态（`kind='system'` + meta）、
 * 同一 `wait` 阻塞机制、同一首答条件 UPDATE。
 * - `ask`：`to='human'` 落发起方↔用户审批通道；`to=agent` 落双方**既有**可沟通会话（DM 优先，
 *   否则共同群），无 → `conversation_required`；`to==from` → `self_ask`。建卡 + `publishMessage` + `emitApproval`。
 * - `respondAsk`：人类超级观察者可答任意 ask；agent 仅限 `target`。选项合法性 → `invalid_choice`；
 *   首答生效（`markAnswered` 条件 UPDATE）；答复消息落卡所在会话 + publish（解锁 `wait`）。
 * - `awaitAsk`：`awaitShoutApproval` 模板 —— 卡会话 `latestInConversation` 取基线 seq →
 *   `waitFor(...,{until:"message"})` 循环 → 每轮复查单据状态 → 超时返回 pending。
 */
import { z } from "zod"
import type { Db } from "../db"
import { AgentNotFoundError, getAgent } from "../store/agents"
import { getApproval, insertAsk, markAnswered, type Approval } from "../store/approvals"
import {
  dmKey,
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

export interface RespondAskInput {
  /** 选择某个选项（必须 ∈ options）。 */
  readonly choice?: string
  /** 自由答复（仅 `allowCustom !== false` 时允许）。 */
  readonly text?: string
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

/** 卡所在会话（respondAsk 复用 ask 的定位规则；目标会话消失 → `conversation_required`）。 */
function cardConversation(db: Db, ask: Approval): Conversation {
  if (ask.target === HUMAN_TARGET) return approvalChannel(db, ask.requesterAgentId)
  const conversation = sharedConversation(db, ask.requesterAgentId, ask.target)
  if (conversation === undefined) {
    throw new ConversationRequiredError(ask.requesterAgentId, ask.target)
  }
  return conversation
}

function cardBody(question: string, options: readonly string[], allowCustom: boolean): string {
  const optionText = options.length === 0 ? "" : `（选项：${options.join(" / ")}）`
  const customText = allowCustom ? "，也可自由答复" : ""
  return `❓ 请求批示：${question}${optionText}${customText}`
}

const optionsSchema = z.array(z.string())

/** 校验并归一答案：choice 必须 ∈ options；text 仅 `allowCustom`；二者互斥且至少其一。 */
function resolveAnswer(
  input: RespondAskInput,
  rawOptions: unknown,
  allowCustom: boolean,
): { readonly choice: string } | { readonly text: string } {
  const { choice, text } = input
  if (choice !== undefined && text !== undefined) {
    throw new InvalidChoiceError("choice and text are mutually exclusive")
  }
  if (choice !== undefined) {
    const parsed = optionsSchema.safeParse(rawOptions)
    const options = parsed.success ? parsed.data : []
    if (!options.includes(choice)) {
      throw new InvalidChoiceError(`choice "${choice}" is not one of the options`)
    }
    return { choice }
  }
  if (text !== undefined) {
    if (!allowCustom) throw new InvalidChoiceError("custom text is not allowed for this ask")
    return { text }
  }
  throw new InvalidChoiceError("either choice or text is required")
}

function answerBody(answer: { readonly choice: string } | { readonly text: string }): string {
  return "choice" in answer ? `✅ 已答复：${answer.choice}` : `✅ 已答复：${answer.text}`
}

/** 发起请求批示；`wait` 时阻塞至答复（已决）或超时（仍 pending）。 */
export function ask(
  db: Db,
  from: string,
  input: AskInput & { readonly wait: WaitOptions },
): Promise<AskWaitResult>
export function ask(db: Db, from: string, input: AskInput): AskResult
export function ask(db: Db, from: string, input: AskInput): AskResult | Promise<AskWaitResult> {
  if (getAgent(db, from) === undefined) throw new AgentNotFoundError(from)
  if (input.to === from) throw new SelfAskError(from)
  const allowCustom = input.allowCustom ?? true
  const { target, conversation } = resolveTarget(db, from, input.to)
  const stored = insertAsk(db, {
    requesterAgentId: from,
    target,
    question: input.question,
    options: input.options,
    allowCustom,
    now: Date.now(),
  })
  postSystem(db, {
    conversationId: conversation.id,
    fromAgentId: from,
    body: cardBody(input.question, input.options, allowCustom),
    meta: {
      askId: stored.id,
      kind: "ask",
      question: input.question,
      options: [...input.options],
      allowCustom,
    },
    idempotencyKey: `ask-card:${stored.id}`,
  })
  emitApproval(stored)
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
  const afterSeq = latestInConversation(db, conversationId)?.seq ?? 0
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
  }
}

/**
 * 答复请求批示（首答生效）：校验应答权限与答案合法性 → `markAnswered`（仅 `pending` 成功）；
 * 答复消息落卡所在会话（`meta.askId`）+ publish（解锁 wait）+ `emitApproval`。
 * 人类超级观察者（`vendor='human'`）可答任意 ask；agent 仅限 `target`。
 */
export function respondAsk(
  db: Db,
  askId: string,
  responder: string,
  input: RespondAskInput,
): Approval {
  const stored = getApproval(db, askId)
  if (stored === undefined || stored.kind !== "ask") throw new AskNotFoundError(askId)
  const responderAgent = getAgent(db, responder)
  if (responderAgent?.vendor !== "human" && responder !== stored.target) {
    throw new AskForbiddenError(responder, askId)
  }
  const conversation = cardConversation(db, stored)
  const answer = resolveAnswer(
    input,
    stored.payload["options"],
    stored.payload["allowCustom"] !== false,
  )
  const decidedAt = Date.now()
  const result: Record<string, unknown> = { ...answer, responder, decidedAt }
  if (!markAnswered(db, askId, result, decidedAt)) throw new AskAlreadyAnsweredError(askId)
  const decided: Approval = { ...stored, status: "answered", result, decidedAt }
  postSystem(db, {
    conversationId: conversation.id,
    fromAgentId: responder,
    body: answerBody(answer),
    meta: { askId, kind: "ask", result },
    idempotencyKey: `ask-answer:${askId}`,
  })
  emitApproval(decided)
  return decided
}
