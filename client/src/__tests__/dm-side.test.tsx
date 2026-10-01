// @vitest-environment jsdom
/**
 * 批次2 轮 B 红测试（先红后绿）：
 * - B3 双 agent DM 发起方居左：渲染 data-side / 头像随侧 + dualDmSide、initiatorIdOf 纯派生；
 *   回归：含人类 DM 与群聊 side=undefined（既有 own 规则零变化）。
 * - F1 纯双 agent 私聊标题「{发起方}和{对方}的私聊」（发起方在前）；人类 DM/群标题零变化。
 * - B1 mention 样式段（Task 8 引入处）无裸 hex/rgb 字面量、引用既有 token。
 * - B2 .bubble-md-toggle / .bubble-copy 照 .bubble-revoke 结构 token 化（hover/active/disabled）。
 *
 * 无 React 测试库：`react-dom/client` + `react#act`（与 dm-identity.test.tsx 同法）。
 * CSS 经 `styles.css?raw` 导入（与 styles-controls.test.ts 同法，不依赖 cwd）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ChatMessage, ConversationSummary } from "../../../shared/contracts"
import * as chatModule from "../chat"
import { conversationTitle, type RosterView, type SenderView } from "../chat"
import { MessageBubble, type MessageBubbleProps } from "../components/MessageBubble"
import css from "../styles.css?raw"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// ── 渲染夹具（同 dm-identity.test.tsx） ─────────────────────────────
let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

function message(fromAgentId: string, id = "m1"): ChatMessage {
  return {
    seq: 1,
    id,
    conversationId: "c1",
    fromAgentId,
    body: "你好",
    kind: "text",
    createdAt: 1,
  }
}

function sender(id: string, name: string): SenderView {
  return { id, name, vendor: "openai", rootName: null }
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

function rowOf(container: HTMLElement): Element {
  const el = container.querySelector('[data-testid="message-row"]')
  expect(el).not.toBeNull()
  return el as Element
}

// ── 新增纯派生的命名空间访问（未实现 → typeof 断言先红） ─────────────
interface ChatNs {
  dualDmSide?: (
    conversation: ConversationSummary | undefined,
    view: RosterView,
    initiatorId: string | null,
    message: { readonly fromAgentId: string },
    own: boolean,
  ) => "left" | "right" | undefined
  initiatorIdOf?: (
    messages: readonly { readonly kind: string; readonly fromAgentId: string }[],
  ) => string | null
}
const ns = chatModule as unknown as ChatNs

// ── 会话 / roster 夹具 ─────────────────────────────────────────────
function dm(key: string): ConversationSummary {
  return { id: "c1", name: null, kind: "dm", key, createdAt: 1, lastMessage: null, unread: 0 }
}
function group(): ConversationSummary {
  return { id: "c2", name: "项目组", kind: "group", key: "g1", createdAt: 1, lastMessage: null, unread: 0 }
}
function roster(): RosterView {
  return {
    humanId: "human1",
    byId: new Map<string, SenderView>([
      ["agent-a", { id: "agent-a", name: "阿尔法", vendor: "openai", rootName: null }],
      ["agent-b", { id: "agent-b", name: "贝塔", vendor: "anthropic", rootName: null }],
      ["human1", { id: "human1", name: "你", vendor: "human", rootName: null }],
    ]),
  }
}
/** 纯双 agent DM（key 字典序 agent-a < agent-b；会话无创建者字段 → 发起方由首条消息派生）。 */
const AGENT_DM = dm("dm:agent-a_agent-b")
/** 含人类 DM（人类参与 → 左右规则零改动）。 */
const HUMAN_DM = dm("dm:agent-a_human1")

// ── B3：发起方判定（首条非系统消息 sender） ────────────────────────
describe("B3 发起方派生 initiatorIdOf", () => {
  it("存在且取首条非系统消息的 sender", () => {
    expect(typeof ns.initiatorIdOf).toBe("function")
    const msgs = [
      { kind: "system", fromAgentId: "sys" },
      { kind: "text", fromAgentId: "agent-a" },
      { kind: "text", fromAgentId: "agent-b" },
    ]
    expect(ns.initiatorIdOf?.(msgs)).toBe("agent-a")
  })
  it("全系统消息 / 空 → null", () => {
    expect(ns.initiatorIdOf?.([{ kind: "system", fromAgentId: "sys" }])).toBeNull()
    expect(ns.initiatorIdOf?.([])).toBeNull()
  })
})

describe("B3 dualDmSide 分侧", () => {
  it("存在", () => {
    expect(typeof ns.dualDmSide).toBe("function")
  })
  it("纯双 agent DM：发起方 left、对向 right", () => {
    const view = roster()
    expect(ns.dualDmSide?.(AGENT_DM, view, "agent-a", { fromAgentId: "agent-a" }, false)).toBe("left")
    expect(ns.dualDmSide?.(AGENT_DM, view, "agent-a", { fromAgentId: "agent-b" }, false)).toBe("right")
    expect(ns.dualDmSide?.(AGENT_DM, view, "agent-b", { fromAgentId: "agent-b" }, false)).toBe("left")
  })
  it("own / 人类注入 → 非发起方侧（右）", () => {
    expect(ns.dualDmSide?.(AGENT_DM, roster(), "agent-a", { fromAgentId: "human1" }, true)).toBe("right")
  })
  it("第三方/系统 sender（不在参与方）→ undefined", () => {
    expect(ns.dualDmSide?.(AGENT_DM, roster(), "agent-a", { fromAgentId: "sys" }, false)).toBeUndefined()
  })
  it("回归：含人类 DM → undefined（own 规则零变化）", () => {
    expect(ns.dualDmSide?.(HUMAN_DM, roster(), "agent-a", { fromAgentId: "agent-a" }, false)).toBeUndefined()
    expect(ns.dualDmSide?.(HUMAN_DM, roster(), "agent-a", { fromAgentId: "human1" }, true)).toBeUndefined()
  })
  it("回归：群聊 → undefined", () => {
    expect(ns.dualDmSide?.(group(), roster(), "agent-a", { fromAgentId: "agent-a" }, false)).toBeUndefined()
  })
})

