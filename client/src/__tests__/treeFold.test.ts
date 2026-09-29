/**
 * Plan 3 T6 —— 组织树纯函数单测（矩阵：human 过滤 / 在线优先稳定排序 / 摘要 / 徽标 /
 * role 颜色 / 状态点 / 手风琴 + localStorage 容错 / 行结构无 ↳ 标注）。
 */
import { describe, expect, it } from "vitest"
import type { AgentStatus, RosterNode } from "../../../shared/contracts"
import type { StorageLike } from "../accordion"
import {
  EXPANDED_TREE_KEY,
  foldTree,
  isContainerNode,
  isHuman,
  loadExpandedTree,
  roleTone,
  saveExpandedTree,
  statusGlyph,
  statusLabel,
  statusRank,
  summarize,
  toggleTreeRow,
  visibleChildren,
} from "../treeFold"

function node(
  id: string,
  opts: {
    readonly kind?: "runtime" | "logical"
    readonly status?: AgentStatus
    readonly vendor?: string
    readonly role?: string | null
    readonly unread?: number
    readonly children?: readonly RosterNode[]
  } = {},
): RosterNode {
  return {
    id,
    name: id,
    kind: opts.kind ?? "runtime",
    parent_id: null,
    vendor: opts.vendor ?? "opencode",
    model: "m",
    status: opts.status ?? "online",
    status_text: null,
    purpose: null,
    role_tag: opts.role ?? null,
    remark: null,
    skills: [],
    unread: opts.unread ?? 0,
    children: opts.children ?? [],
  }
}

// root1{ child1, child2(busy), child3(retired) } / root2{ child4 } / logi(logical, offline)
const roster: readonly RosterNode[] = [
  node("human", { kind: "logical", vendor: "human" }),
  node("root1", {
    unread: 5,
    children: [
      node("child1"),
      node("child2", { status: "busy" }),
      node("child3", { status: "retired" }),
    ],
  }),
  node("root2", { children: [node("child4")] }),
  node("logi", { kind: "logical", status: "offline" }),
]

describe("foldTree", () => {
  it("第一层 = 根主 agent + 逻辑节点；human 从顶层过滤", () => {
    const rows = foldTree(roster)
    expect(rows.map((row) => row.node.id)).toEqual(["root1", "root2", "logi"])
    expect(rows.some((row) => row.node.id === "human")).toBe(false)
  })

  it("human 子节点从子行过滤，但非 human 子行按键顺序保留", () => {
    const withHumanChild = node("r", {
      children: [node("a"), node("h", { vendor: "human" }), node("b")],
    })
    expect(visibleChildren(withHumanChild).map((n) => n.id)).toEqual(["a", "b"])
    expect(foldTree([withHumanChild])[0]?.children.map((row) => row.node.id)).toEqual(["a", "b"])
  })

  it("行徽标取传入的全子树聚合表（缺省 0）；逻辑节点行 logical 标记", () => {
    // 树行徽标由调用方传入 aggregateUnread 结果（human 观察者全子树口径：自身 + 全部后代）。
    const unread = new Map<string, number>([["root1", 5], ["child1", 2]])
    const rows = foldTree(roster, unread)
    const root1 = rows.find((row) => row.node.id === "root1")
    expect(root1?.unread).toBe(5)
    expect(root1?.children[0]?.unread).toBe(2)
    expect(rows.find((row) => row.node.id === "logi")?.unread).toBe(0)
    expect(rows.find((row) => row.node.id === "logi")?.logical).toBe(true)
    expect(rows.find((row) => row.node.id === "logi")?.retired).toBe(false)
    // 缺省表 → 无徽标（MemberPicker 等不展示未读的场景）。
    expect(foldTree(roster).find((row) => row.node.id === "root1")?.unread).toBe(0)
  })

  it("退役子级仍留原位（retired 标记）", () => {
    const root1 = foldTree(roster).find((row) => row.node.id === "root1")
    expect(root1?.children.find((row) => row.node.id === "child3")?.retired).toBe(true)
    expect(root1?.children.find((row) => row.node.id === "child1")?.retired).toBe(false)
  })

  it("isHuman 按 vendor 判定", () => {
    expect(isHuman(node("h", { vendor: "human" }))).toBe(true)
    expect(isHuman(node("a"))).toBe(false)
  })
})

