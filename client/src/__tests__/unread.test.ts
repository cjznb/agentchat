/**
 * Plan 3 终审 F1 —— 未读聚合纯函数单测（human 观察者全子树口径）：
 * 父子嵌套沿链累加 / 群聊不计入 / 打开子会话后祖先下降 / 不可归属会话跳过。
 */
import { describe, expect, it } from "vitest"
import type { AgentStatus, ConversationSummary, RosterNode } from "../../../shared/contracts"
import { aggregateUnread } from "../unread"

function node(
  id: string,
  opts: {
    readonly parent?: string
    readonly kind?: "runtime" | "logical"
    readonly status?: AgentStatus
    readonly vendor?: string
    readonly roleTag?: string
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
    role_tag: opts.roleTag ?? null,
    remark: null,
    skills: [],
    unread: 0,
    children: opts.children ?? [],
  }
}

function conv(id: string, key: string, unread: number, kind: "dm" | "group" = "dm"): ConversationSummary {
  return {
    id,
    name: null,
    kind,
    key,
    createdAt: 0,
    lastMessage: null,
    unread,
  }
}

// root1{ child1{ grand1 } } / root2 / human / logi
const roster: readonly RosterNode[] = [
  node("human", { kind: "logical", vendor: "human" }),
  node("root1", {
    children: [
      node("child1", {
        parent: "root1",
        children: [node("grand1", { parent: "child1" })],
      }),
    ],
  }),
  node("root2"),
  node("logi", { kind: "logical", status: "offline" }),
]

describe("aggregateUnread", () => {
  it("沿 parent 链累加：根 = 全子树，中间节点 = 其子树", () => {
    const totals = aggregateUnread(
      [
        conv("c-root1", "dm:human_root1", 1),
        conv("c-child1", "dm:child1_human", 2),
        conv("c-grand1", "dm:grand1_human", 4),
      ],
      roster,
    )
    expect(totals.get("root1")).toBe(7)
    expect(totals.get("child1")).toBe(6)
    expect(totals.get("grand1")).toBe(4)
    // 无关根/节点不在表内。
    expect(totals.get("root2")).toBeUndefined()
    expect(totals.get("logi")).toBeUndefined()
  })

  it("逻辑节点会话计入其自身与祖先；群聊/喊话不归属任何子树", () => {
    const totals = aggregateUnread(
      [
        conv("c-logi", "dm:human_logi", 3),
        conv("c-group", "group:c-group", 9, "group"),
        conv("c-shout", "shout", 5, "group"),
      ],
      roster,
    )
    expect(totals.get("logi")).toBe(3)
    expect(totals.get("root1")).toBeUndefined()
  })

  it("打开子会话使其 human 未读归零 → 祖先徽标同步下降（展开前后一致）", () => {
    const before = aggregateUnread(
      [
        conv("c-root1", "dm:human_root1", 1),
        conv("c-child1", "dm:child1_human", 2),
        conv("c-grand1", "dm:grand1_human", 4),
      ],
      roster,
    )
    expect(before.get("root1")).toBe(7)
    // 打开 grand1（human 阅读 → conversation.unread=0）后重算。
    const after = aggregateUnread(
      [
        conv("c-root1", "dm:human_root1", 1),
        conv("c-child1", "dm:child1_human", 2),
        conv("c-grand1", "dm:grand1_human", 0),
      ],
      roster,
    )
    expect(after.get("root1")).toBe(3)
    expect(after.get("child1")).toBe(2)
    expect(after.get("grand1")).toBeUndefined()
  })

  it("分组容器（M1）：与容器之间的会话未读不计入任何徽标", () => {
    const withContainer: readonly RosterNode[] = [
      node("human", { kind: "logical", vendor: "human" }),
      node("ctr", { roleTag: "container" }),
    ]
    const totals = aggregateUnread([conv("c-ctr", "dm:ctr_human", 9)], withContainer)
    // 容器不是聊天实体：其（历史）会话未读不产生任何徽标项。
    expect(totals.size).toBe(0)
    expect(totals.get("ctr")).toBeUndefined()
  })

  it("不可归属（不在 roster / 段数异常）会话被跳过，零未读不建项", () => {
    const totals = aggregateUnread(
      [
        conv("c-ghost", "dm:ghost_human", 5),
        conv("c-bad", "dm:root1_a_b", 5),
        conv("c-zero", "dm:human_root1", 0),
      ],
      roster,
    )
    expect(totals.size).toBe(0)
  })
})
