/**
 * 群内请求批示（Task 4，spec §3.2/§3.3/§3.4）—— `ask.to` 为**群会话 id** 的多目标形态。
 *
 * 自 `core/ask.ts` 拆出（`ask.ts` ≤250 纯行红线；错误类与建卡原语 `createAskCard`
 * 仍由 `core/ask` 导出，本层只做群分支的解析、建卡与等待聚合）：
 * - `mentions` 必填且**必须全部命中**：未给 → `mentions_required`；未命中 →
 *   `mention_not_found`（含未命中名单）；真实节点但不在该群可提及集 → `mention_not_participant`。
 * - **一目标一卡**（多目标 = 多张 `kind='ask'` 单据，同落该群会话），`respond_ask` 按
 *   `ask_id` 逐卡答复；异步路径复用既有审批事件（不新增 WS 事件、不改 `approvals` 表）。
 * - 三形态等待（spec §3.4）：不传 `wait` → 立即返回 `asks`（无 `reply`）；带 `wait` 且
 *   `scope:"all"`（缺省）阻塞到全部已决、`scope:"any"` 任一先回即返回；到点 →
 *   `timedOut:true` + 已回 `replies` + 未回 `pending`（沿用 `mcpWaitSchema.timeoutMs`）。
 * - 可提及集合口径 = `recipientsOf`（容器恒排除、不含发送者，与 T3 唤醒/回执同一单点，
 *   不另写一套容器排除逻辑）；解析只经 `resolveMentions`（Task 1 单点）。
 */
import { resolveMentions, type MentionTarget } from "../../shared/mentions"
import type { Db } from "../db"
import { AgentNotFoundError, getAgent, getAgentByName, listAgents } from "../store/agents"
import { getApproval, type Approval } from "../store/approvals"
import type { Conversation } from "../store/conversations"
import { latestInConversation } from "../store/messages"
import {
  ConversationRequiredError,
  createAskCard,
  groupConversation,
  MentionNotParticipantError,
  MentionNotFoundError,
  MentionsRequiredError,
} from "./ask"
import { recipientsOf } from "./messaging"
import { DEFAULT_WAIT_TIMEOUT_MS, messagesSince, waitFor, type WaitOptions } from "./wait"

/** 群 ask 等待选项：既有 `wait` 字段 + `scope`（缺省 `"all"` —— 默认值在服务端生效，spec §3.4/D3）。 */
export interface GroupWaitOptions extends WaitOptions {
  readonly scope?: "all" | "any"
}

export interface GroupAskInput {
  /** 群会话 id（`kind='group'`）。 */
  readonly to: string
  readonly question: string
  readonly options: readonly string[]
  /** 缺省 true：允许自由答复（text）。 */
  readonly allowCustom?: boolean
  /** 结构化提及：必填且必须全部命中（名字 / id / id 前 8 位 / `"*"`）。 */
  readonly mentions?: readonly string[] | undefined
  /** 给出则按 `scope` 阻塞聚合等待；缺省立即返回 `asks`（异步形态）。 */
  readonly wait?: GroupWaitOptions | undefined
}

/** 建卡结果（不传 `wait`）：`asks` = 一目标一卡的单据数组。 */
export interface GroupAskResult {
  readonly asks: readonly Approval[]
}

/** 单条已决答复（`target` = 卡的应答者；`choice`/`text` 按答案形态二选一）。 */
export interface GroupAskReplyEntry {
  readonly target: string
  readonly choice?: string
  readonly text?: string
}

/** 群 ask 等待答复视图（spec §3.3：超时也带回已收部分，`pending` = 未回名单）。 */
export interface GroupAskReply {
  readonly timedOut: boolean
  readonly replies: readonly GroupAskReplyEntry[]
  readonly pending: readonly string[]
}

/** 等待结果（带 `wait`）：`asks` 恒为建卡全集，`reply` 为聚合答复视图。 */
export interface GroupAskWaitResult {
  readonly asks: readonly Approval[]
  readonly reply: GroupAskReply
}

/** 群可提及参与者（id+name）：`recipientsOf` 口径 —— 容器恒排除、不含发送者（spec §2）。 */
function mentionableTargets(db: Db, conversation: Conversation, from: string): MentionTarget[] {
  const targets: MentionTarget[] = []
  for (const id of recipientsOf(db, conversation, from)) {
    const agent = getAgent(db, id)
    if (agent !== undefined) targets.push({ id: agent.id, name: agent.name })
  }
  return targets
}

/** 未命中 token 是否对应真实节点（名字精确 / id / id 前 8 位，与 `resolveMentions` 同口径）。 */
function isRealAgent(db: Db, token: string): boolean {
  if (getAgentByName(db, token) !== undefined || getAgent(db, token) !== undefined) return true
  return token.length >= 8 && listAgents(db).some((agent) => agent.id.startsWith(token))
}

/**
 * 解析群 ask 目标（spec §3.2 严格口径）：`mentions` 缺省/空 → `mentions_required`；
 * 未命中中夹真实节点 → `mention_not_participant`、其余 → `mention_not_found`（含名单）；
 * 全部命中 → 目标 agent id 数组（`resolveMentions` 保序、同 id 去重）。
 */
