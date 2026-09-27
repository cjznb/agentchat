/**
 * 重拉规划器（Plan 3 T3）——纯函数：给定当前状态与 WS 帧，产出需重拉的数据面。
 *
 * - `resync` → 整页重拉（roster + conversations + notifications + approvals），
 *   **并补回当前打开会话的消息**（状态已被清空，需重拉方能恢复）
 * - `message` → 会话列表对账；所属会话**正打开**时重拉该会话消息
 * - `receipt` → 已加载/打开的会话重拉消息（以重拉结果为准）
 * - `agent` → 重拉 roster
 * - `approval` → 重拉通知列表（两 scope）与审批列
 */
import {
  wsMessagePayloadSchema,
  wsReceiptPayloadSchema,
  type WsServerFrame,
} from "../../../shared/contracts"
import type { ReloadPlan } from "../api"
import type { AppState } from "./state"

function emptyPlan(): ReloadPlan {
  return { roster: false, conversations: false, notifications: false, approvals: false, messages: [] }
}

export function planReload(state: AppState, frame: WsServerFrame): ReloadPlan {
  if (frame.type === "resync") {
    return {
      roster: true,
      conversations: true,
      notifications: true,
      approvals: true,
      messages: state.openConversationId === null ? [] : [state.openConversationId],
    }
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
