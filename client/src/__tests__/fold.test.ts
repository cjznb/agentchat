/**
 * Plan 3 T4 —— 会话列表折叠纯函数单测（矩阵：聚合值 / 排序 / human 过滤 /
 * 逻辑顶层 / 退役标记 / 深度归属 / 手风琴 / localStorage 容错）。
 */
import { describe, expect, it } from "vitest"
import type { AgentStatus, ConversationSummary, RosterNode } from "../../../shared/contracts"
import {
  EXPANDED_ROOTS_KEY,
  foldConversations,
  loadExpandedRoots,
  saveExpandedRoots,
  toggleExpandedRoot,
  type StorageLike,
} from "../fold"

function node(
  id: string,
  opts: {
    readonly parent?: string
    readonly kind?: "runtime" | "logical"
    readonly status?: AgentStatus
    readonly vendor?: string
    readonly children?: readonly RosterNode[]
  } = {},
): RosterNode {
  return {
    id,
    name: id,
    kind: opts.kind ?? "runtime",
    parent_id: opts.parent ?? null,
    vendor: opts.vendor ?? "opencode",
    model: "m",
    status: opts.status ?? "online",
    status_text: null,
    purpose: null,
    role_tag: null,
    remark: null,
    unread: 0,
    children: opts.children ?? [],
  }
}

function conv(
  id: string,
  key: string,
  opts: {
    readonly kind?: "dm" | "group"
    readonly at?: number
    readonly unread?: number
    readonly name?: string | null
  } = {},
): ConversationSummary {
  return {
    id,
    name: opts.name ?? null,
    kind: opts.kind ?? "dm",
    key,
    lastMessage:
      opts.at === undefined
        ? null
        : { id: `m-${id}`, seq: 1, from: "peer", body: `body-${id}`, createdAt: opts.at },
    unread: opts.unread ?? 0,
  }
}

// root1{ child1{ grand1 }, child2(retired) } / root2{ child3 } / logi(logical) / human(human)
const roster: readonly RosterNode[] = [
  node("human", { kind: "logical", vendor: "human" }),
  node("root1", {
    children: [
      node("child1", { parent: "root1", children: [node("grand1", { parent: "child1" })] }),
      node("child2", { parent: "root1", status: "retired" }),
    ],
  }),
  node("root2", { children: [node("child3", { parent: "root2" })] }),
  node("logi", { kind: "logical", status: "offline" }),
]

function conversationSet(): readonly ConversationSummary[] {
  return [
    conv("c-shout", "shout", { kind: "group", at: 50, name: "全员喊话" }),
    conv("c-group", "group:c-group", { kind: "group", at: 60, name: "群A" }),
    conv("c-root1", "dm:human_root1", { at: 10 }),
    conv("c-child1", "dm:child1_human", { at: 40, unread: 3 }),
    conv("c-child2", "dm:child2_human", { at: 30, unread: 1 }),
    conv("c-grand1", "dm:grand1_human", { at: 20 }),
    conv("c-logi", "dm:human_logi", { at: 70 }),
    conv("c-child3", "dm:child3_human", { at: 5 }),
  ]
}

