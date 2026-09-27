/**
 * 审批卡 / 批示卡纯派生（spec §11.4/§11.5/§17；Plan 3 T8）——卡识别、卡状态机、
 * 结果文本、通知页 tab 过滤与未读计数。组件只消费，不重复解析 meta / payload。
 *
 * 卡消息（`ChatMessage.meta`）与通知条目（`NotificationEntry`）是同一单据的两种视图：
 * 前者只在聊天流里定位「卡」，后者携带权威 `status`/`result`（已决态唯一来源）。
 * `cardOutcome` 把两者收敛为渲染所需的不可变视图，`upsertDecided`/`markEntryRead`
 * 是 store 乐观对账的纯迁移。
 */
import type {
  ApprovalActionValue,
  ApprovalEntry,
  ApprovalKind,
  ApprovalStatus,
  ChatMessage,
  NotificationEntry,
} from "../../shared/contracts"

/** 动作中文标签（与 `server/core/permissions` 的 ACTION_LABEL 同口径）。 */
export const ACTION_LABELS: Readonly<Record<ApprovalActionValue, string>> = {
  shout: "全员喊话",
  group_create: "创建群聊",
  group_add: "拉人入会话",
  ask: "请求批示",
}

/** 通知页两 tab（= REST `scope`）。 */
export type NotificationTab = "actionable" | "all"

/** 审批卡（`meta.approvalId`）：受限动作待决。 */
export interface ApprovalCard {
  readonly kind: "approval"
  readonly id: string
  readonly action: ApprovalActionValue
  readonly payload: Readonly<Record<string, unknown>>
}

/** 批示卡（`meta.askId` 且无 `result`）：问题 + 预置选项 + 是否允许自由答复。 */
export interface AskCard {
  readonly kind: "ask"
  readonly id: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom: boolean
}

export type CardData = ApprovalCard | AskCard

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function optionsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function actionOf(value: unknown): ApprovalActionValue | null {
  switch (value) {
    case "shout":
    case "group_create":
    case "group_add":
    case "ask":
      return value
    default:
      return null
  }
}

/**
 * 从系统消息识别卡：`askId` 且无 `result` → 批示卡（答复/过期回执有 `result`，排除掉）；
 * `approvalId` + `action` + `payload` 且无 `result` → 审批卡（决议回执有 `result`）。
 * 普通系统消息 / 卡的回执消息 → `null`。
 */
export function readCardMessage(message: ChatMessage): CardData | null {
  const meta = message.meta
  if (meta === undefined) return null
  if (meta["result"] !== undefined) return null
  const askId = textOf(meta["askId"])
  if (askId !== null && meta["question"] !== undefined) {
    return {
      kind: "ask",
      id: askId,
      question: textOf(meta["question"]) ?? message.body,
      options: optionsOf(meta["options"]),
      allowCustom: meta["allowCustom"] !== false,
    }
  }
  const approvalId = textOf(meta["approvalId"])
  const action = actionOf(meta["action"])
  if (approvalId !== null && action !== null && action !== "ask") {
    return { kind: "approval", id: approvalId, action, payload: recordOf(meta["payload"]) ?? {} }
  }
  return null
}

/** 通知条目 → 卡视图（通知页内联回复复用同一渲染与提交逻辑）。 */
export function cardFromEntry(entry: NotificationEntry): CardData {
  if (entry.kind === "ask") {
    return {
      kind: "ask",
      id: entry.id,
      question: textOf(entry.payload["question"]) ?? "请求批示",
      options: optionsOf(entry.payload["options"]),
      allowCustom: entry.payload["allowCustom"] !== false,
    }
  }
  return { kind: "approval", id: entry.id, action: entry.action, payload: entry.payload }
}

/** 卡主题：批示 = 问题文本；审批 = 动作标签。 */
export function cardSubject(card: CardData): string {
  return card.kind === "ask" ? card.question : ACTION_LABELS[card.action]
}

/** 审批卡载荷摘要（喊话正文 / 群名 / 被拉成员），无 → null。 */
export function cardDetail(card: ApprovalCard): string | null {
  return (
    textOf(card.payload["body"]) ??
    textOf(card.payload["name"]) ??
    textOf(card.payload["agentId"]) ??
    null
  )
}

/** 卡状态机输出（渲染所需的最小不可变视图）。 */
export interface CardOutcome {
  readonly status: ApprovalStatus
  readonly ended: boolean
  /** 已决结果文案（pending → null）。 */
  readonly resultText: string | null
  /** 批示已选选项（answered 且为 choice 时）。 */
  readonly selectedChoice: string | null
  /** 批示自由答复文本（answered 且为 text 时）。 */
  readonly answerText: string | null
}

const PENDING_OUTCOME: CardOutcome = {
  status: "pending",
  ended: false,
  resultText: null,
  selectedChoice: null,
  answerText: null,
}

/**
 * 卡状态机：权威状态来自通知条目（或提交成功后的乐观单据），缺省 `pending`。
 * 批示 answered 区分 choice（高亮选项）与 text（展示文本）；approval 三态 → 结果文案。
 */
