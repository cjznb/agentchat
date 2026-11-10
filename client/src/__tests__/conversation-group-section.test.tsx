// @vitest-environment jsdom
/**
 * 批次2 轮C：
 * C1 — 会话列表顶部「群聊」分组头（不可点击 header + 箭头切换、默认收起、
 *       localStorage 持久化 `agentchat:groupSectionExpanded`、群行全部挂分组区、
 *       分组整体置顶于非群行之上、非群行原序回归）。
 * C2 — GroupInfo「添加成员」弹窗多选（遮罩+面板+MemberPicker 内嵌、确认走既有
 *       addGroupMember action、取消/Esc/遮罩关闭不提交、旧 select 入口移除）。
 * 批次2 轮D (F2)：
 * D  — 成员行「移出群聊」两步确认（确认调 removeGroupMember + 刷新、取消不调）、
 *       底部「解散群聊」alertdialog 确认（调 dissolveGroup + 回列表、取消无副作用）。
 * 批次2 修复 (M1)：
 * M1 — 分区渲染 DOM 级回归锁：shout 行默认可见且 DOM 先于群分组头，群分组默认收起。
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（jsdom）。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ConversationSummary, RosterNode } from "../../../shared/contracts"
import { formatListTime } from "../chat"

const storeState = vi.hoisted(() => ({
  conversations: [] as unknown[],
  roster: [] as unknown[],
  openConversationId: null as string | null,
}))

vi.mock("../store", () => ({
  useStore: () => ({ state: storeState, openAndRead: vi.fn() }),
}))

vi.mock("../api", () => ({
  listGroups: vi.fn(async () => [{ id: "g1", name: "测试群", members: ["n1", "n2"] }]),
  addGroupMember: vi.fn(async () => ({})),
  removeGroupMember: vi.fn(async () => undefined),
  dissolveGroup: vi.fn(async () => undefined),
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
    expect(row(el, "g2")).toBeNull()
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

  // ── M1：分区渲染 DOM 级回归锁（此前仅有 fold.test.ts 数据级 + 受损 e2e） ──

  it("M1：shout 行默认可见且 DOM 先于群分组头，群行默认收起仍不渲染", () => {
    storeState.conversations = [
      conversation("sh1", "group", "shout", "全员喊话", 200),
      conversation("g1", "group", "g1", "产品群", 100),
      conversation("d1", "dm", "dm:h1_n1", "节点一私聊", 50),
    ]
    const el = mount(<ConversationList />)
    const shout = el.querySelector('[data-testid="conversation-item"][data-kind="shout"]')
    expect(shout).not.toBeNull()
    const header = find(el, "group-section-header")
    expect(header).not.toBeNull()
    // DOM 顺序：shoutRows 先于群分组头（分区渲染，不聚合进分组区）。
    expect(
      (shout as Node).compareDocumentPosition(header as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // shout 行不属于群分组区（header 父级 = group-section，不含 shout）。
    expect(header?.parentElement?.contains(shout)).toBe(false)
    // 群分组默认收起：分区不改变冻结的默认收起语义。
    expect(el.querySelector('[data-testid="conversation-item"][data-kind="group"]')).toBeNull()
    // 非群行照常可见（分区不吞其他行）。
    expect(row(el, "d1")).not.toBeNull()
  })
})

// ── UI-1 ②-5：会话行信息层级 ────────────────────────────────────────

/** 带最后消息 + 未读 + 时间的群/DM 行夹具（②-5 断言的输入面）。 */
function richConversation(
  id: string,
  kind: "dm" | "group",
  key: string,
  name: string,
  unread: number,
  lastBody: string | null,
): ConversationSummary {
  const lastMessage =
    lastBody === null
      ? null
      : { id: `m-${id}`, seq: 1, from: "n1", body: lastBody, createdAt: Date.now() }
  return {
    id,
    kind,
    key,
    name,
    unread,
    createdAt: Date.now() - 60_000,
    lastMessage,
    participants: [],
    mentions: [],
  } as unknown as ConversationSummary
}