describe("在线优先排序（顶层 + 各层子节点）", () => {
  it("statusRank：online/busy 并列最优，offline 次之，retired 最后", () => {
    expect(statusRank("online")).toBe(0)
    expect(statusRank("busy")).toBe(0)
    expect(statusRank("offline")).toBe(1)
    expect(statusRank("retired")).toBe(2)
  })

  it("顶层根：离线根被排到全部在线根之后（即便注册更早）", () => {
    const rows = foldTree([
      node("offline-root", { status: "offline" }),
      node("online-root"),
      node("busy-root", { status: "busy" }),
      node("retired-root", { status: "retired" }),
    ])
    expect(rows.map((row) => row.node.id)).toEqual([
      "online-root",
      "busy-root",
      "offline-root",
      "retired-root",
    ])
  })

  it("同级内稳定：同权重保持 roster 原有相对顺序", () => {
    const rows = foldTree([
      node("online-a"),
      node("offline-x", { status: "offline" }),
      node("busy-b", { status: "busy" }),
      node("online-c"),
      node("offline-y", { status: "offline" }),
    ])
    expect(rows.map((row) => row.node.id)).toEqual([
      "online-a",
      "busy-b",
      "online-c",
      "offline-x",
      "offline-y",
    ])
  })

  it("子节点同样在线优先稳定（离线子级从队首移到 busy 之后、退役之前）", () => {
    const root = node("r", {
      children: [
        node("offline-child", { status: "offline" }),
        node("online-child"),
        node("busy-child", { status: "busy" }),
        node("retired-child", { status: "retired" }),
      ],
    })
    expect(foldTree([root])[0]?.children.map((row) => row.node.id)).toEqual([
      "online-child",
      "busy-child",
      "offline-child",
      "retired-child",
    ])
  })
})

describe("TreeRow 行结构（无 ↳ 来源标注）", () => {
  it("行不含 parentName 字段；归属由嵌套 children 表达", () => {
    const [root1] = foldTree(roster).filter((row) => row.node.id === "root1")
    expect(root1).toBeDefined()
    expect(root1).not.toHaveProperty("parentName")
    expect(root1?.children.map((row) => row.node.id)).toContain("child1")
    // 子行不再携带父名字段（缩进表达归属）。
    expect(root1?.children[0]).not.toHaveProperty("parentName")
  })
})

describe("summarize（N子·M忙）", () => {
  it("直接可见子级数量 + busy 数；退役计入数量不计 busy", () => {
    const root1 = roster.find((n) => n.id === "root1")
    if (root1 === undefined) throw new Error("root1 missing")
    expect(summarize(root1)).toEqual({ count: 3, busy: 1, text: "3子·1忙" })
  })

  it("无子级 → 0子·0忙", () => {
    expect(summarize(node("leaf")).text).toBe("0子·0忙")
  })

  it("human 子级不计入摘要", () => {
    const mixed = node("r", {
      children: [node("a", { status: "busy" }), node("h", { vendor: "human", status: "busy" })],
    })
    expect(summarize(mixed)).toEqual({ count: 1, busy: 1, text: "1子·1忙" })
  })
})

