// @vitest-environment jsdom
/**
 * UI-1 ③-9 搜索纯函数门禁：会话行过滤 / 树过滤（保留祖先 + 强制展开）/ 通知过滤。
 * 只测纯函数（组件层用例在 conversation-group-section / org-tree 里）。
 */
import { describe, expect, it } from "vitest"
import type { ConversationSummary, NotificationEntry, RosterNode } from "../../../shared/contracts"
import { filterNotifications } from "../cards"
import { filterConversationRows, rowSearchText, type FoldedRow } from "../fold"
import { filterTreeRows, foldTree } from "../treeFold"

function summary(id: string, name: string, lastBody: string | null): ConversationSummary {
  return {
    id,
    name,
    kind: "dm",
    key: `dm:${id}`,
    createdAt: 100,
    unread: 0,
    lastMessage:
      lastBody === null ? null : { id: `m-${id}`, seq: 1, from: "a", body: lastBody, createdAt: 200 },
  } as unknown as ConversationSummary
}

function flat(id: string, name: string, lastBody: string | null): FoldedRow {
  return {
    kind: "logical",
    id,
    conversation: summary(id, name, lastBody),
    node: undefined,
    unread: 0,
    children: [],
    lastActivity: 200,
  }
}

function rootWith(id: string, name: string, children: readonly { id: string; name: string }[]): FoldedRow {
  return {
    kind: "root",
    id,
    conversation: null,
    node: { id, name } as unknown as RosterNode,
    unread: 0,
    children: children.map((child) => ({
      conversation: summary(child.id, child.name, null),
      node: undefined,
      retired: false,
    })),
    lastActivity: 200,
  }
}

describe("filterConversationRows（③-9 会话列表搜索）", () => {
  const rows = [
    flat("c1", "发布协调群", "收到，20:00 前给出回归清单。"),
    flat("c2", "运营群", "本周排期已定。"),
    rootWith("r1", "Claude Code 主实例", [{ id: "c3", name: "claude-01" }]),
  ]

  it("空查询原样返回（零拷贝语义）", () => {
    expect(filterConversationRows(rows, "   ")).toBe(rows)
  })

  it("按名字命中；按最后消息摘要也能命中", () => {
    expect(filterConversationRows(rows, "运营").map((row) => row.id)).toEqual(["c2"])
    expect(filterConversationRows(rows, "回归清单").map((row) => row.id)).toEqual(["c1"])
  })

  it("折叠根：自身命中保留全部子会话；仅子会话命中只保留命中的子行", () => {
    const self = filterConversationRows(rows, "claude code")
    expect(self.map((row) => row.id)).toEqual(["r1"])
    expect(self[0]?.children.map((child) => child.conversation.id)).toEqual(["c3"])

    const child = filterConversationRows(rows, "claude-01")
    expect(child.map((row) => row.id)).toEqual(["r1"])
    expect(child[0]?.children).toHaveLength(1)
  })

  it("无命中 → 空数组（组件据此给「没有匹配」空态）", () => {
    expect(filterConversationRows(rows, "不存在的关键词")).toEqual([])
  })

  it("rowSearchText 覆盖名字与摘要两段", () => {
    expect(rowSearchText(rows[0] as FoldedRow)).toContain("发布协调群")
    expect(rowSearchText(rows[0] as FoldedRow)).toContain("回归清单")
  })
})

describe("filterTreeRows（③-8/③-9 选人树/组织树搜索）", () => {
  const node = (id: string, name: string, children: readonly RosterNode[] = []): RosterNode =>
    ({
      id,
      name,
      kind: "runtime",
      parent_id: null,
      vendor: "opencode",
      model: "m",
      status: "online",
      status_text: null,
      purpose: null,
      role_tag: null,
      remark: null,
      skills: [],
      unread: 0,
      children,
    }) as RosterNode

  const rows = foldTree([
    node("root1", "Claude Code 主实例", [
      node("child1", "claude-01"),
      node("child2", "opencode-02"),
    ]),
    node("root2", "容器实例组", [node("sess1", "deep-child-01")]),
  ])

  it("空查询原样返回、无强制展开", () => {
    const result = filterTreeRows(rows, "  ")
    expect(result.rows).toBe(rows)
    expect(result.expandIds).toEqual([])
  })

  it("命中的叶子保留其祖先，且祖先进 expandIds（搜到了必须看得见）", () => {
    const result = filterTreeRows(rows, "deep-child")
    expect(result.rows.map((row) => row.node.id)).toEqual(["root2"])
    expect(result.rows[0]?.children.map((child) => child.node.id)).toEqual(["sess1"])
    expect(result.expandIds).toEqual(["root2"])
  })

  it("父自身命中 → 只保留命中的子树（未命中的兄弟被过滤），无需强制展开", () => {
    const result = filterTreeRows(rows, "Claude Code")
    expect(result.rows.map((row) => row.node.id)).toEqual(["root1"])
    expect(result.rows[0]?.children).toEqual([])
    expect(result.expandIds).toEqual([])
  })

  it("父子同时命中 → 子树保留（搜 claude 命中父与 claude-01）", () => {
    const result = filterTreeRows(rows, "claude")
    expect(result.rows.map((row) => row.node.id)).toEqual(["root1"])
    expect(result.rows[0]?.children.map((child) => child.node.id)).toEqual(["child1"])
    expect(result.expandIds).toEqual([])
  })

  it("无命中 → 空（组件给「没有匹配」空态）", () => {
    expect(filterTreeRows(rows, "zzz").rows).toEqual([])
  })
})

describe("filterNotifications（③-9 通知搜索）", () => {
  const entries = [
    {
      id: "a1",
      kind: "action",
      requesterAgentId: "root-1",
      target: "human",
      action: "group_create",
      payload: { name: "发布协调群" },
      status: "pending",
      createdAt: 1_750_000_000_000,
      readAt: undefined,
      conversationId: null,
      cardMessageId: null,
    },
    {
      id: "a2",
      kind: "ask",
      requesterAgentId: "root-2",
      target: "human",
      action: "ask",
      payload: { question: "选哪个环境？", options: ["staging"] },
      status: "answered",
      createdAt: 1_750_000_100_000,
      readAt: 1,
      conversationId: null,
      cardMessageId: null,
    },
  ] as unknown as readonly NotificationEntry[]
  const names = new Map([
    ["root-1", "Claude Code 主实例"],
    ["root-2", "opencode 根"],
  ])

  it("空查询原样返回", () => {
    expect(filterNotifications(entries, "", names)).toBe(entries)
  })

  it("按主题 / 发起方 / 类型 / 状态任一命中", () => {
    expect(filterNotifications(entries, "发布协调", names).map((e) => e.id)).toEqual(["a1"])
    expect(filterNotifications(entries, "opencode", names).map((e) => e.id)).toEqual(["a2"])
    expect(filterNotifications(entries, "批示", names).map((e) => e.id)).toEqual(["a2"])
    expect(filterNotifications(entries, "已答复", names).map((e) => e.id)).toEqual(["a2"])
  })

  it("无命中 → 空", () => {
    expect(filterNotifications(entries, "zzz", names)).toEqual([])
  })
})
