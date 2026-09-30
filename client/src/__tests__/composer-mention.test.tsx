// @vitest-environment jsdom
/**
 * feat/group-mentions —— `Composer` 输入栏 @ 候选提示组件级回归锁（spec §4.1；Task 7）：
 * - 打 `@` 出候选：roster 拍平为 {id,name}，**排除 human 自身与分组容器**；无 `@` 不出
 * - 片段 = 最后一个 `@` 到光标（**可含空格**，如「STM32H750 智能家居终端 OTA 阶段C接手」）；
 *   大小写不敏感子串匹配；光标移出段（onKeyUp 同步 caret）自然收起
 * - `Enter`/`Tab` 插入 `@<完整名字> `（**尾随空格**、光标复位、下拉收起）；点击候选同样插入
 * - `Esc` / 失焦关闭；`↑↓` **循环**高亮移动 + `scrollIntoView({block:"nearest"})` 跟随
 * - 样式：`styles.css?raw` 锁 `.composer-mention` 含 `max-height: 224px` 与 `overflow-y: auto`；
 *   DOM 锁类名 `composer-mention` / `composer-mention-item` 与 `[data-active="true"]`
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与既有 tsx 用例同法）；
 * `vi.mock("../store")` 免 WS/fetch；jsdom 未实现 `scrollIntoView` → 模块级 stub 为 spy。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import css from "../styles.css?raw"
import { Composer } from "../components/Composer"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// jsdom 无 scrollIntoView：stub 为 spy，锁「↑↓ 跟随」调用参数。
const scrollMock = vi.fn()
Object.defineProperty(Element.prototype, "scrollIntoView", {
  value: scrollMock,
  configurable: true,
  writable: true,
})

/** roster fixture：human 自身（应被排除）、普通根+子节点、容器（应被排除、子会话节点保留）。 */
const rosterFixture = vi.hoisted(() => {
  const node = (
    id: string,
    name: string,
    opts: { vendor?: string; role?: string; children?: unknown[] } = {},
  ): Record<string, unknown> => ({
    id,
    name,
    kind: "runtime",
    parent_id: null,
    vendor: opts.vendor ?? "opencode",
    model: "m",
    status: "online",
    status_text: null,
    purpose: null,
    role_tag: opts.role ?? null,
    remark: null,
    skills: [],
    unread: 0,
    children: opts.children ?? [],
  })
  return {
    roster: [
      node("human-1", "本地用户", { vendor: "human" }),
      node("root-1", "张三", {
        children: [
          node("child-1", "STM32H750 智能家居终端 OTA 阶段C接手"),
          node("child-2", "AliceOps"),
        ],
      }),
      node("box-1", "分组容器", { role: "container", children: [node("sess-1", "Session1")] }),
    ],
  }
})

vi.mock("../store", () => ({
  useStore: () => ({
    sendMessage: () => Promise.resolve({}),
    state: { roster: rosterFixture.roster },
  }),
}))

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

beforeEach(() => {
  scrollMock.mockClear()
})

function render(): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(<Composer conversationId="c1" />)
  })
  return host
}

function input(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector('[data-testid="composer-input"]')
  if (element === null) throw new Error("composer-input not found")
  return element as HTMLTextAreaElement
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function candidates(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="composer-mention-item"]')).map(
    (item) => item.textContent ?? "",
  )
}

function activeText(container: HTMLElement): string {
  const active = container.querySelector('[data-testid="composer-mention-item"][data-active="true"]')
  if (active === null) throw new Error("no active candidate")
  return active.textContent ?? ""
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(textarea, value)
  textarea.setSelectionRange(value.length, value.length)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

function press(textarea: HTMLTextAreaElement, key: string): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

function release(textarea: HTMLTextAreaElement, key: string): void {
  textarea.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }))
}