export function cardOutcome(
  card: CardData,
  decision: Pick<ApprovalEntry, "status" | "result"> | undefined,
): CardOutcome {
  const status: ApprovalStatus = decision?.status ?? "pending"
  if (status === "pending") return PENDING_OUTCOME
  const result = decision?.result
  const choice = result === undefined ? null : textOf(result["choice"])
  const answer = result === undefined ? null : textOf(result["text"])
  const ended = true
  if (card.kind === "ask") {
    if (status === "answered") {
      const resultText =
        choice !== null ? `已选择「${choice}」` : answer !== null ? `已答复：${answer}` : "已答复"
      return { status, ended, resultText, selectedChoice: choice, answerText: answer }
    }
    return { status, ended, resultText: "批示已过期，未获答复。", selectedChoice: null, answerText: null }
  }
  switch (status) {
    case "approved":
      return { status, ended, resultText: "已同意，动作已执行。", selectedChoice: null, answerText: null }
    case "rejected":
      return { status, ended, resultText: "已拒绝，动作未执行。", selectedChoice: null, answerText: null }
    case "expired":
      return { status, ended, resultText: "已过期，按拒绝处理。", selectedChoice: null, answerText: null }
    case "answered":
      return { status, ended, resultText: "已处理。", selectedChoice: null, answerText: null }
  }
}

/** 单据种类标签（审批 / 批示）。 */
export function kindLabel(kind: ApprovalKind): string {
  return kind === "ask" ? "批示" : "审批"
}

/** 单据状态标签（通知条目与卡脚共用）。 */
export function statusLabel(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "待处理"
    case "approved":
      return "已通过"
    case "rejected":
      return "已拒绝"
    case "answered":
      return "已答复"
    case "expired":
      return "已过期"
  }
}

/**
 * 提交失败文案：按单据种类 + HTTP 状态给出可操作提示（409/404 为对账信号，不改本地态）。
 * `ask` 不该打到审批端点，故 approval 分支不会出现 ask 单的 400。
 */
export function cardErrorText(kind: ApprovalKind, status: number): string {
  if (kind === "ask") {
    if (status === 409) return "该批示已被作答，无需重复回复。"
    if (status === 400) return "答复不合法，请重新选择或输入。"
    if (status === 404) return "批示单不存在或已失效。"
  } else {
    if (status === 409) return "该审批已处理，无需重复操作。"
    if (status === 404) return "审批单不存在或已失效。"
  }
  return "操作未成功，请稍后重试。"
}

/** tab 过滤：actionable = 需我处理（state.notifications），all = 全部（state.notificationsAll）。 */
export function entriesForTab(
  tab: NotificationTab,
  actionable: readonly NotificationEntry[],
  all: readonly NotificationEntry[],
): readonly NotificationEntry[] {
  return tab === "actionable" ? actionable : all
}

/** 未读数（未读 = `readAt` 为空）。 */
export function unreadCount(entries: readonly NotificationEntry[]): number {
  return entries.reduce((total, entry) => (entry.readAt === undefined ? total + 1 : total), 0)
}

/** 通知时间戳 `MM-DD HH:MM`（本地时区）。 */
export function formatMoment(createdAt: number): string {
  const date = new Date(createdAt)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${month}-${day} ${hours}:${minutes}`
}

/** 乐观对账：把已决单据并入通知列表（同 id 合并，缺失则前插；`cardMessageId` 未知时置 null）。 */
export function upsertDecided(
  entries: readonly NotificationEntry[],
  decided: ApprovalEntry,
): readonly NotificationEntry[] {
  const index = entries.findIndex((entry) => entry.id === decided.id)
  if (index < 0) {
    const created: NotificationEntry = {
      id: decided.id,
      kind: decided.kind,
      requesterAgentId: decided.requesterAgentId,
      target: decided.target,
      action: decided.action,
      payload: decided.payload,
      status: decided.status,
      ...(decided.result === undefined ? {} : { result: decided.result }),
      createdAt: decided.createdAt,
      ...(decided.decidedAt === undefined ? {} : { decidedAt: decided.decidedAt }),
      ...(decided.readAt === undefined ? {} : { readAt: decided.readAt }),
      cardMessageId: null,
      conversationId: null,
    }
    return [created, ...entries]
  }
  const existing = entries[index]
  if (existing === undefined) return entries
  const merged: NotificationEntry = {
    ...existing,
    status: decided.status,
    ...(decided.result === undefined ? {} : { result: decided.result }),
    ...(decided.decidedAt === undefined ? {} : { decidedAt: decided.decidedAt }),
    ...(decided.readAt === undefined ? {} : { readAt: decided.readAt }),
  }
  const next = [...entries]
  next[index] = merged
  return next
}

/** 乐观对账：标记单条已读（幂等；仅未读条目置位）。 */
export function markEntryRead(
  entries: readonly NotificationEntry[],
  id: string,
  readAt: number,
): readonly NotificationEntry[] {
  return entries.map((entry) =>
    entry.id === id && entry.readAt === undefined ? { ...entry, readAt } : entry,
  )
}
