/**
 * Task 8 I1 端到端检出用例（真机不亮即在此红）：
 * 服务端回显的 preview meta 经 `conversationPreviewSchema.parse`（GET /api/conversations
 * 载荷校验）存活 → `conversationMentioned` 成立；老端省略 meta → false 向后兼容；
 * 客户端 `updatePreview`（WS/乐观发送）把 `chat.meta` 带入预览。
 */
import { describe, expect, it } from "vitest"
import {
  conversationPreviewSchema,
  type ChatMessage,
  type ConversationSummary,
  type RosterNode,
} from "../../../shared/contracts"
import { updatePreview } from "../reducers/messages"
import { conversationMentioned } from "../unread"

const HUMAN_ROSTER = [
  { id: "human-1", name: "我", parent_id: null, vendor: "human", status: "online" },
] as unknown as RosterNode[]

function summaryOf(lastMessage: unknown): ConversationSummary {
  return { lastMessage } as unknown as ConversationSummary
}

describe("conversationList 预览 meta 端到端（I1）", () => {
  it("meta 经 conversationPreviewSchema.parse 存活 → conversationMentioned 成立", () => {
    const parsed = conversationPreviewSchema.parse({
      id: "m1",
      seq: 1,
      from: "agent-zhang",
      body: "@我 请看",
      createdAt: 1,
      meta: { mentions: ["human-1"] },
    })
    expect(conversationMentioned(summaryOf(parsed), HUMAN_ROSTER)).toBe(true)
  })

  it("老端省略 meta → parse 后无 meta → false（向后兼容）", () => {
    const parsed = conversationPreviewSchema.parse({
      id: "m1",
      seq: 1,
      from: "agent-zhang",
      body: "@我 请看",
      createdAt: 1,
    })
    expect(parsed.meta).toBeUndefined()
    expect(conversationMentioned(summaryOf(parsed), HUMAN_ROSTER)).toBe(false)
  })

  it("updatePreview 把 chat.meta 带入预览 → conversationMentioned 成立", () => {
    const chat = {
      seq: 2,
      id: "m2",
      conversationId: "c1",
      fromAgentId: "agent-zhang",
      body: "@我 请看",
      kind: "text",
      createdAt: 2,
      meta: { mentions: ["human-1"] },
    } as unknown as ChatMessage
    const seed = { id: "c1", lastMessage: null } as unknown as ConversationSummary
    const next = updatePreview([seed], chat)
    const updated = next[0]
    if (updated === undefined) throw new Error("updatePreview 未返回会话")
    expect(updated.lastMessage?.meta).toEqual({ mentions: ["human-1"] })
    expect(conversationMentioned(updated, HUMAN_ROSTER)).toBe(true)
  })
})
