// @vitest-environment jsdom
/**
 * feat/revoke-queued —— `MessageBubble` 撤回渲染组件级回归锁：
 * - 撤回按钮可见性：己方 + 仍有未送达副本才显示；全部送达 / 非己方 → 隐藏
 * - 已撤回：己方 → 「已撤回」占位（原正文不再展示）；对方 → 保留原文 + 「已撤回」标记
 * - kind='system' 沿用既有居中弱化系统行
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与 `contact-card.test.tsx` 同法）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ChatMessage, ReceiptStage, ReceiptView } from "../../../shared/contracts"
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

function receipt(agentId: string, stage: ReceiptStage): ReceiptView {
  return { agentId, stage }
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    seq: 1,
    id: "m1",
    conversationId: "c1",
    fromAgentId: "human",
    body: "原始正文",
    kind: "text",
    createdAt: 1,
    ...overrides,
  }
}

function props(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: message(),
    own: false,
    sender: undefined,
    showSender: false,
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

describe("MessageBubble 撤回入口", () => {
  it("己方且有未送达副本 → 显示撤回按钮", () => {
    const container = render(
      props({
        message: message({ receipts: [receipt("root", "queued")], receiptStage: "queued" }),
        own: true,
        onRevoke: () => {},
      }),
    )
    expect(find(container, "revoke-button")).not.toBeNull()
  })

  it("全部已读/送达 或 非己方 → 隐藏撤回按钮", () => {
    const delivered = render(
      props({
        message: message({ receipts: [receipt("root", "read")], receiptStage: "read" }),
        own: true,
        onRevoke: () => {},
      }),
    )
    expect(find(delivered, "revoke-button")).toBeNull()

    const peer = render(
      props({
        message: message({
          fromAgentId: "root",
          receipts: [receipt("root", "queued")],
        }),
        own: false,
        onRevoke: () => {},
      }),
    )
    expect(find(peer, "revoke-button")).toBeNull()
  })

  it("撤回中 → 按钮禁用", () => {
    const container = render(
      props({
        message: message({ receipts: [receipt("root", "sending")], receiptStage: "sending" }),
        own: true,
        onRevoke: () => {},
        revoking: true,
      }),
    )
    const button = find(container, "revoke-button")
    expect(button?.hasAttribute("disabled")).toBe(true)
    expect(button?.textContent).toContain("撤回中")
  })
})

describe("MessageBubble 撤回后展示", () => {
  it("己方已撤回 → 占位「此消息已撤回」，原正文不再展示", () => {
    const container = render(props({ message: message({ revoked_at: 5, body: "机密原文" }), own: true }))
    const placeholder = find(container, "revoke-placeholder")
    expect(placeholder?.textContent).toContain("此消息已撤回")
    expect(container.textContent).not.toContain("机密原文")
    expect(find(container, "revoke-button")).toBeNull()
  })

  it("对方已撤回 → 保留原文并加「已撤回」标记", () => {
    const container = render(
      props({ message: message({ revoked_at: 5, fromAgentId: "root", body: "对方原文" }), own: false }),
    )
    expect(find(container, "revoke-mark")?.textContent).toContain("已撤回")
    expect(container.textContent).toContain("对方原文")
    expect(find(container, "revoke-placeholder")).toBeNull()
  })
})

describe("MessageBubble 系统行", () => {
  it("撤回提醒（kind='system'）渲染为居中弱化系统行", () => {
    const container = render(
      props({
        message: message({
          kind: "system",
          meta: { reason: "revoke", revokedMessageId: "m0" },
          body: "（系统）此消息已被发送方撤回：原始正文",
        }),
      }),
    )
    const row = find(container, "message-system")
    expect(row).not.toBeNull()
    expect(row?.className).toContain("is-system")
    expect(container.textContent).toContain("已被发送方撤回")
    expect(find(container, "message-row")).toBeNull()
  })
})
