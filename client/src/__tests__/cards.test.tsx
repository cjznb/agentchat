/**
 * Plan 3 T8 —— 审批卡 / 批示卡纯函数单测（`cards.ts`）。
 * 覆盖：卡识别（meta 分流 / 回执排除）、状态机与结果文本、tab 过滤、未读计数、
 * 错误文案、已决/已读乐观对账。无 DOM——组件仅消费这些派生结果。
 */
import { describe, expect, it } from "vitest"
import type {
  ApprovalEntry,
  ChatMessage,
  NotificationEntry,
} from "../../../shared/contracts"
import {
  cardErrorText,
  cardFromEntry,
  cardOutcome,
  cardSubject,
  entriesForTab,
  kindLabel,
  markEntryRead,
  readCardMessage,
  statusLabel,
  unreadCount,
  upsertDecided,
} from "../cards"

function message(meta: Record<string, unknown> | undefined, body = "卡"): ChatMessage {
  return {
    seq: 1,
    id: "m1",
    conversationId: "c1",
    fromAgentId: "a1",
    body,
    kind: "system",
    createdAt: 1,
    ...(meta === undefined ? {} : { meta }),
  }
}

function entry(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: "n1",
    kind: "ask",
    requesterAgentId: "a1",
    target: "human",
    action: "ask",
    payload: { question: "继续吗", options: ["是", "否"], allowCustom: true },
    status: "pending",
    createdAt: 1,
    cardMessageId: "m1",
    conversationId: "c1",
    ...overrides,
  }
}

describe("readCardMessage", () => {
  it("识别批示卡并从 payload 读选项", () => {
    const card = readCardMessage(
      message({ askId: "a1", kind: "ask", question: "继续吗", options: ["是", "否"], allowCustom: false }),
    )
    expect(card).toEqual({ kind: "ask", id: "a1", question: "继续吗", options: ["是", "否"], allowCustom: false })
  })

  it("识别审批卡", () => {
    const card = readCardMessage(
      message({ approvalId: "p1", action: "shout", payload: { body: "全体注意" } }),
    )
    expect(card).toEqual({ kind: "approval", id: "p1", action: "shout", payload: { body: "全体注意" } })
  })

  it("排除答复/决议回执（带 result 的 meta）与普通系统消息", () => {
    expect(readCardMessage(message({ askId: "a1", result: { choice: "是" } }))).toBeNull()
    expect(readCardMessage(message({ approvalId: "p1", action: "shout", result: "approved" }))).toBeNull()
    expect(readCardMessage(message(undefined, "chat-root 加入群聊"))).toBeNull()
    expect(readCardMessage({ ...message({}), meta: {} })).toBeNull()
  })
})

describe("cardFromEntry", () => {
  it("由通知条目重建批示卡（问题/选项/allowCustom）", () => {
    expect(cardFromEntry(entry({ payload: { question: "Q", options: ["A"], allowCustom: false } }))).toEqual({
      kind: "ask",
      id: "n1",
      question: "Q",
      options: ["A"],
      allowCustom: false,
    })
  })

  it("由通知条目重建审批卡并取主题", () => {
    const card = cardFromEntry(
      entry({ kind: "action", action: "group_create", payload: { name: "工程群" } }),
    )
    expect(card.kind).toBe("approval")
    expect(cardSubject(card)).toBe("创建群聊")
  })
})

describe("cardOutcome 状态机", () => {
  const ask = cardFromEntry(entry())
  it("无权威条目 → pending", () => {
    expect(cardOutcome(ask, undefined)).toEqual({
      status: "pending",
      ended: false,
      resultText: null,
      selectedChoice: null,
      answerText: null,
    })
  })

  it("批示 answered：choice 高亮 / text 展示", () => {
    const byChoice = cardOutcome(ask, { status: "answered", result: { choice: "是" } })
    expect(byChoice.selectedChoice).toBe("是")
    expect(byChoice.resultText).toBe("已选择「是」")
    const byText = cardOutcome(ask, { status: "answered", result: { text: "稍后" } })
    expect(byText.answerText).toBe("稍后")
    expect(byText.resultText).toBe("已答复：稍后")
  })

  it("审批 approved/rejected/expired → 结果文案", () => {
    const approval = cardFromEntry(entry({ kind: "action", action: "shout", payload: { body: "x" } }))
    expect(cardOutcome(approval, { status: "approved" }).resultText).toContain("已同意")
    expect(cardOutcome(approval, { status: "rejected" }).resultText).toContain("已拒绝")
    expect(cardOutcome(approval, { status: "expired" }).ended).toBe(true)
  })
})

describe("标签 / 错误文案 / tab 过滤 / 未读", () => {
  it("kindLabel 与 statusLabel", () => {
    expect(kindLabel("ask")).toBe("批示")
    expect(kindLabel("action")).toBe("审批")
    expect(statusLabel("pending")).toBe("待处理")
    expect(statusLabel("answered")).toBe("已答复")
    expect(statusLabel("approved")).toBe("已通过")
  })

  it("cardErrorText 按种类区分 409/404/400", () => {
    expect(cardErrorText("ask", 409)).toContain("已被作答")
    expect(cardErrorText("ask", 400)).toContain("不合法")
    expect(cardErrorText("action", 409)).toContain("已处理")
    expect(cardErrorText("action", 500)).toContain("请稍后重试")
  })

  it("entriesForTab 与 unreadCount", () => {
    const a = entry({ id: "a" })
    const b = entry({ id: "b", readAt: 9 })
    expect(entriesForTab("actionable", [a], [a, b])).toEqual([a])
    expect(entriesForTab("all", [a], [a, b])).toHaveLength(2)
    expect(unreadCount([a, b])).toBe(1)
  })
})

describe("乐观对账", () => {
  it("upsertDecided 合并同 id 的 status/result，保留深链锚点", () => {
    const decided: ApprovalEntry = {
      id: "n1",
      requesterAgentId: "a1",
      kind: "ask",
      target: "human",
      action: "ask",
      payload: {},
      status: "answered",
      result: { choice: "是" },
      createdAt: 1,
      decidedAt: 2,
    }
    const [merged] = upsertDecided([entry()], decided)
    expect(merged?.status).toBe("answered")
    expect(merged?.cardMessageId).toBe("m1")
    expect(merged?.result).toEqual({ choice: "是" })
  })

  it("upsertDecided 缺失则前插（锚点置 null）", () => {
    const list = upsertDecided([], {
      id: "z",
      requesterAgentId: "a1",
      kind: "action",
      target: "human",
      action: "shout",
      payload: {},
      status: "rejected",
      createdAt: 1,
    })
    expect(list[0]?.id).toBe("z")
    expect(list[0]?.cardMessageId).toBeNull()
  })

  it("markEntryRead 幂等置位 readAt", () => {
    const read = markEntryRead([entry()], "n1", 42)
    expect(read[0]?.readAt).toBe(42)
    expect(markEntryRead(read, "n1", 99)[0]?.readAt).toBe(42)
  })
})