function resolveGroupTargets(
  db: Db,
  setup: {
    readonly from: string
    readonly conversation: Conversation
    readonly mentions: readonly string[] | undefined
  },
): string[] {
  const { from, conversation, mentions } = setup
  const given = mentions ?? []
  if (given.length === 0) throw new MentionsRequiredError(conversation.id)
  const participants = mentionableTargets(db, conversation, from)
  const echo = resolveMentions({ body: "", mentions: [...given], participants })
  if (echo.unmatched.length > 0) {
    const outsiders = echo.unmatched.filter((token) => isRealAgent(db, token))
    if (outsiders.length > 0) throw new MentionNotParticipantError(outsiders)
    throw new MentionNotFoundError(echo.unmatched)
  }
  // 退化输入（如全为空串 token / 群内无可提及成员）→ 无任何有效目标，同「未给 mentions」。
  if (echo.matched.length === 0) throw new MentionsRequiredError(conversation.id)
  return echo.matched.map((target) => target.id)
}

/** 单据 → 答复条目（已决取 `result` 的 `choice`/`text`；与 DM `replyView` 同口径）。 */
function replyEntry(card: Approval): GroupAskReplyEntry {
  const result = card.result ?? {}
  const choice = result["choice"]
  const text = result["text"]
  return {
    target: card.target,
    ...(typeof choice === "string" ? { choice } : {}),
    ...(typeof text === "string" ? { text } : {}),
  }
}

function isComplete(scope: "all" | "any", current: readonly Approval[]): boolean {
  const settled = current.filter((card) => card.status !== "pending").length
  return scope === "any" ? settled > 0 : settled === current.length
}

function buildReply(timedOut: boolean, current: readonly Approval[]): GroupAskReply {
  return {
    timedOut,
    replies: current.filter((card) => card.status !== "pending").map(replyEntry),
    pending: current.filter((card) => card.status === "pending").map((card) => card.target),
  }
}

/** 单据现状重读（未决保持建卡快照；与 `awaitAsk` 的 `current ?? ask` 同口径）。 */
function reload(db: Db, cards: readonly Approval[]): Approval[] {
  return cards.map((card) => getApproval(db, card.id) ?? card)
}

/**
 * 聚合等待（`awaitAsk` 模板的多目标版）：每轮重读全部单据 →
 * `scope:"all"` 全部已决 / `scope:"any"` 任一已决 即 `timedOut:false` 返回；
 * 被答复消息 unlock → 复查；到点最后一轮复查后返回已回部分 + `pending`。
 * 第三方消息不推进状态但推进 `afterSeq` 基线（防忙旋，同 `awaitAsk` review #2）。
 */
async function awaitAskGroup(
  db: Db,
  setup: {
    readonly waiterId: string
    readonly cards: readonly Approval[]
    readonly conversationId: string
    readonly wait: GroupWaitOptions
  },
): Promise<GroupAskReply> {
  const { waiterId, cards, conversationId, wait } = setup
  const scope = wait.scope ?? "all"
  let afterSeq = latestInConversation(db, conversationId)?.seq ?? 0
  const deadline = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  for (;;) {
    const current = reload(db, cards)
    if (isComplete(scope, current)) return buildReply(false, current)
    const remaining = deadline - Date.now()
    if (remaining > 0) {
      const wake = await waitFor<never>(
        {
          conversationId,
          waiterId,
          checkMessages: () => messagesSince(db, { conversationId, waiterId, afterSeq }),
          checkReceipts: () => [],
        },
        { until: "message", timeoutMs: remaining },
      )
      if (!wake.timedOut) {
        afterSeq = wake.messages.reduce((max, message) => Math.max(max, message.seq), afterSeq)
        continue
      }
    }
    // 到点：最后一轮复查（答复恰落边界仍算已决，与 `awaitAsk` 同口径）。
    const final = reload(db, cards)
    return buildReply(!isComplete(scope, final), final)
  }
}

/** 群 ask 建卡（`wait` 缺省即异步返回 `asks`；给出则按 `scope` 聚合等待）。 */
export function askGroup(
  db: Db,
  from: string,
  input: GroupAskInput & { readonly wait: GroupWaitOptions },
): Promise<GroupAskWaitResult>
export function askGroup(db: Db, from: string, input: GroupAskInput): GroupAskResult
export function askGroup(
  db: Db,
  from: string,
  input: GroupAskInput,
): GroupAskResult | Promise<GroupAskWaitResult> {
  if (getAgent(db, from) === undefined) throw new AgentNotFoundError(from)
  const conversation = groupConversation(db, input.to)
  if (conversation === undefined) throw new ConversationRequiredError(from, input.to)
  const targets = resolveGroupTargets(db, { from, conversation, mentions: input.mentions })
  const allowCustom = input.allowCustom ?? true
  const asks = targets.map((target) =>
    createAskCard(db, {
      from,
      target,
      question: input.question,
      options: input.options,
      allowCustom,
      conversation,
    }),
  )
  if (input.wait === undefined) return { asks }
  return awaitAskGroup(db, {
    waiterId: from,
    cards: asks,
    conversationId: conversation.id,
    wait: input.wait,
  }).then((reply) => ({ asks, reply }))
}
