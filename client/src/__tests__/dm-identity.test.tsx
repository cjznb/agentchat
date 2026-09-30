// @vitest-environment jsdom
/**
 * Task 10 / BUG-1 —— 私聊身份行与 `[子·根名]` 徽标门回归锁：
 * - 私聊（`showSender=true, showChildBadge=false`）：非己方消息渲染展示名 + 头像，**不出** `child-badge`
 * - 己方消息：`data-own="true"` 且不渲染身份行（现状保持）
 * - 群聊：`child-badge` 与 `sender-name` 皆渲染（既有语义）
 * - `showChildBadge` 缺省 = true：不传该 prop 与改前行为一致
 * - 分侧：`data-own` 属性值锁定（CSS `row-reverse` 规则存在于 styles.css，不改 CSS）
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与 `revoke-bubble.test.tsx` 同法）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ChatMessage } from "../../../shared/contracts"
import type { SenderView } from "../chat"
import { MessageBubble, type MessageBubbleProps } from "../components/MessageBubble"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    seq: 1,
    id: "m1",
    conversationId: "c1",
    fromAgentId: "child1",
    body: "你好",
    kind: "text",
    createdAt: 1,
    ...overrides,
  }
}

function sender(rootName: string | null = "容器"): SenderView {
  return { id: "child1", name: "小艾", vendor: "claude", rootName }
}

function props(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: message(),
    own: false,
    sender: sender(),
    showSender: true,
    highlighted: false,
    card: null,
    ...overrides,
  }
}

function render(input: MessageBubbleProps): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(<MessageBubble {...input} />)
  })
  return host
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function row(container: HTMLElement): Element {
  const el = find(container, "message-row")
  expect(el).not.toBeNull()
  return el as Element
}

describe("私聊身份行（BUG-1）", () => {
  it("非己方消息渲染展示名与头像、不渲染 child-badge", () => {
    const hostEl = render(props({ showChildBadge: false }))
    const name = hostEl.querySelector(".sender-name")
    expect(name?.textContent).toBe("小艾")
    expect(hostEl.querySelector(".avatar")).not.toBeNull()
    expect(find(hostEl, "vendor-badge")).not.toBeNull()
    expect(find(hostEl, "child-badge")).toBeNull()
  })

  it("己方消息不显示身份行且 data-own=true", () => {
    const hostEl = render(props({ own: true, showChildBadge: false }))
    expect(row(hostEl).getAttribute("data-own")).toBe("true")
    expect(hostEl.querySelector(".sender-name")).toBeNull()
    expect(hostEl.querySelector(".avatar")).toBeNull()
    expect(find(hostEl, "child-badge")).toBeNull()
  })
})

describe("群聊徽标与身份行共存", () => {
  it("showChildBadge=true 时 child-badge 与 sender-name 皆渲染", () => {
    const hostEl = render(props({ showChildBadge: true }))
    expect(find(hostEl, "child-badge")?.textContent).toBe("[子·容器]")
    expect(hostEl.querySelector(".sender-name")?.textContent).toBe("小艾")
  })
})

describe("showChildBadge 缺省行为", () => {
  it("不传 showChildBadge 时徽标照常渲染（与改前一致）", () => {
    const input = props()
    expect("showChildBadge" in input).toBe(false)
    const hostEl = render(input)
    expect(find(hostEl, "child-badge")?.textContent).toBe("[子·容器]")
    expect(hostEl.querySelector(".sender-name")).not.toBeNull()
  })
})

describe("分侧锁定", () => {
  it("非己方 data-own=false，己方 data-own=true", () => {
    expect(row(render(props())).getAttribute("data-own")).toBe("false")
    act(() => root?.unmount())
    host?.remove()
    host = null
    root = null
    expect(row(render(props({ own: true }))).getAttribute("data-own")).toBe("true")
  })

  it("styles.css 存在己方右侧 row-reverse 规则（未改动 CSS）", () => {
    const css = readFileSync(resolve(process.cwd(), "client/src/styles.css"), "utf8")
    expect(css).toMatch(/data-own="true"[\s\S]{0,160}row-reverse/)
  })
})