// ── B3：渲染 data-side + 头像随侧 ──────────────────────────────────
describe("B3 渲染 data-side", () => {
  it("side=left → data-side=left 且头像渲染（头像随侧走 flex 方向）", () => {
    const hostEl = render({
      message: message("agent-a"),
      own: false,
      sender: sender("agent-a", "阿尔法"),
      showSender: true,
      highlighted: false,
      card: null,
      side: "left",
    } as MessageBubbleProps)
    const row = rowOf(hostEl)
    expect(row.getAttribute("data-side")).toBe("left")
    expect(row.querySelector(".avatar")).not.toBeNull()
  })
  it("side=right → data-side=right 且头像渲染", () => {
    const hostEl = render({
      message: message("agent-b", "m2"),
      own: false,
      sender: sender("agent-b", "贝塔"),
      showSender: true,
      highlighted: false,
      card: null,
      side: "right",
    } as MessageBubbleProps)
    const row = rowOf(hostEl)
    expect(row.getAttribute("data-side")).toBe("right")
    expect(row.querySelector(".avatar")).not.toBeNull()
  })
  it("回归：不传 side → 无 data-side，data-own 现状保持", () => {
    const hostEl = render({
      message: message("human1", "m3"),
      own: true,
      sender: sender("human1", "你"),
      showSender: true,
      highlighted: false,
      card: null,
    })
    const row = rowOf(hostEl)
    expect(row.hasAttribute("data-side")).toBe(false)
    expect(row.getAttribute("data-own")).toBe("true")
  })
})

// ── F1：私聊标题 ───────────────────────────────────────────────────
describe("F1 纯双 agent 私聊标题", () => {
  it("发起方在前：「阿尔法和贝塔的私聊」", () => {
    expect(conversationTitle(AGENT_DM, roster(), "agent-a")).toBe("阿尔法和贝塔的私聊")
  })
  it("对向发起 → 「贝塔和阿尔法的私聊」（发起方仍在前）", () => {
    expect(conversationTitle(AGENT_DM, roster(), "agent-b")).toBe("贝塔和阿尔法的私聊")
  })
  it("无首条消息（initiatorId=null）→ 参与方 key 序仍拼「X和Y的私聊」", () => {
    expect(conversationTitle(AGENT_DM, roster(), null)).toBe("阿尔法和贝塔的私聊")
  })
  it("回归：含人类 DM 标题零变化（取非 human 参与方名）", () => {
    expect(conversationTitle(HUMAN_DM, roster(), "agent-a")).toBe("阿尔法")
  })
  it("回归：群聊标题零变化", () => {
    expect(conversationTitle(group(), roster(), null)).toBe("项目组")
  })
})

// ── B1 / B2：styles.css token 化 ───────────────────────────────────
describe("B1 mention 样式 token 化（Task 8 段）", () => {
  const section = (): string => {
    const stripped = css.replace(/\/\*[^*]*\*\//g, "")
    const at = stripped.lastIndexOf(".mention-hit")
    expect(at).toBeGreaterThan(-1)
    return stripped.slice(at)
  }
  it("mention 段无裸 hex / rgb 颜色字面量", () => {
    expect(section()).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
    expect(section()).not.toMatch(/rgba?\(/)
  })
  it("mention 段引用既有 token（高亮色与底色同族）", () => {
    const body = section()
    expect(body).toMatch(/\.mention-hit\s*\{[^}]*var\(--color-jade-soft\)/)
    expect(body).toMatch(/\.mention-hit\s*\{[^}]*var\(--color-jade\)/)
    expect(body).toMatch(/\.mention-chip\s*\{[^}]*var\(--color-jade-soft\)/)
    expect(body).toMatch(/\.mention-badge\s*\{[^}]*var\(--color-jade\)/)
  })
})

describe("B2 气泡按钮 token 化（照 .bubble-revoke 结构）", () => {
  /** 仅抽取新按钮所属规则块（不波及其后既有规则）。 */
  const ourBlocks = (): string[] => {
    const body = css.replace(/\/\*[^*]*\*\//g, "")
    return (body.match(/[^{}]+\{[^}]*\}/g) ?? []).filter(
      (block) => block.includes(".bubble-md-toggle") || block.includes(".bubble-copy"),
    )
  }
  it("基座：token 边框/圆角/字号（font: inherit）/指针", () => {
    for (const sel of [".bubble-md-toggle", ".bubble-copy"]) {
      expect(css).toMatch(new RegExp(`${sel}[^{}]*\\{[^}]*var\\(--line-thin\\)`))
      expect(css).toMatch(new RegExp(`${sel}[^{}]*\\{[^}]*var\\(--radius-small\\)`))
      expect(css).toMatch(new RegExp(`${sel}[^{}]*\\{[^}]*font: inherit`))
      expect(css).toMatch(new RegExp(`${sel}[^{}]*\\{[^}]*cursor: pointer`))
    }
  })
  it("hover / active / disabled 态齐备", () => {
    for (const sel of [".bubble-md-toggle", ".bubble-copy"]) {
      for (const pseudo of [":hover", ":active", ":disabled"]) {
        expect(css).toMatch(new RegExp(`${sel}${pseudo}[^{}]*\\{`))
      }
    }
  })
  it("无裸 hex（新按钮规则块只用 token）", () => {
    const blocks = ourBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    for (const block of blocks) {
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
    }
  })
})
