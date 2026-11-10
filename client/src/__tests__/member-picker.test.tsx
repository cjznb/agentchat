// @vitest-environment jsdom
/**
 * Task 11 (BUG-2) —— 选人树展开互斥回归锁：
 * - 原语 `toggleIndependent`：不在→加入、在→移除、**绝不动其它 id**（本 bug 核心语义）
 * - 交互：展开一级 → 展开二级 → **一级仍在展开态**（改前 `toggleExpanded` 单开挤掉一级 → 此用例必红）
 * - 二级子行可见（改前二级随一级卸载，永不可达）
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与既有 tsx 用例同法）；
 * `vi.mock("../store")` 免 WS/fetch；展开态持久化键 `agentchat:expandedPicker` 每例清空防串扰。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { toggleIndependent } from "../accordion"
import { MemberPicker } from "../components/MemberPicker"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 一级 root1 → 二级 child-1 → 三级 grand-1；旁支 child-2；另有一棵 P5 容器子树 box-1 → sess-1。
const rosterFixture = vi.hoisted(() => {
  const build = (
    id: string,
    children: readonly unknown[] = [],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    name: id,
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
    ...extra,
  })
  return [
    build("root1", [build("child-1", [build("grand-1")]), build("child-2")]),
    build("box-1", [build("sess-1")], { role_tag: "container" }),
  ]
})

vi.mock("../store", () => ({
  useStore: () => ({ state: { roster: rosterFixture } }),
}))

describe("toggleIndependent 原语", () => {
  it("不在集合 → 加入", () => {
    expect(toggleIndependent([], "a")).toEqual(["a"])
  })

  it("在集合 → 移除", () => {
    expect(toggleIndependent(["a"], "a")).toEqual([])
  })

  it("加入新 id 时绝不动其它 id（本 bug 核心语义）", () => {
    expect(toggleIndependent(["a"], "b")).toEqual(["a", "b"])
  })
})

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  if (root !== null) {
    const current = root
    act(() => current.unmount())
  }
  host?.remove()
  root = null
  host = null
})

function render(selected: readonly string[] = []): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(<MemberPicker selected={selected} onToggle={() => {}} />)
  })
  return host
}

function toggleOf(el: HTMLElement, nodeId: string): HTMLElement {
  const row = el.querySelector(`[data-testid="member-row"][data-node-id="${nodeId}"]`)
  const button = row?.querySelector('[data-testid="member-toggle"]')
  if (!(button instanceof HTMLElement)) throw new Error(`no toggle for ${nodeId}`)
  return button
}

function headExpanded(el: HTMLElement, nodeId: string): boolean {
  const row = el.querySelector(`[data-testid="member-row"][data-node-id="${nodeId}"]`)
  return row?.querySelector(".picker-head")?.getAttribute("data-expanded") === "true"
}

function click(el: HTMLElement): void {
  act(() => {
    el.click()
  })
}

describe("MemberPicker 展开（BUG-2 回归）", () => {
  it("展开一级 → 展开二级 → 一级仍展开、二级子行可见", () => {
    const el = render()
    // 初始：仅一级行可见
    expect(el.querySelector('[data-node-id="child-1"]')).toBeNull()

    click(toggleOf(el, "root1"))
    expect(headExpanded(el, "root1")).toBe(true)
    expect(toggleOf(el, "root1").getAttribute("aria-expanded")).toBe("true")
    expect(el.querySelector('[data-testid="member-row"][data-node-id="child-1"]')).not.toBeNull()

    click(toggleOf(el, "child-1"))
    // 一级仍在展开态（改前：单开挤掉 root1 → 收起并卸载二级）
    expect(headExpanded(el, "root1")).toBe(true)
    expect(toggleOf(el, "root1").getAttribute("aria-expanded")).toBe("true")
    // 二级子行可见（改前：二级整棵卸载，永不可达）
    expect(headExpanded(el, "child-1")).toBe(true)
    expect(
      el.querySelector('[data-testid="member-row"][data-node-id="grand-1"]'),
    ).not.toBeNull()
  })

  it("再点同一项只收起它自己，不动其它展开项", () => {
    const el = render()
    click(toggleOf(el, "root1"))
    click(toggleOf(el, "child-1"))
    click(toggleOf(el, "child-1"))
    expect(headExpanded(el, "child-1")).toBe(false)
    expect(headExpanded(el, "root1")).toBe(true)
    expect(el.querySelector('[data-node-id="grand-1"]')).toBeNull()
  })
})

// ── P5：容器行保留层级但不可勾选（`role_tag="container"`） ──────────────

function checkOf(el: HTMLElement, nodeId: string): HTMLInputElement {
  const row = el.querySelector(`[data-testid="member-row"][data-node-id="${nodeId}"]`)
  const check = row?.querySelector('[data-testid="member-check"]')
  if (!(check instanceof HTMLInputElement)) throw new Error(`no checkbox for ${nodeId}`)
  return check
}

describe("MemberPicker 容器不可勾选（P5）", () => {
  it("容器行仍在树里（保留层级）、显示「容器」徽标，checkbox 禁用且有说明", () => {
    const el = render()
    const row = el.querySelector('[data-testid="member-row"][data-node-id="box-1"]')
    // 关键：**不从树里过滤掉** —— 容器行必须可见（层级/可展开由行的存在保证）。
    expect(row).not.toBeNull()
    expect(row?.getAttribute("data-container")).toBe("true")
    expect(row?.querySelector('[data-testid="container-badge"]')?.textContent).toBe("容器")

    const check = checkOf(el, "box-1")
    expect(check.disabled).toBe(true)
    expect(check.checked).toBe(false)
    expect(check.getAttribute("title")).toContain("不能加入群聊")
    expect(check.getAttribute("aria-label")).toContain("分组容器")
  })

  it("容器层级保留且可展开：点开容器仍能看到其会话子节点，且子节点可勾选", () => {
    const el = render()
    expect(el.querySelector('[data-node-id="sess-1"]')).toBeNull()
    click(toggleOf(el, "box-1"))
    expect(headExpanded(el, "box-1")).toBe(true)
    expect(el.querySelector('[data-testid="member-row"][data-node-id="sess-1"]')).not.toBeNull()
    expect(checkOf(el, "sess-1").disabled).toBe(false)
  })

  it("点击容器 checkbox 不触发 onToggle（禁用态不产生选中）", () => {
    const toggled: string[] = []
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(<MemberPicker selected={[]} onToggle={(id) => toggled.push(id)} />)
    })
    const check = checkOf(host, "box-1")
    click(check)
    expect(toggled).toEqual([])
    expect(check.checked).toBe(false)
  })

  it("历史选中态含容器时也不显示为已勾选（防御旧选择列表）", () => {
    const el = render(["box-1"])
    expect(checkOf(el, "box-1").checked).toBe(false)
  })

  it("普通节点语义不变：可勾选（容器禁用不外溢）", () => {
    const el = render()
    const check = checkOf(el, "root1")
    expect(check.disabled).toBe(false)
    click(check)
    expect(check.checked).toBe(false) // 受控组件（onToggle 为 no-op）→ 勾选态不落地
  })
})
