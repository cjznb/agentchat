/**
 * 纯 reducer 与重拉计划（Plan 3 T3）——`store.tsx` 的状态机核心，无副作用、可单测。
 *
 * - `reducer` 消费 WS 帧（四类事件 + `resync`）与 hydrate/连接/打开会话等动作
 * - `planReload` 从同一帧推导副作用意图（重拉哪个数据面），由 store 执行
 * - 游标 `appliedSeq`：`seq <= appliedSeq` 的帧**幂等忽略**（同 seq 不重复应用）
 * - payload 解析失败：`console.warn` 并忽略该帧数据（前向兼容），仅推进游标
 */
import {
  wsAgentPayloadSchema,
  wsApprovalPayloadSchema,
  wsMessagePayloadSchema,
  wsReceiptPayloadSchema,
  type ApprovalEntry,
  type ApprovalKind,
  type ApprovalSnapshot,
  type ChatMessage,
  type ConversationList,
  type ConversationPreview,
  type ConversationSummary,
  type NotificationEntry,
  type RosterNode,
  type WsServerFrame,
} from "../../shared/contracts"
import type { ReloadPlan, ReloadResult } from "./api"
import type { ConnectionStatus } from "./ws"

/** 前端应用状态（所有 UI 组件订阅的单一来源）。 */
export interface AppState {
  readonly conversations: readonly ConversationSummary[]
  readonly unreadByRoot: Readonly<Record<string, number>>
  /** 已加载会话的消息（按会话 id；值 seq 升序）。 */
  readonly messages: ReadonlyMap<string, readonly ChatMessage[]>
  readonly roster: readonly RosterNode[]
  /** 通知页 `actionable` 范围（需我处理）。 */
  readonly notifications: readonly NotificationEntry[]
  /** 通知页 `all` 范围（含已决与 agent↔agent）。 */
  readonly notificationsAll: readonly NotificationEntry[]
  /** 待处理审批单（`kind === 'action'`）。 */
  readonly approvals: readonly ApprovalEntry[]
  readonly connection: ConnectionStatus
  readonly appliedSeq: number
  readonly openConversationId: string | null
}

export const initialState: AppState = {
  conversations: [],
  unreadByRoot: {},
  messages: new Map(),
  roster: [],
  notifications: [],
  notificationsAll: [],
  approvals: [],
  connection: "connecting",
  appliedSeq: 0,
  openConversationId: null,
}

export type StoreAction =
  | { readonly type: "frame"; readonly frame: WsServerFrame }
  | { readonly type: "roster"; readonly roster: readonly RosterNode[] }
  | { readonly type: "conversations"; readonly payload: ConversationList }
  | {
      readonly type: "notifications"
      readonly notifications: readonly NotificationEntry[]
      readonly notificationsAll: readonly NotificationEntry[]
    }
  | { readonly type: "approvals"; readonly approvals: readonly ApprovalEntry[] }
  | {
      readonly type: "messages"
      readonly conversationId: string
      readonly messages: readonly ChatMessage[]
    }
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "open"; readonly conversationId: string | null }
  | { readonly type: "hydrate"; readonly patch: ReloadResult }

function emptyPlan(): ReloadPlan {
  return { roster: false, conversations: false, notifications: false, approvals: false, messages: [] }
}

function warnIgnore(state: AppState, frame: WsServerFrame): AppState {
  console.warn("ignoring ws frame with unparsable payload", frame)
  return { ...state, appliedSeq: frame.seq }
}

