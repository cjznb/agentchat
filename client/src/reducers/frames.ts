/**
 * WS 帧状态迁移（Plan 3 终审 F7 拆分自 `state.ts`）——四类事件 payload 解析 + 游标幂等 + resync。
 *
 * - 游标 `appliedSeq`：`seq <= appliedSeq` 的帧**幂等忽略**（同 seq 不重复应用）
 * - payload 解析失败：`console.warn` 并忽略该帧数据（前向兼容），仅推进游标
 */
import {
  wsAgentPayloadSchema,
  wsApprovalPayloadSchema,
  wsMessagePayloadSchema,
  wsReceiptPayloadSchema,
  type ChatMessage,
  type WsServerFrame,
} from "../../../shared/contracts"
import { applyMessage } from "./messages"
import { mergeApproval } from "./notifications"
import { initialState, type AppState } from "./state"

function warnIgnore(state: AppState, frame: WsServerFrame): AppState {
  console.warn("ignoring ws frame with unparsable payload", frame)
  return { ...state, appliedSeq: frame.seq }
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
      return { ...applyMessage(state, chat), appliedSeq: frame.seq }
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
