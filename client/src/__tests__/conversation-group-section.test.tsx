// @vitest-environment jsdom
/**
 * 批次2 轮C：
 * C1 — 会话列表顶部「群聊」分组头（不可点击 header + 箭头切换、默认收起、
 *       localStorage 持久化 `agentchat:groupSectionExpanded`、群行全部挂分组区、
 *       分组整体置顶于非群行之上、非群行原序回归）。
 * C2 — GroupInfo「添加成员」弹窗多选（遮罩+面板+MemberPicker 内嵌、确认走既有
 *       addGroupMember action、取消/Esc/遮罩关闭不提交、旧 select 入口移除）。
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（jsdom）。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ConversationSummary, RosterNode } from "../../../shared/contracts"

const storeState = vi.hoisted(() => ({
  conversations: [] as unknown[],
  roster: [] as unknown[],
  openConversationId: null as string | null,
}))

vi.mock("../store", () => ({
  useStore: () => ({ state: storeState, openAndRead: vi.fn() }),
}))

vi.mock("../api", () => ({
  listGroups: vi.fn(async () => [{ id: "g1", name: "测试群", members: [] }]),
  addGroupMember: vi.fn(async () => ({})),
  renameAgent: vi.fn(async () => ({})),
  renameErrorMessage: vi.fn(() => "改名失败"),
  ApiError: class ApiError extends Error {},
}))

import { ConversationList } from "../components/ConversationList"
import { GroupInfo } from "../components/GroupInfo"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const GROUP_KEY = "agentchat:groupSectionExpanded"

function makeNode(id: string, name: string, kind: "runtime" | "logical"): RosterNode {
  return {
    id,
    name,
    kind,
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
    children: [],
  }
}

function conversation(
  id: string,
  kind: "dm" | "group",
  key: string,
  name: string,
  createdAt: number,
): ConversationSummary {
  return {
    id,
    kind,
    key,
    name,
    unread: 0,
    createdAt,
    lastMessage: null,
    participants: [],
    mentions: [],
  } as unknown as ConversationSummary
}

let host: HTMLDivElement | null = null
let root: Root | null = null

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(node)
  })
  return host
}

function find(container: ParentNode, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function row(container: ParentNode, conversationId: string): Element | null {
  return container.querySelector(
    `[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
  )
}

function click(el: Element | null | undefined): void {
  expect(el).not.toBeNull()
  act(() => {
    ;(el as HTMLElement).click()
  })
}

afterEach(() => {
  if (root !== null) {
    const current = root
    act(() => current.unmount())
  }
  host?.remove()
  host = null
  root = null
  vi.clearAllMocks()
  localStorage.clear()
})

// ── C1：群聊分组头 ──────────────────────────────────────────────────

function seedC1(): void {
  storeState.roster = [
    makeNode("n1", "节点一", "logical"),
    makeNode("n2", "节点二", "logical"),
  ]
  storeState.conversations = [
    conversation("g1", "group", "g1", "产品群", 100),
    conversation("d1", "dm", "dm:h1_n1", "节点一私聊", 50),
    conversation("g2", "group", "g2", "运营群", 100),
    conversation("d2", "dm", "dm:h1_n2", "节点二私聊", 50),
  ]
  storeState.openConversationId = null
}

describe("C1 会话列表群聊分组头", () => {
  beforeEach(() => {
    localStorage.clear()
    seedC1()
  })

  it("顶部存在不可点击的「群聊」分组头 + 可访问的展开箭头", () => {
    const el = mount(<ConversationList />)
    const header = find(el, "group-section-header")
    expect(header).not.toBeNull()
    expect((header as Element).tagName).not.toBe("BUTTON")
    expect(header?.textContent).toContain("群聊")
    const toggle = find(el, "group-section-toggle")
    expect(toggle).not.toBeNull()
    expect((toggle as Element).tagName).toBe("BUTTON")
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    expect(toggle?.getAttribute("aria-label")).toBeTruthy()
  })

  it("默认收起：群会话行不可见，普通会话照常可见", () => {
    const el = mount(<ConversationList />)
    expect(row(el, "g1")).toBeNull()
    expect(row(el, "g2")).toBeNull()
    expect(row(el, "d1")).not.toBeNull()
    expect(row(el, "d2")).not.toBeNull()
  })

  it("点击箭头展开：群行可见且 localStorage 落值", () => {
    const el = mount(<ConversationList />)
    click(find(el, "group-section-toggle"))
    expect(row(el, "g1")).not.toBeNull()
    expect(row(el, "g2")).not.toBeNull()
    expect(find(el, "group-section-toggle")?.getAttribute("aria-expanded")).toBe("true")
    expect(localStorage.getItem(GROUP_KEY)).toBe("true")
  })

  it("持久化恢复：预置 localStorage 后刷新态为展开", () => {
    localStorage.setItem(GROUP_KEY, "true")
    const el = mount(<ConversationList />)
    expect(row(el, "g1")).not.toBeNull()
    expect(find(el, "group-section-toggle")?.getAttribute("aria-expanded")).toBe("true")
  })

  it("再次点击收起并回写 localStorage", () => {
    const el = mount(<ConversationList />)
    const toggle = find(el, "group-section-toggle")
    click(toggle)
    click(toggle)
    expect(row(el, "g1")).toBeNull()
    expect(localStorage.getItem(GROUP_KEY)).toBe("false")
    expect(find(el, "group-section-toggle")?.getAttribute("aria-expanded")).toBe("false")
  })

  it("群行全在分组区之下、分组区整体先于非群行、非群行原序不变", () => {
    const el = mount(<ConversationList />)
    click(find(el, "group-section-toggle"))
    const header = find(el, "group-section-header")
    const section = find(el, "group-section")
    expect(header).not.toBeNull()
    expect(section).not.toBeNull()
    expect(header?.parentElement).toBe(section)

    const g1 = row(el, "g1")
    const g2 = row(el, "g2")
    const d1 = row(el, "d1")
    const d2 = row(el, "d2")
    expect(g1).not.toBeNull()
    expect(g2).not.toBeNull()
    expect(d1).not.toBeNull()
    expect(d2).not.toBeNull()

    // 群行都在分组区内且在分组头之后
    expect(section?.contains(g1)).toBe(true)
    expect(section?.contains(g2)).toBe(true)
    expect(
      (header as Node).compareDocumentPosition(g1 as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      (header as Node).compareDocumentPosition(g2 as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 分组区整体先于所有非群行
    for (const other of [d1, d2]) {
      expect(
        (section as Node).compareDocumentPosition(other as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    // 非群行相对顺序回归：d1 先于 d2
    expect(
      (d1 as Node).compareDocumentPosition(d2 as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("分组头不承载会话点击：内部无 conversation-item", () => {
    const el = mount(<ConversationList />)
    const header = find(el, "group-section-header")
    expect(header?.querySelector('[data-testid="conversation-item"]')).toBeNull()
  })
})

// ── C2：添加成员弹窗 ────────────────────────────────────────────────

describe("C2 GroupInfo 添加成员弹窗", () => {
  beforeEach(() => {
    storeState.roster = [
      makeNode("n1", "执行者", "runtime"),
      makeNode("n2", "成员乙", "runtime"),
    ]
    storeState.conversations = []
    storeState.openConversationId = null
  })

  async function mountGroupInfo(): Promise<HTMLDivElement> {
    const el = mount(<GroupInfo conversationId="g1" onClose={() => {}} />)
    await act(async () => {})
    return el
  }

  it("点「添加成员」→ 弹窗出现，MemberPicker 内嵌其中，旧 select 入口移除", async () => {
    const el = await mountGroupInfo()
    expect(find(el, "group-add-select")).toBeNull()
    expect(find(el, "member-add-dialog")).toBeNull()
    click(find(el, "group-add-open"))
    const dialog = find(el, "member-add-dialog")
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute("role")).toBe("dialog")
    expect(dialog?.getAttribute("aria-label")).toBeTruthy()
    expect(find(el, "member-add-overlay")).not.toBeNull()
    expect(dialog?.querySelector('[data-testid="member-picker"]')).not.toBeNull()
    expect(find(el, "member-add-confirm")).not.toBeNull()
    expect(find(el, "member-add-cancel")).not.toBeNull()
  })

  it("弹窗内多选两个成员后确认 → addGroupMember 被调用且弹窗关闭", async () => {
    const api = await import("../api")
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    const dialog = find(el, "member-add-dialog") as Element
    const checks = dialog.querySelectorAll('[data-testid="member-check"]')
    expect(checks.length).toBeGreaterThanOrEqual(2)
    click(checks[0])
    click(checks[1])
    expect((checks[0] as HTMLInputElement).checked).toBe(true)
    expect((checks[1] as HTMLInputElement).checked).toBe(true)
    click(find(el, "member-add-confirm"))
    await act(async () => {})
    expect(api.addGroupMember).toHaveBeenCalledTimes(2)
    expect(api.addGroupMember).toHaveBeenCalledWith("g1", "n1")
    expect(api.addGroupMember).toHaveBeenCalledWith("g1", "n2")
    expect(find(el, "member-add-dialog")).toBeNull()
  })

  it("取消 → 弹窗关闭且 action 未被调用", async () => {
    const api = await import("../api")
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    const checks = (find(el, "member-add-dialog") as Element).querySelectorAll(
      '[data-testid="member-check"]',
    )
    click(checks[0])
    click(find(el, "member-add-cancel"))
    await act(async () => {})
    expect(find(el, "member-add-dialog")).toBeNull()
    expect(api.addGroupMember).not.toHaveBeenCalled()
  })

  it("Esc 关闭且不提交", async () => {
    const api = await import("../api")
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    await act(async () => {})
    expect(find(el, "member-add-dialog")).toBeNull()
    expect(api.addGroupMember).not.toHaveBeenCalled()
  })

  it("点遮罩关闭且不提交", async () => {
    const api = await import("../api")
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    click(find(el, "member-add-overlay"))
    await act(async () => {})
    expect(find(el, "member-add-dialog")).toBeNull()
    expect(api.addGroupMember).not.toHaveBeenCalled()
  })
})
