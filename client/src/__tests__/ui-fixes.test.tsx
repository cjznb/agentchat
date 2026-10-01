// @vitest-environment jsdom
/**
 * UI 修复轮回归锁（修2A / 修3；修1 由 `npm run visual` 层1 按轴扫描覆盖）：
 * - 修2A：`partitionPickerRows` 纯分拣（在线子树留主列表、全离线根子树进折叠栏）
 *   + 折叠栏交互（默认不可见、toggle 展开/收起、计数、主列表空自动展开、空栏不渲染）
 * - 修3：编辑态 ✎ 占位 `contact-rename-slot`（testid 卸载但槽位保留、× 永不跳位），
 *   以及 `contact-rename-slot` / `.contact-head` 4 列 / `.group-add-select` 冻结 CSS 存在性
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与既有 tsx 用例同法）；
 * `vi.mock("../store")` 免 WS/fetch；每例清空 localStorage 防持久化串扰。
 */
import { readFileSync } from "node:fs"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { AgentStatus, RosterNode } from "../../../shared/contracts"
import { ContactCard } from "../components/ContactCard"
import { MemberPicker } from "../components/MemberPicker"
import { foldTree, partitionPickerRows } from "../treeFold"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const storeState = vi.hoisted(() => ({ roster: [] as RosterNode[] }))
vi.mock("../store", () => ({
  useStore: () => ({ state: storeState }),
}))

function makeNode(
  id: string,
  status: AgentStatus,
  children: readonly RosterNode[] = [],
  kind: RosterNode["kind"] = "runtime",
): RosterNode {
  return {
    id,
    name: id,
    kind,
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status,
    status_text: null,
    purpose: null,
    role_tag: null,
    remark: null,
    skills: [],
    unread: 0,
    children,
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null

function render(ui: Parameters<Root["render"]>[0]): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(ui)
  })
  if (host === null) throw new Error("render 未挂载")
  return host
}

function byTestId(scope: ParentNode, testId: string): Element {
  const element = scope.querySelector(`[data-testid="${testId}"]`)
  if (element === null) throw new Error(`缺少 testid: ${testId}`)
  return element
}

function buttonByTestId(scope: ParentNode, testId: string): HTMLButtonElement {
  const element = byTestId(scope, testId)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`非 button: ${testId}`)
  return element
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  host = null
  root = null
})

describe("partitionPickerRows 纯分拣（修2A）", () => {
  const rows = foldTree([
    makeNode("live", "online", [makeNode("dead-child", "offline")]),
    makeNode("dead", "offline"),
    makeNode("logi", "online", [], "logical"),
    makeNode("ret", "retired"),
  ])

  it("含在线成员的子树留主列表；全离线/退役/逻辑根子树进折叠栏", () => {
    const { main, legacy } = partitionPickerRows(rows)
    expect(main.map((row) => row.node.id)).toEqual(["live"])
    expect(legacy.map((row) => row.node.id)).toEqual(["logi", "dead", "ret"])
  })

  it("活子树内的离线叶子留在原父下不动", () => {
    const { main } = partitionPickerRows(rows)
    expect(main[0]?.children.map((child) => child.node.id)).toEqual(["dead-child"])
  })
})

describe("MemberPicker 离线/历史会话折叠栏（修2A）", () => {
  it("在线成员在主列表；全 offline 子树进折叠栏且默认不可见", () => {
    storeState.roster = [
      makeNode("live", "online"),
      makeNode("dead", "offline"),
      makeNode("ret", "retired"),
    ]
    const container = render(<MemberPicker selected={[]} onToggle={() => {}} />)
    const main = byTestId(container, "member-picker")
    expect(main.querySelector('[data-node-id="live"]')).not.toBeNull()
    expect(main.querySelector('[data-node-id="dead"]')).toBeNull()
    const legacy = byTestId(container, "picker-legacy")
    const toggle = buttonByTestId(legacy, "picker-legacy-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(legacy.textContent).toContain("离线/历史会话 2")
    expect(legacy.querySelector('[data-testid="member-row"]')).toBeNull()
  })

  it("toggle 展开/收起 + 计数；retired 仍渲染（灰显+禁用在 PickerRow 内不变）", () => {
    storeState.roster = [
      makeNode("live", "online"),
      makeNode("dead", "offline"),
      makeNode("ret", "retired"),
    ]
    const container = render(<MemberPicker selected={[]} onToggle={() => {}} />)
    const legacy = byTestId(container, "picker-legacy")
    const toggle = buttonByTestId(legacy, "picker-legacy-toggle")
    act(() => {
      toggle.click()
    })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(legacy.querySelector('[data-node-id="dead"]')).not.toBeNull()
    const retiredRow = legacy.querySelector('[data-node-id="ret"]')
    expect(retiredRow).not.toBeNull()
    expect(retiredRow?.getAttribute("data-retired")).toBe("true")
    act(() => {
      toggle.click()
    })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(legacy.querySelector('[data-testid="member-row"]')).toBeNull()
  })

  it("主列表为空且折叠栏有行 → 自动展开", () => {
    storeState.roster = [makeNode("dead", "offline"), makeNode("ret", "retired")]
    const container = render(<MemberPicker selected={[]} onToggle={() => {}} />)
    const legacy = byTestId(container, "picker-legacy")
    const toggle = buttonByTestId(legacy, "picker-legacy-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(legacy.querySelector('[data-node-id="dead"]')).not.toBeNull()
  })

  it("折叠栏为空（全在线）→ 不渲染该栏", () => {
    storeState.roster = [makeNode("live", "online")]
    const container = render(<MemberPicker selected={[]} onToggle={() => {}} />)
    expect(container.querySelector('[data-testid="picker-legacy"]')).toBeNull()
    expect(byTestId(container, "member-picker").querySelector('[data-node-id="live"]')).not.toBeNull()
  })
})

describe("ContactCard 编辑态 ✎ 占位（修3）", () => {
  it("非编辑态有 contact-rename；编辑态 testid 卸载但占位保留、contact-close 始终在", () => {
    const container = render(
      <ContactCard
        node={makeNode("n1", "online")}
        onClose={() => {}}
        onMessage={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="contact-rename"]')).not.toBeNull()
    expect(container.querySelector(".contact-rename-slot")).toBeNull()
    act(() => {
      buttonByTestId(container, "contact-rename").click()
    })
    // 既有断言语义：编辑态 contact-rename testid 不存在（占位不带 testid）。
    expect(container.querySelector('[data-testid="contact-rename"]')).toBeNull()
    const slot = container.querySelector(".contact-rename-slot")
    expect(slot).not.toBeNull()
    expect(slot?.hasAttribute("data-testid")).toBe(false)
    expect(slot?.getAttribute("aria-hidden")).toBe("true")
    expect(slot?.textContent).toContain("✎")
    expect(container.querySelector('[data-testid="contact-close"]')).not.toBeNull()
  })

  it("冻结 CSS 存在：contact-rename-slot 隐藏占位、contact-head 4 列、group-add-select min-width:0", () => {
    const css = readFileSync("client/src/styles.css", "utf8")
    expect(css).toMatch(/\.contact-rename-slot\s*\{[^}]*visibility:\s*hidden/)
    expect(css).toMatch(
      /\.contact-head\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/,
    )
    expect(css).toMatch(/\.group-add-select\s*\{[^}]*min-width:\s*0/)
  })
})
