/**
 * 消息 reducer 纯原语（Plan 3 终审 F7 拆分自 `state.ts`）——入桶 / 去重 / 合并 / 乐观插入回滚。
 * 聊天视图发送的真乐观插入（F4）复用此处的 `applyMessage`/`dropMessage`/`revertPreview`。
 */
import type {
  ChatMessage,
  ConversationPreview,
  ConversationSummary,
} from "../../../shared/contracts"
import type { AppState } from "./state"

/** 会话列表排序：最后消息时间倒序，同值 id 字典序（稳定）。 */
export function sortConversations(
  conversations: readonly ConversationSummary[],
): readonly ConversationSummary[] {
  return [...conversations].sort((a, b) => {
    const delta = (b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0)
    if (delta !== 0) return delta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 用一条消息刷新其会话预览并重排列表。 */
export function updatePreview(
  conversations: readonly ConversationSummary[],
  chat: ChatMessage,
): readonly ConversationSummary[] {
  const preview: ConversationPreview = {
    id: chat.id,
    seq: chat.seq,
    from: chat.fromAgentId,
    body: chat.body,
    createdAt: chat.createdAt,
    ...(chat.meta === undefined ? {} : { meta: chat.meta }),
  }
  return sortConversations(
    conversations.map((conversation) =>
      conversation.id === chat.conversationId ? { ...conversation, lastMessage: preview } : conversation,
    ),
  )
}

/** 消息入会话（按 id 去重，seq 升序）；未加载且未打开的会话不建空桶。 */
export function upsertMessage(
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

/** 单条消息进入状态：入桶（按 id 去重）+ 更新会话列表预览（WS 帧与乐观发送共用）。 */
export function applyMessage(state: AppState, chat: ChatMessage): AppState {
  return {
    ...state,
    messages: upsertMessage(state, chat),
    conversations: updatePreview(state.conversations, chat),
  }
}

/**
 * 合并一页消息：按 id 去重，**新页覆盖同 id**（回执 stage 等更新），并保留桶内已有、
 * 本页未含的更早消息（上翻已加载历史不被 refetch 整桶替换），seq 升序。
 */
export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): readonly ChatMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message] as const))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

/** 从桶中移除指定消息（乐观消息对账/回滚用）；桶空则删除键。 */
export function dropMessage(
  messages: ReadonlyMap<string, readonly ChatMessage[]>,
  conversationId: string,
  id: string,
): ReadonlyMap<string, readonly ChatMessage[]> {
  const existing = messages.get(conversationId)
  if (existing === undefined) return messages
  const next = existing.filter((message) => message.id !== id)
  if (next.length === existing.length) return messages
  const map = new Map(messages)
  if (next.length === 0) map.delete(conversationId)
  else map.set(conversationId, next)
  return map
}

/** 回滚乐观消息后重算该会话预览（取剩余消息中 seq 最大者；无则回落 null）。 */
export function revertPreview(
  conversations: readonly ConversationSummary[],
  conversationId: string,
  remaining: readonly ChatMessage[],
): readonly ConversationSummary[] {
  const last =
    remaining.length === 0
      ? null
      : remaining.reduce((best, message) => (message.seq > best.seq ? message : best))
  const preview: ConversationPreview | null =
    last === null
      ? null
      : {
          id: last.id,
          seq: last.seq,
          from: last.fromAgentId,
          body: last.body,
          createdAt: last.createdAt,
          ...(last.meta === undefined ? {} : { meta: last.meta }),
        }
  return sortConversations(
    conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, lastMessage: preview } : conversation,
    ),
  )
}