function sortConversations(
  conversations: readonly ConversationSummary[],
): readonly ConversationSummary[] {
  return [...conversations].sort((a, b) => {
    const delta = (b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0)
    if (delta !== 0) return delta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function updatePreview(
  conversations: readonly ConversationSummary[],
  chat: ChatMessage,
): readonly ConversationSummary[] {
  const preview: ConversationPreview = {
    id: chat.id,
    seq: chat.seq,
    from: chat.fromAgentId,
    body: chat.body,
    createdAt: chat.createdAt,
  }
  return sortConversations(
    conversations.map((conversation) =>
      conversation.id === chat.conversationId ? { ...conversation, lastMessage: preview } : conversation,
    ),
  )
}

/** 消息入会话（按 id 去重，seq 升序）；未加载且未打开的会话不建空桶。 */
function upsertMessage(
  state: AppState,
  chat: ChatMessage,
): ReadonlyMap<string, readonly ChatMessage[]> {
  const existing = state.messages.get(chat.conversationId)
  if (existing === undefined) {
    if (state.openConversationId !== chat.conversationId) return state.messages
    return new Map(state.messages).set(chat.conversationId, [chat])
  }
  if (existing.some((message) => message.id === chat.id)) return state.messages
  const next = [...existing, chat].sort((a, b) => a.seq - b.seq)
  return new Map(state.messages).set(chat.conversationId, next)
}

function toApprovalEntry(snapshot: ApprovalSnapshot): ApprovalEntry {
  return {
    id: snapshot.id,
    requesterAgentId: snapshot.requesterAgentId,
    kind: "action",
    target: "human",
    action: snapshot.action,
    payload: snapshot.payload,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    ...(snapshot.decidedAt === null ? {} : { decidedAt: snapshot.decidedAt }),
  }
}

/** 审批帧按 `kind` 分流：`action` 入审批列（已决移除），`ask` 归通知列（经重拉）。 */
function mergeApproval(
  list: readonly ApprovalEntry[],
  kind: ApprovalKind,
  approval: ApprovalSnapshot,
): readonly ApprovalEntry[] {
  if (kind !== "action") return list
  const rest = list.filter((entry) => entry.id !== approval.id)
  if (approval.status !== "pending") return rest
  return [...rest, toApprovalEntry(approval)].sort((a, b) => a.createdAt - b.createdAt)
}

function hydrate(state: AppState, patch: ReloadResult): AppState {
  let next = state
  if (patch.roster !== undefined) next = { ...next, roster: patch.roster }
  if (patch.conversations !== undefined) {
    next = {
      ...next,
      conversations: patch.conversations.conversations,
      unreadByRoot: patch.conversations.unreadByRoot,
    }
  }
  if (patch.notifications !== undefined) next = { ...next, notifications: patch.notifications }
  if (patch.notificationsAll !== undefined) next = { ...next, notificationsAll: patch.notificationsAll }
  if (patch.approvals !== undefined) next = { ...next, approvals: patch.approvals }
  if (patch.messages !== undefined) {
    const messages = new Map(next.messages)
    for (const item of patch.messages) messages.set(item.conversationId, item.messages)
    next = { ...next, messages }
  }
  return next
}

/** 单帧状态迁移（`resync` 清缓存；普通事件先过游标幂等闸）。 */
export function reduceFrame(state: AppState, frame: WsServerFrame): AppState {
  if (frame.type === "resync") {
    return {
      ...initialState,
      connection: state.connection,
      openConversationId: state.openConversationId,
      appliedSeq: frame.seq,
    }
  }
  if (frame.seq <= state.appliedSeq) return state
  switch (frame.type) {
    case "message": {
      const parsed = wsMessagePayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return warnIgnore(state, frame)
      const payload = parsed.data
      const chat: ChatMessage = {
        seq: payload.seq,
        id: payload.messageId,
        conversationId: payload.conversationId,
        fromAgentId: payload.from,
        body: payload.body,
        kind: payload.kind,
        createdAt: payload.createdAt,
      }
      return {
        ...state,
        messages: upsertMessage(state, chat),
        conversations: updatePreview(state.conversations, chat),
        appliedSeq: frame.seq,
      }
    }
    case "receipt": {
      const parsed = wsReceiptPayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return warnIgnore(state, frame)
      return { ...state, appliedSeq: frame.seq }
    }
    case "agent": {
      const parsed = wsAgentPayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return warnIgnore(state, frame)
      return { ...state, roster: parsed.data.tree, appliedSeq: frame.seq }
    }
    case "approval": {
      const parsed = wsApprovalPayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return warnIgnore(state, frame)
      return {
        ...state,
        approvals: mergeApproval(state.approvals, parsed.data.kind, parsed.data.approval),
        appliedSeq: frame.seq,
      }
    }
  }
}

export function reducer(state: AppState, action: StoreAction): AppState {
  switch (action.type) {
    case "frame":
      return reduceFrame(state, action.frame)
    case "roster":
      return { ...state, roster: action.roster }
    case "conversations":
      return {
        ...state,
        conversations: action.payload.conversations,
        unreadByRoot: action.payload.unreadByRoot,
      }
    case "notifications":
      return {
        ...state,
        notifications: action.notifications,
        notificationsAll: action.notificationsAll,
      }
    case "approvals":
      return { ...state, approvals: action.approvals }
    case "messages":
      return {
        ...state,
        messages: new Map(state.messages).set(action.conversationId, action.messages),
      }
    case "connection":
      return { ...state, connection: action.status }
    case "open":
      return { ...state, openConversationId: action.conversationId }
    case "hydrate":
      return hydrate(state, action.patch)
  }
}

/**
 * 副作用意图（纯函数）：给定当前状态与帧，产出需重拉的数据面。
 * - `resync` → 整页重拉（roster + conversations + notifications + approvals）
 * - `message` → 会话列表对账；所属会话**正打开**时重拉该会话消息
 * - `receipt` → 已加载/打开的会话重拉消息（以重拉结果为准）
 * - `agent` → 重拉 roster
 * - `approval` → 重拉通知列表（两 scope）与审批列
 */
export function planReload(state: AppState, frame: WsServerFrame): ReloadPlan {
  if (frame.type === "resync") {
    return { roster: true, conversations: true, notifications: true, approvals: true, messages: [] }
  }
  switch (frame.type) {
    case "message": {
      const parsed = wsMessagePayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return emptyPlan()
      const conversationId = parsed.data.conversationId
      return {
        roster: false,
        conversations: true,
        notifications: false,
        approvals: false,
        messages: state.openConversationId === conversationId ? [conversationId] : [],
      }
    }
    case "receipt": {
      const parsed = wsReceiptPayloadSchema.safeParse(frame.payload)
      if (!parsed.success) return emptyPlan()
      const conversationId = parsed.data.conversationId
      const active = state.openConversationId === conversationId || state.messages.has(conversationId)
      return {
        roster: false,
        conversations: false,
        notifications: false,
        approvals: false,
        messages: active ? [conversationId] : [],
      }
    }
    case "agent":
      return { roster: true, conversations: false, notifications: false, approvals: false, messages: [] }
    case "approval":
      return { roster: false, conversations: false, notifications: true, approvals: true, messages: [] }
    default:
      return emptyPlan()
  }
}
