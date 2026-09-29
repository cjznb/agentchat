/**
 * feat/revoke-queued —— 撤回界面派生纯函数单测（`revoke.ts`）。
 * 覆盖可见性（有未送达副本才可撤）与撤回后展示分流（己方占位 / 对方标记）。
 */
import { describe, expect, it } from "vitest"
import type { ChatMessage, ReceiptStage, ReceiptView } from "../../../shared/contracts"
import { canRevoke, revokeView } from "../revoke"

function receipt(agentId: string, stage: ReceiptStage): ReceiptView {
  return { agentId, stage }
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    seq: 1,
    id: "m1",
    conversationId: "c1",
    fromAgentId: "human",
    body: "原文",
    kind: "text",
    createdAt: 1,
    ...overrides,
  }
}

describe("canRevoke", () => {
  it("己方文本消息仍有 queued/sending 副本 → 可撤", () => {
    expect(canRevoke(message({ receipts: [receipt("a", "queued")] }), true)).toBe(true)
    expect(canRevoke(message({ receipts: [receipt("a", "sending")] }), true)).toBe(true)
    // 部分送达、部分在途 → 仍可撤（尽力撤回）。
    expect(
      canRevoke(message({ receipts: [receipt("a", "delivered"), receipt("b", "queued")] }), true),
    ).toBe(true)
  })

  it("全部已送达/已读 → 不可撤", () => {
    expect(
      canRevoke(message({ receipts: [receipt("a", "delivered"), receipt("b", "read")] }), true),
    ).toBe(false)
  })

  it("非己方 / 系统消息 / 无回执 / 已撤回 → 不可撤", () => {
    expect(canRevoke(message({ receipts: [receipt("a", "queued")] }), false)).toBe(false)
    expect(canRevoke(message({ kind: "system" }), true)).toBe(false)
    expect(canRevoke(message(), true)).toBe(false)
    expect(
      canRevoke(message({ revoked_at: 5, receipts: [receipt("a", "queued")] }), true),
    ).toBe(false)
  })
})

describe("revokeView", () => {
  it("未撤回 → none", () => {
    expect(revokeView(message(), true)).toBe("none")
  })

  it("己方已撤回 → placeholder（隐藏原文）", () => {
    expect(revokeView(message({ revoked_at: 9 }), true)).toBe("placeholder")
  })

  it("对方已撤回 → marked（保留原文加标记）", () => {
    expect(revokeView(message({ revoked_at: 9 }), false)).toBe("marked")
  })
})