describe("foldConversations", () => {
  it("根容器聚合未读取 unreadByRoot，子行取自身 unread；嵌套深层后代归入同根", () => {
    const rows = foldConversations(conversationSet(), { root1: 7, root2: 2 }, roster)
    const root1 = rows.find((row) => row.id === "root1")
    expect(root1?.kind).toBe("root")
    expect(root1?.unread).toBe(7)
    expect(root1?.conversation?.id).toBe("c-root1")
    expect(root1?.children.map((child) => child.conversation.id)).toEqual(["c-child1", "c-child2", "c-grand1"])
    expect(root1?.children.find((child) => child.conversation.id === "c-child1")?.conversation.unread).toBe(3)
    // 逻辑节点私聊不入任何根容器。
    expect(rows.every((row) => row.children.every((child) => child.conversation.id !== "c-logi"))).toBe(true)
  })

  it("排序：喊话置顶；其余（群/逻辑/根容器）按最后消息时间倒序", () => {
    const rows = foldConversations(conversationSet(), {}, roster)
    expect(rows[0]?.kind).toBe("shout")
    const rest = rows.slice(1).map((row) => row.id)
    // logi(at 70) → group(60) → root1(max: child1 40) → root2(child3 5)
    expect(rest).toEqual(["c-logi", "c-group", "root1", "root2"])
  })

  it("human 节点与 human 会话完全过滤：human 根不成容器、不出现在子行", () => {
    const rows = foldConversations(conversationSet(), {}, roster)
    expect(rows.some((row) => row.id === "human")).toBe(false)
    const nodeIds = rows.flatMap((row) => [
      row.node?.id,
      ...row.children.map((child) => child.node?.id),
    ])
    expect(nodeIds).not.toContain("human")
  })

  it("逻辑节点私聊为顶层 logical 行，且退役子行标记 retired", () => {
    const rows = foldConversations(conversationSet(), {}, roster)
    const logi = rows.find((row) => row.id === "c-logi")
    expect(logi?.kind).toBe("logical")
    expect(logi?.node?.id).toBe("logi")
    const root1 = rows.find((row) => row.id === "root1")
    expect(root1?.children.find((child) => child.conversation.id === "c-child2")?.retired).toBe(true)
    expect(root1?.children.find((child) => child.conversation.id === "c-child1")?.retired).toBe(false)
  })

  it("根容器无自有 DM 时 conversation 为 null，仅承载子会话", () => {
    const rows = foldConversations([conv("c-child3", "dm:child3_human", { at: 1 })], {}, roster)
    const root2 = rows.find((row) => row.id === "root2")
    expect(root2?.conversation).toBeNull()
    expect(root2?.children.map((child) => child.conversation.id)).toEqual(["c-child3"])
  })

  it("无法归属的会话（不在 roster）被跳过", () => {
    const rows = foldConversations([conv("c-x", "dm:ghost_human", { at: 1 })], {}, roster)
    expect(rows).toEqual([])
  })
})

describe("展开态（手风琴 + localStorage）", () => {
  it("手风琴：展开新根只保留它，再点已展开的根则收起", () => {
    expect(toggleExpandedRoot([], "root1")).toEqual(["root1"])
    expect(toggleExpandedRoot(["root1"], "root2")).toEqual(["root2"])
    expect(toggleExpandedRoot(["root1"], "root1")).toEqual([])
  })

  class FakeStorage implements StorageLike {
    private readonly map = new Map<string, string>()
    getItem(key: string): string | null {
      return this.map.get(key) ?? null
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value)
    }
    seed(key: string, value: string): void {
      this.map.set(key, value)
    }
  }

  it("写入后读回一致的根 id 列表（键前缀 agentchat:）", () => {
    const storage = new FakeStorage()
    saveExpandedRoots(storage, ["root1"])
    expect(storage.getItem(EXPANDED_ROOTS_KEY)).toBe('["root1"]')
    expect(loadExpandedRoots(storage)).toEqual(["root1"])
  })

  it("坏 JSON / 非字符串数组 / 空存储 → 空数组（容错）", () => {
    const storage = new FakeStorage()
    storage.seed(EXPANDED_ROOTS_KEY, "{not json")
    expect(loadExpandedRoots(storage)).toEqual([])
    storage.seed(EXPANDED_ROOTS_KEY, '{"root":1}')
    expect(loadExpandedRoots(storage)).toEqual([])
    storage.seed(EXPANDED_ROOTS_KEY, '["a",1,null]')
    expect(loadExpandedRoots(storage)).toEqual(["a"])
    expect(loadExpandedRoots(new FakeStorage())).toEqual([])
    expect(loadExpandedRoots(null)).toEqual([])
  })
})