describe("折叠父行未读合计（复用全子树聚合口径）", () => {
  it("父行徽标 = aggregateUnread 全子树值（含全部子级未读，≥ 任一子行）", () => {
    // root1 子级各有未读 2 / 3；全子树聚合（子级之和 + 自身 1）= 6 落在父行。
    const unread = new Map<string, number>([["root1", 6], ["child1", 2], ["child2", 3]])
    const root1 = foldTree(roster, unread).find((row) => row.node.id === "root1")
    if (root1 === undefined) throw new Error("root1 missing")
    const childSum = root1.children.reduce((sum, child) => sum + child.unread, 0)
    expect(root1.unread).toBe(6)
    expect(root1.unread).toBeGreaterThanOrEqual(childSum)
    expect(childSum).toBe(5)
  })
})

describe("roleTone（执行者/组织者/监管者 + 兜底）", () => {
  it("三个已知角色各自映射", () => {
    expect(roleTone("执行者")).toBe("executor")
    expect(roleTone("组织者")).toBe("organizer")
    expect(roleTone("监管者")).toBe("supervisor")
  })

  it("未知值兜底 other；null/空串/空白 → none", () => {
    expect(roleTone("留言板")).toBe("other")
    expect(roleTone(null)).toBe("none")
    expect(roleTone("")).toBe("none")
    expect(roleTone("   ")).toBe("none")
  })

  it("container → none（容器徽标接管，不渲染裸英文角色标签 —— 评审 Minor #1）", () => {
    expect(roleTone("container")).toBe("none")
  })
})

describe("isContainerNode（容器判定单源，评审 Minor #2）", () => {
  it("role_tag=container → true", () => {
    expect(isContainerNode(node("inst", { role: "container" }))).toBe(true)
  })

  it("普通角色 / null → false", () => {
    expect(isContainerNode(node("a", { role: "执行者" }))).toBe(false)
    expect(isContainerNode(node("b"))).toBe(false)
  })
})

describe("状态点字形/标签", () => {
  it("四态字形与标签逐字锁定", () => {
    expect((["online", "busy", "offline", "retired"] as const).map(statusGlyph)).toEqual([
      "🟢",
      "🟠",
      "⚪",
      "⚫",
    ])
    expect((["online", "busy", "offline", "retired"] as const).map(statusLabel)).toEqual([
      "在线",
      "忙碌",
      "离线",
      "退役",
    ])
  })
})

describe("组织树展开态（手风琴 + localStorage）", () => {
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

  it("手风琴状态机：展开新节点只保留它，再点已展开的节点则收起", () => {
    expect(toggleTreeRow([], "root1")).toEqual(["root1"])
    expect(toggleTreeRow(["root1"], "root2")).toEqual(["root2"])
    expect(toggleTreeRow(["root1"], "root1")).toEqual([])
  })

  it("写入后读回一致（键已版本化为 agentchat:expandedTree:v2）", () => {
    const storage = new FakeStorage()
    saveExpandedTree(storage, ["root1"])
    expect(storage.getItem(EXPANDED_TREE_KEY)).toBe('["root1"]')
    expect(loadExpandedTree(storage)).toEqual(["root1"])
  })

  it("旧键（扁平化前 agentchat:expandedTree）存在时仍默认折叠（评审 Important #1）", () => {
    const storage = new FakeStorage()
    storage.seed("agentchat:expandedTree", '["root1"]')
    // 版本化后旧键值被忽略 → 默认折叠（不沿用裸节点 id 的旧语义）。
    expect(loadExpandedTree(storage)).toEqual([])
  })

  it("坏 JSON / 非字符串数组 / 空存储 / null → 空数组（容错）", () => {
    const storage = new FakeStorage()
    storage.seed(EXPANDED_TREE_KEY, "{not json")
    expect(loadExpandedTree(storage)).toEqual([])
    storage.seed(EXPANDED_TREE_KEY, '{"a":1}')
    expect(loadExpandedTree(storage)).toEqual([])
    storage.seed(EXPANDED_TREE_KEY, '["a",1,null]')
    expect(loadExpandedTree(storage)).toEqual(["a"])
    expect(loadExpandedTree(new FakeStorage())).toEqual([])
    expect(loadExpandedTree(null)).toEqual([])
  })
})
