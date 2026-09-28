// @vitest-environment jsdom
/**
 * 扁平通讯录评审 Important #2 —— 容器节点「不可 DM」的组件级回归锁（`ContactCard`）：
 * - 容器节点：不渲染 `contact-message`、渲染 `contact-container-note`、角色标签显示「未设置」
 *   （`roleTone("container") === "none"`，不再渲染裸英文 `container` 标签 —— 评审 Minor #1）
 * - 普通节点（对照组，防过度拦截）：`contact-message` 正常渲染
 * - 退役普通节点：按钮仍在但禁用（退役分支不被容器逻辑误伤）
 *
 * `App.tsx` 的 `openDm` 守卫是第二层防御：UI 已无入口触达该分支，由 E2E 断言 + 报告说明覆盖。
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（jsdom 环境）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { RosterNode } from "../../../shared/contracts"
import { ContactCard } from "../components/ContactCard"

// React 19 依 globalThis 标志识别「测试 act 环境」；缺省会打印 act 警告。
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function makeNode(roleTag: string | null, status: RosterNode["status"] = "online"): RosterNode {
  return {
    id: "n1",
    name: "测试节点",
    kind: "runtime",
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status,
    status_text: null,
    purpose: null,
    role_tag: roleTag,
    remark: null,
    skills: [],
    unread: 0,
    children: [],
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null

function renderCard(node: RosterNode): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <ContactCard
        node={node}
        onClose={() => {}}
        onMessage={() => {}}
        onOpenConversation={() => {}}
      />,
    )
  })
  return host
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
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

describe("ContactCard 容器节点（不可 DM）", () => {
  it("容器节点：隐藏「发消息」、显示容器说明、角色标签为「未设置」", () => {
    const el = renderCard(makeNode("container"))
    expect(find(el, "contact-container-note")).not.toBeNull()
    expect(find(el, "contact-message")).toBeNull()
    expect(find(el, "contact-role")).toBeNull()
    expect(el.textContent).toContain("未设置")
    expect(el.textContent).toContain("不能发起对话")
  })

  it("普通节点（对照组）：「发消息」正常渲染且无容器说明", () => {
    const el = renderCard(makeNode("执行者"))
    expect(find(el, "contact-message")).not.toBeNull()
    expect(find(el, "contact-container-note")).toBeNull()
    expect(find(el, "contact-role")).not.toBeNull()
    expect(el.textContent).toContain("执行者")
  })

  it("退役普通节点：「发消息」仍在但禁用（退役分支不受容器逻辑误伤）", () => {
    const el = renderCard(makeNode(null, "retired"))
    expect(find(el, "contact-message")).not.toBeNull()
    expect(find(el, "contact-message")?.hasAttribute("disabled")).toBe(true)
    expect(find(el, "contact-container-note")).toBeNull()
  })
})
