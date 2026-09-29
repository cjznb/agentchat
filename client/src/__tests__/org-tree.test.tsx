// @vitest-environment jsdom
/**
 * 通讯录分组重写 —— `OrgTreeList`（纯展示）组件级回归锁：
 * - 默认折叠：仅顶层主 agent 行可见，无子行 / 无 `org-children`
 * - 顶层在线优先稳定排序
 * - 展开某根 → 子行出现、嵌套 `org-children`、子行缩进（`data-depth=1`）且在线优先
 * - 手风琴：展开 B 时 A 的子行不出现（单一展开集由调用方 `expandedIds` 决定）
 * - 容器节点：`container-badge` 可见；行内**无** `org-source`（`↳` 已移除）
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与 `contact-card.test.tsx` 同法）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { RosterNode } from "../../../shared/contracts"
import { OrgTreeList } from "../components/OrgTree"
import { foldTree } from "../treeFold"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function node(
  id: string,
  opts: {
    readonly status?: RosterNode["status"]
    readonly role?: string | null
    readonly children?: readonly RosterNode[]
  } = {},
): RosterNode {
  return {
    id,
    name: id,
    kind: "runtime",
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status: opts.status ?? "online",
    status_text: null,
    purpose: null,
    role_tag: opts.role ?? null,
    remark: null,
    skills: [],
    unread: 0,
    children: opts.children ?? [],
  }
}

// 离线根置首（应被排到末尾）；root1 含 离线前置子级 + 在线/忙碌/退役 子级；容器根含会话子级。
const roster: readonly RosterNode[] = [
  node("offline-root", { status: "offline" }),
  node("root1", {
    children: [
      node("offline-child", { status: "offline" }),
      node("online-child"),
      node("busy-child", { status: "busy" }),
      node("retired-child", { status: "retired" }),
    ],
  }),
  node("container", {
    role: "container",
    children: [node("session")],
  }),
]

let host: HTMLDivElement | null = null
let root: Root | null = null

function render(expandedIds: readonly string[]): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <OrgTreeList
        rows={foldTree(roster)}
        expandedIds={expandedIds}
        selectedId={null}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    )
  })
  return host
}

function rowIds(el: HTMLElement): readonly string[] {
  return Array.from(el.querySelectorAll('[data-testid="org-row"]')).map(
    (row) => row.getAttribute("data-node-id") ?? "",
  )
}

afterEach(() => {
  if (root !== null) {
    const current = root
    act(() => current.unmount())
  }
  host?.remove()
  root = null
  host = null
})

describe("OrgTreeList 分组折叠", () => {
  it("默认折叠：仅顶层行，无子行 / 无 org-children / 无 org-source（↳ 已移除）", () => {
    const el = render([])
    expect(rowIds(el)).toEqual(["root1", "container", "offline-root"])
    expect(el.querySelectorAll('[data-testid="org-children"]')).toHaveLength(0)
    expect(el.querySelectorAll('[data-testid="org-source"]')).toHaveLength(0)
    // 仅有子节点的顶层行才有折叠把手；叶子根用占位。
    expect(el.querySelectorAll('[data-testid="org-toggle"]')).toHaveLength(2)
  })

  it("顶层折叠把手 aria-expanded=false，叶子根无折叠按钮", () => {
    const el = render([])
    const toggles = el.querySelectorAll('[data-testid="org-toggle"]')
    for (const toggle of Array.from(toggles)) {
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
    }
    // offline-root 是叶子（无子节点）→ 只有占位 span，不渲染可点 toggle。
    const offlineRow = el.querySelector('[data-testid="org-row"][data-node-id="offline-root"]')
    expect(offlineRow?.querySelector('[data-testid="org-toggle"]')).toBeNull()
    expect(offlineRow?.querySelector(".org-toggle.is-placeholder")).not.toBeNull()
  })

  it("展开 root1：子行出现、嵌套 org-children、depth=1、且在线优先稳定", () => {
    const el = render(["root1"])
    expect(el.querySelectorAll('[data-testid="org-children"]')).toHaveLength(1)
    const root1Row = el.querySelector('[data-testid="org-row"][data-node-id="root1"]')
    expect(root1Row?.getAttribute("data-expanded")).toBe("true")
    const children = Array.from(
      el.querySelectorAll('[data-testid="org-row"][data-depth="1"]'),
    ).map((row) => row.getAttribute("data-node-id"))
    expect(children).toEqual(["online-child", "busy-child", "offline-child", "retired-child"])
    const toggle = root1Row?.querySelector('[data-testid="org-toggle"]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
  })

  it("手风琴：展开 container 时 root1 的子行不出现（单一展开集）", () => {
    const el = render(["container"])
    expect(rowIds(el)).toEqual(["root1", "container", "session", "offline-root"])
    expect(rowIds(el)).not.toContain("online-child")
    const containerRow = el.querySelector('[data-testid="org-row"][data-node-id="container"]')
    expect(containerRow?.querySelector('[data-testid="container-badge"]')?.textContent).toBe("容器")
  })
})