describe("Composer @ 候选触发与匹配", () => {
  it("打 @ 出候选：roster 拍平、排除 human 自身与容器，类名锁定、首项默认高亮", () => {
    const container = render()
    expect(find(container, "composer-mention")).toBeNull()

    act(() => typeInto(input(container), "@"))
    const list = find(container, "composer-mention")
    expect(list?.className).toBe("composer-mention")
    expect(candidates(container)).toEqual([
      "张三",
      "STM32H750 智能家居终端 OTA 阶段C接手",
      "AliceOps",
      "Session1",
    ])
    expect(activeText(container)).toBe("张三")
    const item = container.querySelector('[data-testid="composer-mention-item"]')
    expect(item?.className).toBe("composer-mention-item")
  })

  it("无 @ 不出候选", () => {
    const container = render()
    act(() => typeInto(input(container), "hello there"))
    expect(find(container, "composer-mention")).toBeNull()
  })

  it("片段可含空格：最后一个 @ 到光标的整段匹配长名字", () => {
    const container = render()
    act(() => typeInto(input(container), "@STM32H750 智能"))
    expect(candidates(container)).toEqual(["STM32H750 智能家居终端 OTA 阶段C接手"])
  })

  it("匹配大小写不敏感", () => {
    const container = render()
    act(() => typeInto(input(container), "@ALICE"))
    expect(candidates(container)).toEqual(["AliceOps"])
  })

  it("光标移出 @ 段（onKeyUp 同步 caret）→ 收起", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@Alice"))
    expect(find(container, "composer-mention")).not.toBeNull()

    act(() => {
      textarea.setSelectionRange(0, 0)
      release(textarea, "ArrowLeft")
    })
    expect(find(container, "composer-mention")).toBeNull()
  })
})

describe("Composer @ 候选交互", () => {
  it("Enter 选中：输入框文本 = @<完整名字> （尾随空格）+ 光标复位 + 下拉收起", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@STM32H750"))
    expect(candidates(container)).toHaveLength(1)

    act(() => press(textarea, "Enter"))
    expect(textarea.value).toBe("@STM32H750 智能家居终端 OTA 阶段C接手 ")
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(find(container, "composer-mention")).toBeNull()
  })

  it("Tab 选中：同样插入 @<名字> ", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@alice"))

    act(() => press(textarea, "Tab"))
    expect(textarea.value).toBe("@AliceOps ")
    expect(find(container, "composer-mention")).toBeNull()
  })

  it("点击候选同样插入", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@张"))
    const item = container.querySelector<HTMLElement>('[data-testid="composer-mention-item"]')
    if (item === null) throw new Error("candidate not found")

    act(() => item.click())
    expect(textarea.value).toBe("@张三 ")
    expect(find(container, "composer-mention")).toBeNull()
  })

  it("Esc 关闭（草稿不变）", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@Alice"))
    expect(find(container, "composer-mention")).not.toBeNull()

    act(() => press(textarea, "Escape"))
    expect(find(container, "composer-mention")).toBeNull()
    expect(textarea.value).toBe("@Alice")
  })

  it("失焦（focusout）关闭", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@"))
    expect(find(container, "composer-mention")).not.toBeNull()

    act(() => {
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    })
    expect(find(container, "composer-mention")).toBeNull()
  })

  it("↑↓ 循环移动高亮（到头回绕，反向同理）", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@"))
    expect(activeText(container)).toBe("张三")

    act(() => press(textarea, "ArrowDown"))
    expect(activeText(container)).toBe("STM32H750 智能家居终端 OTA 阶段C接手")
    act(() => press(textarea, "ArrowDown"))
    expect(activeText(container)).toBe("AliceOps")
    act(() => press(textarea, "ArrowDown"))
    expect(activeText(container)).toBe("Session1")
    act(() => press(textarea, "ArrowDown"))
    expect(activeText(container)).toBe("张三") // 循环回绕
    act(() => press(textarea, "ArrowUp"))
    expect(activeText(container)).toBe("Session1") // 反向循环
  })

  it("↑↓ 切高亮时对活动项 scrollIntoView({block:'nearest'}) 跟随", () => {
    const container = render()
    const textarea = input(container)
    act(() => typeInto(textarea, "@"))
    scrollMock.mockClear()

    act(() => press(textarea, "ArrowDown"))
    expect(scrollMock).toHaveBeenCalledWith({ block: "nearest" })
  })
})

describe("Composer @ 候选样式", () => {
  it("styles.css 锁 .composer-mention 规则：max-height 224px + overflow-y auto；.composer 定位基座", () => {
    expect(css).toMatch(/\.composer\s*\{[^}]*position:\s*relative/)
    expect(css).toMatch(/\.composer-mention\s*\{[^}]*max-height:\s*224px/)
    expect(css).toMatch(/\.composer-mention\s*\{[^}]*overflow-y:\s*auto/)
    expect(css).toMatch(/\.composer-mention-item\s*\{/)
    expect(css).toMatch(/\.composer-mention-item\[data-active="true"\]\s*\{/)
  })

  it("DOM 出列表即带 max-height 所属类（类名与断言锁定）", () => {
    const container = render()
    act(() => typeInto(input(container), "@"))
    expect(find(container, "composer-mention")?.className).toBe("composer-mention")
  })
})
