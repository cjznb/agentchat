// @vitest-environment jsdom
/**
 * 轮 2 TDD：MessageBubble MD⇄原文切换 + 复制（先红后绿）。
 * 渲染工具照抄 revoke-bubble.test.tsx 惯例（react-dom/client + react#act，无测试库）。
 * 覆盖：默认 all→md / off→raw / agent 范围×归属 / toggle 覆盖与 notify 即时换 /
 * copy 已复制 1.5s 复原与 reject 静默 / system·卡·撤回无按钮。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ChatMessage } from "../../../shared/contracts"
import type { CardData } from "../cards"
import { MessageBubble, type MessageBubbleProps } from "../components/MessageBubble"
import { STORAGE_KEY, notify } from "../mdScope"

// ChatCard 依赖 StoreProvider（见 cards.test.tsx）；此处只锁气泡分支，卡片体无关 → 打桩。
vi.mock("../components/Cards", () => ({ ChatCard: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
  Reflect.deleteProperty(navigator, "clipboard")
  vi.useRealTimers()
})

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

function setScope(scope: string): void {
  window.localStorage.setItem(STORAGE_KEY, scope)
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

function sender(overrides: Partial<{ id: string; name: string; vendor: string; rootName: string | null }> = {}) {
  return { id: "root", name: "Root", vendor: "opencode", rootName: null, ...overrides }
}

describe("默认范围 → MD 路径", () => {
  it("scope=all（默认，storage 缺失）→ **粗体** 渲染为 <strong>", () => {
    const container = render(props({ message: message({ body: "**粗体**" }) }))
    expect(container.querySelector("strong")?.textContent).toBe("粗体")
  })

  it("scope=off → 纯文本原样（无 MD 元素）", () => {
    setScope("off")
    const container = render(props({ message: message({ body: "**粗体**" }) }))
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toContain("**粗体**")
  })
})

describe("scope=agent × 消息归属", () => {
  it("agent 消息（非己方、vendor 非 human）→ md", () => {
    setScope("agent")
    const container = render(
      props({ message: message({ body: "**粗体**", fromAgentId: "root" }), sender: sender() }),
    )
    expect(container.querySelector("strong")?.textContent).toBe("粗体")
  })

  it("人类消息（own=true）→ raw", () => {
    setScope("agent")
    const container = render(
      props({ message: message({ body: "**粗体**" }), own: true }),
    )
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toContain("**粗体**")
  })

  it("人类消息（非己方但 sender vendor=human）→ raw", () => {
    setScope("agent")
    const container = render(
      props({
        message: message({ body: "**粗体**", fromAgentId: "u1" }),
        sender: sender({ id: "u1", vendor: "human" }),
      }),
    )
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toContain("**粗体**")
  })
})

describe("MD⇄原文 toggle", () => {
  it("点击翻转视图；手动覆盖后 scope notify 不再改它", () => {
    const container = render(props({ message: message({ body: "**粗体**" }) }))
    const toggle = find(container, "bubble-md-toggle")
    expect(toggle).not.toBeNull()
    expect(toggle?.textContent).toBe("看原文") // 当前 md → 可切往原文
    expect(container.querySelector("strong")).not.toBeNull()

    click(toggle as Element)
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toContain("**粗体**")
    expect(find(container, "bubble-md-toggle")?.textContent).toBe("看排版")

    // 已手动覆盖 → 任何 scope 广播都不得改视图
    act(() => notify("all"))
    expect(container.querySelector("strong")).toBeNull()
    act(() => notify("off"))
    expect(container.querySelector("strong")).toBeNull()
  })

  it("未覆盖时 scope notify → 即时换 view", () => {
    const container = render(props({ message: message({ body: "**粗体**" }) }))
    expect(container.querySelector("strong")).not.toBeNull()

    act(() => notify("off"))
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toContain("**粗体**")

    act(() => notify("all"))
    expect(container.querySelector("strong")).not.toBeNull()
  })
})

describe("复制按钮", () => {
  it("点击 → writeText 收到原文 body；「已复制」1.5s 后复原", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    const container = render(props({ message: message({ body: "**原文** @A" }) }))
    const copy = find(container, "bubble-copy")
    expect(copy).not.toBeNull()
    expect(copy?.textContent).toBe("复制")

    await act(async () => {
      ;(copy as Element).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith("**原文** @A")
    expect(find(container, "bubble-copy")?.textContent).toBe("已复制")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600))
    })
    expect(find(container, "bubble-copy")?.textContent).toBe("复制")
  })

  it("clipboard 缺失 / writeText reject → 静默（不改文案、无未捕获异常）", async () => {
    const container = render(props({ message: message({ body: "abc" }) }))
    const copy = find(container, "bubble-copy") as Element
    // 缺失：直接点击不炸
    act(() => {
      copy.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(find(container, "bubble-copy")?.textContent).toBe("复制")

    // reject：吞掉，不改文案
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    await act(async () => {
      copy.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith("abc")
    expect(find(container, "bubble-copy")?.textContent).toBe("复制")
  })
})

describe("system / 卡 / 撤回占位 → 无按钮", () => {
  it("kind=system → 无 toggle 与 copy", () => {
    const container = render(
      props({ message: message({ kind: "system", body: "系统提示" }) }),
    )
    expect(find(container, "bubble-md-toggle")).toBeNull()
    expect(find(container, "bubble-copy")).toBeNull()
  })

  it("审批/批示卡 → 无 toggle 与 copy", () => {
    const container = render(
      props({
        message: message({ kind: "system", body: "卡片" }),
        card: {} as CardData,
      }),
    )
    expect(find(container, "message-card")).not.toBeNull()
    expect(find(container, "bubble-md-toggle")).toBeNull()
    expect(find(container, "bubble-copy")).toBeNull()
  })

  it("己方撤回占位 → 无 toggle 与 copy", () => {
    const container = render(
      props({ message: message({ revoked_at: 5, body: "机密" }), own: true }),
    )
    expect(find(container, "revoke-placeholder")).not.toBeNull()
    expect(find(container, "bubble-md-toggle")).toBeNull()
    expect(find(container, "bubble-copy")).toBeNull()
  })

  it("对方撤回标记（保留原文）→ 无 toggle 与 copy", () => {
    const container = render(
      props({ message: message({ revoked_at: 5, body: "对方原文" }), own: false }),
    )
    expect(find(container, "revoke-mark")).not.toBeNull()
    expect(find(container, "bubble-md-toggle")).toBeNull()
    expect(find(container, "bubble-copy")).toBeNull()
  })
})
