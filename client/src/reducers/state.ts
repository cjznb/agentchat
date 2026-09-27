/**
 * store 状态与纯 reducer（Plan 3 T3；终审 F7 拆分）——
 * 副作用意图在 `planner.ts`，消息/通知原语在 `messages.ts` / `notifications.ts`，
 * WS 帧迁移在 `frames.ts`，聚合出口在 `index.ts`。
 */
import type {
  ApprovalEntry,
  ChatMessage,
  ConversationList,
  ConversationSummary,
  NotificationEntry,
  RosterNode,
  WsServerFrame,
} from "../../../shared/contracts"
import type { ReloadResult } from "../api"
import type { ConnectionStatus } from "../ws"
import { reduceFrame } from "./frames"
import {
  applyMessage,
  dropMessage,
  mergeMessages,
  revertPreview,
} from "./messages"
import { applyNotifDecided, applyNotifRead } from "./notifications"

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
  /** 最近一次重拉是否失败（真实错误信号；成功 hydrate 后清零，驱动 UI 错误态）。 */
  readonly loadError: boolean
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
  loadError: false,
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
  | { readonly type: "message"; readonly chat: ChatMessage }
  /** 乐观插入（F4）：立即以临时 id 入桶显示气泡；随后 `reconcile`/`rollback` 对账。 */
  | { readonly type: "optimistic"; readonly chat: ChatMessage }
  /** 服务端返回成功：移除临时气泡、按服务端 id 入桶（WS 同帧到达时按 id 去重）。 */
  | { readonly type: "reconcile"; readonly tempId: string; readonly chat: ChatMessage }
  /** 发送失败：移除临时气泡并回退该会话预览（草稿由调用方保留）。 */
  | { readonly type: "rollback"; readonly conversationId: string; readonly tempId: string }
  | {
      /** 上翻分页：把更早一页并入会话桶（按 id 去重，seq 升序）。 */
      readonly type: "prepend"
      readonly conversationId: string
      readonly messages: readonly ChatMessage[]
    }
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  /** 重拉失败（REST 首屏/对账）；置错误位，待下一次成功 `hydrate` 清除。 */
  | { readonly type: "loadFailed" }
  | { readonly type: "open"; readonly conversationId: string | null }
  /** 卡提交成功：已决单据并入全部列表，并从「需我处理」列表移除（乐观对账）。 */
  | { readonly type: "notifDecided"; readonly approval: ApprovalEntry }
  /** 通知已读（幂等置位 `readAt`）。 */
  | { readonly type: "notifRead"; readonly id: string; readonly at: number }
  | { readonly type: "hydrate"; readonly patch: ReloadResult }

function hydrate(state: AppState, patch: ReloadResult): AppState {
  // 任一次成功重拉即清除错误位（重试成功 → 错误态消失）。
  let next: AppState = { ...state, loadError: false }
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
    // 按 id 合并而非整桶替换：refetch 只带回最新一页，须保留上翻已加载的更早消息（复审 I2）。
    const messages = new Map(next.messages)
    for (const item of patch.messages) {
      messages.set(
        item.conversationId,
        mergeMessages(messages.get(item.conversationId) ?? [], item.messages),
      )
    }
    next = { ...next, messages }
  }
  return next
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
    case "message":
    case "optimistic":
      return applyMessage(state, action.chat)
    case "reconcile": {
      const pruned = dropMessage(state.messages, action.chat.conversationId, action.tempId)
      return applyMessage({ ...state, messages: pruned }, action.chat)
    }
    case "rollback": {
      const messages = dropMessage(state.messages, action.conversationId, action.tempId)
      return {
        ...state,
        messages,
        conversations: revertPreview(
          state.conversations,
          action.conversationId,
          messages.get(action.conversationId) ?? [],
        ),
      }
    }
    case "prepend":
      return {
        ...state,
        messages: new Map(state.messages).set(
          action.conversationId,
          mergeMessages(state.messages.get(action.conversationId) ?? [], action.messages),
        ),
      }
    case "connection":
      return { ...state, connection: action.status }
    case "loadFailed":
      return { ...state, loadError: true }
    case "open":
      return { ...state, openConversationId: action.conversationId }
    case "notifDecided":
      return applyNotifDecided(state, action.approval)
    case "notifRead":
      return applyNotifRead(state, action.id, action.at)
    case "hydrate":
      return hydrate(state, action.patch)
  }
}