describe("UI-1 ②-5 会话行信息层级（头像/摘要/时间/未读 + 群聊计数）", () => {
  beforeEach(() => {
    localStorage.clear()
    storeState.roster = [
      makeNode("n1", "节点一", "runtime"),
      makeNode("n2", "节点二", "logical"),
    ]
    storeState.conversations = [
      richConversation("g1", "group", "g1", "产品群", 3, "收到，20:00 前给出回归清单。"),
      richConversation("g2", "group", "g2", "运营群", 0, null),
      richConversation("d1", "dm", "dm:h1_n1", "节点一私聊", 1, "分支已推送，等待评审。"),
    ]
    storeState.openConversationId = null
  })

  it("每行有头像/标识 + 摘要 + 时间戳；未读徽标仍在（0 未读不出）", () => {
    const el = mount(<ConversationList />)
    // DM 行（群行默认折叠在分组区里，先展开）。DM 走 fold-root 行：时间在兄弟节点
    // `.fold-meta` 里（行尾列），故取整行 `<li>` 作用域而不是只取可点按钮。
    const dmRow = (row(el, "d1") as Element).closest("li") as Element
    expect(dmRow.querySelector('[data-testid="row-avatar"]')).not.toBeNull()
    expect(dmRow.querySelector('[data-testid="conversation-preview"]')?.textContent).toBe(
      "分支已推送，等待评审。",
    )
    expect(dmRow.querySelector('[data-testid="conversation-time"]')?.textContent).toBeTruthy()
    expect(dmRow.querySelector('[data-testid="unread-badge"]')?.textContent).toBe("1")

    click(find(el, "group-section-toggle"))
    const g1 = row(el, "g1") as Element
    const g2 = row(el, "g2") as Element
    // 群行头像为语义字「群」；无最后消息 → 摘要回落「暂无消息」。
    expect(g1.querySelector('[data-testid="row-avatar"]')?.textContent).toBe("群")
    expect(g2.querySelector('[data-testid="conversation-preview"]')?.textContent).toBe("暂无消息")
    expect(g1.querySelector('[data-testid="unread-badge"]')?.textContent).toBe("3")
    expect(g2.querySelector('[data-testid="unread-badge"]')).toBeNull()
  })

  it("群聊分组头带计数（群聊 2），且默认折叠行为不变", () => {
    const el = mount(<ConversationList />)
    const header = find(el, "group-section-header")
    expect(header?.textContent).toContain("群聊")
    expect(find(el, "group-section-count")?.textContent).toBe("2")
    // 默认收起：计数可见但群行不可见（既有折叠语义零变化）。
    expect(find(el, "group-section-toggle")?.getAttribute("aria-expanded")).toBe("false")
    expect(row(el, "g1")).toBeNull()
    click(find(el, "group-section-toggle"))
    expect(row(el, "g1")).not.toBeNull()
  })

  it("时间戳分级：今天 → HH:MM；昨天 → 昨天（纯函数口径）", () => {
    const now = new Date(2026, 4, 20, 15, 30).getTime()
    expect(formatListTime(new Date(2026, 4, 20, 9, 5).getTime(), now)).toBe("09:05")
    expect(formatListTime(new Date(2026, 4, 19, 23, 59).getTime(), now)).toBe("昨天")
    expect(formatListTime(new Date(2026, 3, 2, 1, 0).getTime(), now)).toBe("4月2日")
    expect(formatListTime(new Date(2025, 11, 31, 1, 0).getTime(), now)).toBe("2025/12/31")
  })

  it("③-9 搜索框过滤会话（名字/摘要），无命中给明确空态", () => {
    const el = mount(<ConversationList />)
    const search = find(el, "conversation-search") as HTMLInputElement
    expect(search).not.toBeNull()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    const type = (text: string): void => {
      act(() => {
        setValue?.call(search, text)
        search.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }

    // 摘要在消息里、不在会话名里 → 按摘要也能命中（DM 行）。
    type("分支已推送")
    expect(row(el, "d1")).not.toBeNull()
    expect(row(el, "g1")).toBeNull()

    type("不存在的关键词")
    expect(find(el, "conversation-no-match")).not.toBeNull()
    expect(row(el, "d1")).toBeNull()

    type("")
    expect(row(el, "d1")).not.toBeNull()
    expect(find(el, "conversation-no-match")).toBeNull()
  })
})

// ── C2：添加成员弹窗 ────────────────────────────────────────────────

describe("C2 GroupInfo 添加成员弹窗", () => {
  beforeEach(() => {
    // groups mock 的成员 = n1/n2（已在群）；n3/n4 为可拉入的新成员（③-8 区分两者的夹具面）。
    storeState.roster = [
      makeNode("n1", "执行者", "runtime"),
      makeNode("n2", "成员乙", "runtime"),
      makeNode("n3", "新人丙", "runtime"),
      makeNode("n4", "新人丁", "runtime"),
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
    // ③-8：搜索框 + 已选计数同排出现。
    expect(find(el, "member-add-search")).not.toBeNull()
    expect(find(el, "member-add-count")?.textContent).toBe("已选 0 名")
  })

  it("③-8 已在群成员标注「已在群」且不可勾选；搜索框按名字过滤", async () => {
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    const rowOf = (id: string): Element | null =>
      el.querySelector(`[data-testid="member-row"][data-node-id="${id}"]`)

    // 已在群（groups mock members=n1,n2）→ 徽标 + 禁用。
    expect(rowOf("n1")?.getAttribute("data-existing")).toBe("true")
    expect(rowOf("n1")?.querySelector('[data-testid="existing-badge"]')?.textContent).toBe("已在群")
    expect(
      (rowOf("n1")?.querySelector('[data-testid="member-check"]') as HTMLInputElement).disabled,
    ).toBe(true)
    // 非成员可勾选。
    expect(rowOf("n3")?.getAttribute("data-existing")).toBeNull()
    expect(
      (rowOf("n3")?.querySelector('[data-testid="member-check"]') as HTMLInputElement).disabled,
    ).toBe(false)

    // 搜索：只留命中的行（层级保留）。React 受控输入需走原生 value setter 才能触发 onChange。
    const search = find(el, "member-add-search") as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    act(() => {
      setValue?.call(search, "新人丁")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(rowOf("n4")).not.toBeNull()
    expect(rowOf("n3")).toBeNull()
    expect(rowOf("n1")).toBeNull()
  })

  it("弹窗内多选两个成员后确认 → addGroupMember 被调用且弹窗关闭", async () => {
    const api = await import("../api")
    const el = await mountGroupInfo()
    click(find(el, "group-add-open"))
    const dialog = find(el, "member-add-dialog") as Element
    // ③-8：已在群的 n1/n2 不可选，取前两个**可勾选**的新成员。
    const checks = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('[data-testid="member-check"]'),
    ).filter((check) => !check.disabled)
    expect(checks.length).toBeGreaterThanOrEqual(2)
    click(checks[0] as Element)
    click(checks[1] as Element)
    expect((checks[0] as HTMLInputElement).checked).toBe(true)
    expect((checks[1] as HTMLInputElement).checked).toBe(true)
    expect(find(el, "member-add-count")?.textContent).toBe("已选 2 名")
    click(find(el, "member-add-confirm"))
    await act(async () => {})
    expect(api.addGroupMember).toHaveBeenCalledTimes(2)
    expect(api.addGroupMember).toHaveBeenCalledWith("g1", "n3")
    expect(api.addGroupMember).toHaveBeenCalledWith("g1", "n4")
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

// ── 批次2 轮D：F2 成员移除 + 解散群聊 ──────────────────────────────

describe("D GroupInfo 移除成员 + 解散群聊", () => {
  beforeEach(() => {
    storeState.roster = [
      makeNode("n1", "执行者", "runtime"),
      makeNode("n2", "成员乙", "runtime"),
    ]
    storeState.conversations = []
    storeState.openConversationId = null
  })

  async function mountInfo(onClose: () => void): Promise<HTMLDivElement> {
    const el = mount(<GroupInfo conversationId="g1" onClose={onClose} />)
    await act(async () => {})
    return el
  }

  it("成员行存在移除按钮 → 两步确认 → removeGroupMember 被调用且列表刷新", async () => {
    const api = await import("../api")
    const el = await mountInfo(() => {})
    expect(find(el, "member-remove")).not.toBeNull()
    click(find(el, "member-remove"))
    expect(find(el, "member-remove-confirm")).not.toBeNull()
    // 初始载入 1 次 + 成功后 refresh 1 次。
    expect(api.listGroups).toHaveBeenCalledTimes(1)
    click(find(el, "member-remove-yes"))
    await act(async () => {})
    expect(api.removeGroupMember).toHaveBeenCalledWith("g1", "n1")
    expect(api.listGroups).toHaveBeenCalledTimes(2)
    expect(find(el, "member-remove-confirm")).toBeNull()
  })

  it("确认态点「取消」→ removeGroupMember 不被调用", async () => {
    const api = await import("../api")
    const el = await mountInfo(() => {})
    click(find(el, "member-remove"))
    expect(find(el, "member-remove-confirm")).not.toBeNull()
    click(find(el, "member-remove-no"))
    await act(async () => {})
    expect(find(el, "member-remove-confirm")).toBeNull()
    expect(api.removeGroupMember).not.toHaveBeenCalled()
    expect(api.listGroups).toHaveBeenCalledTimes(1)
  })

  it("解散按钮 → alertdialog 显式确认 → dissolveGroup 被调用且回到列表", async () => {
    const api = await import("../api")
    const onClose = vi.fn()
    const el = await mountInfo(onClose)
    expect(find(el, "group-dissolve-open")).not.toBeNull()
    click(find(el, "group-dissolve-open"))
    const dialog = find(el, "dissolve-dialog")
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute("role")).toBe("alertdialog")
    expect(find(el, "dissolve-confirm")).not.toBeNull()
    click(find(el, "dissolve-confirm"))
    await act(async () => {})
    expect(api.dissolveGroup).toHaveBeenCalledWith("g1")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("解散确认对话点「取消」→ 无副作用（不调 action、不回列表）", async () => {
    const api = await import("../api")
    const onClose = vi.fn()
    const el = await mountInfo(onClose)
    click(find(el, "group-dissolve-open"))
    expect(find(el, "dissolve-dialog")).not.toBeNull()
    click(find(el, "dissolve-cancel"))
    await act(async () => {})
    expect(find(el, "dissolve-dialog")).toBeNull()
    expect(api.dissolveGroup).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
