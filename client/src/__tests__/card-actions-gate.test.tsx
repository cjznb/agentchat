// @vitest-environment jsdom
/**
 * P4/8（B 方案，仅 UI 收紧）—— `CardActions` 答复控件渲染门槛 DOM 用例：
 * - pending 批示 `target` 非人类节点 → 只读态（无任何可点答复控件，选项纯展示）
 * - `target=human` → 控件在（现状不变锁）
 * - 已答复 / 已过期卡既有展示（结果 / 过期文案）不变
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（同 `revoke-bubble.test.tsx`）。
 */
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { NotificationEntry } from "../../../shared/contracts"
import { cardFromEntry, type CardData } from "../cards"
import { CardActions } from "../components/Cards"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 消费面仅需 state.roster（humanId 派生）+ 两个提交动作；不引真实 StoreProvider（免 WS/REST 副作用）。
vi.mock("../store", () => ({
  useStore: () => ({
    state: {
      roster: [
        {
          id: "human",
          name: "我",
          kind: "runtime",
          parent_id: null,
          vendor: "human",
          model: "",
          status: "online",
          status_text: null,
          purpose: null,
          role_tag: null,
          remark: null,
          skills: [],
          unread: 0,
          children: [],
        },
      ],
    },
    decideApproval: () => Promise.reject(new Error("not exercised")),
    respondAsk: () => Promise.reject(new Error("not exercised")),
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

function entry(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: "n1",
    kind: "ask",
    requesterAgentId: "a1",
    target: "human",
    action: "ask",
    payload: { question: "继续吗", options: ["是", "否"], allowCustom: true },
    status: "pending",
    createdAt: 1,
    cardMessageId: "m1",
    conversationId: "c1",
    ...overrides,
  }
}

function renderActions(card: CardData, item: NotificationEntry): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(<CardActions card={card} entry={item} />)
  })
  return host
}

/** 可点答复控件：未禁用的选项按钮 / 自由输入 / 提交钮（只读态三者皆无）。 */
function hasRespondControls(container: HTMLElement): boolean {
  return (
    container.querySelector('button[data-testid="card-choice"]:not([disabled])') !== null ||
    container.querySelector('[data-testid="card-custom-input"]') !== null ||
    container.querySelector('[data-testid="card-custom-send"]') !== null
  )
}

describe("CardActions 答复控件渲染门槛（P4/8）", () => {
  it("pending 批示 target=其它 agent → 无任何答复控件（只读展示选项）", () => {
    const item = entry({ target: "agent-zhang" })
    const container = renderActions(cardFromEntry(item), item)
    expect(hasRespondControls(container)).toBe(false)
    // 只读态仍展示选项文本（纯展示；问题文本由卡头 `ChatCard` 渲染，不在本组件内）
    expect(container.querySelector('[data-testid="card-choices-readonly"]')).not.toBeNull()
    expect(container.textContent).toContain("是")
    expect(container.textContent).toContain("否")
  })

  it("pending 批示 target=human → 答复控件存在（现状不变锁）", () => {
    const item = entry({ target: "human" })
    const container = renderActions(cardFromEntry(item), item)
    expect(container.querySelectorAll('[data-testid="card-choice"]')).toHaveLength(2)
    expect(container.querySelector('[data-testid="card-custom-input"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="card-custom-send"]')).not.toBeNull()
  })

  it("已答复卡（target=其它 agent）展示不变：结果文案在、控件不在", () => {
    const item = entry({
      target: "agent-zhang",
      status: "answered",
      result: { choice: "是" },
    })
    const container = renderActions(cardFromEntry(item), item)
    expect(container.querySelector('[data-testid="card-verdict"]')?.textContent).toContain(
      "已选择「是」",
    )
    expect(hasRespondControls(container)).toBe(false)
  })

  it("已过期卡（target=human）展示不变：过期文案在", () => {
    const item = entry({ target: "human", status: "expired" })
    const container = renderActions(cardFromEntry(item), item)
    expect(container.querySelector('[data-testid="card-verdict"]')?.textContent).toContain("过期")
  })
})
