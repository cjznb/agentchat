// @vitest-environment jsdom
/**
 * Task 8 —— 提及 UI 回归锁：
 * - `splitMentions`：分段顺序（拼接还原原文）/ 空格名最长前缀 / 未命中归纯文本段 / 邮箱不切段
 * - `MessageBubble`：正文含 `@名字` → `mark.mention-hit`；`meta.mentions` 有而正文无 →
 *   `.mention-chip` 含展示名；正文已含 → 不重复出 chip；无提及 → 两者皆无
 * - 被 @ 布尔：`conversationMentioned` 命中人类 id → true（未读计数口径由既有
 *   `unread.test.ts` 断言锁定，本任务不改即绿）
 *
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与 `revoke-bubble.test.tsx` 同法）。
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { ChatMessage, ConversationSummary, RosterNode } from "../../../shared/contracts"
import { splitMentions, type MentionTarget } from "../../../shared/mentions"
import { MessageBubble, type MessageBubbleProps } from "../components/MessageBubble"
import { conversationMentioned } from "../unread"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

const PARTICIPANTS: readonly MentionTarget[] = [
  { id: "agent-zhang", name: "张三" },
  { id: "agent-li", name: "李四" },
  { id: "agent-title", name: "标题 · abcd" },
]

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    seq: 1,
    id: "m1",
    conversationId: "c1",
    fromAgentId: "agent-zhang",
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
    participants: PARTICIPANTS,
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

describe("splitMentions 分段", () => {
  it("按顺序交替纯文本与命中段，拼接还原原文", () => {
    const body = "早 @张三 与 @李四 请看"
    const parts = splitMentions(body, PARTICIPANTS)
    expect(parts.map((part) => part.text).join("")).toBe(body)
    expect(parts.map((part) => part.mention?.id ?? null)).toEqual([
      null,
      "agent-zhang",
      null,
      "agent-li",
      null,
    ])
  })

  it("名字含空格按最长前缀命中", () => {
    const parts = splitMentions("@标题 · abcd 你好", PARTICIPANTS)
    expect(parts[0]).toEqual({
      text: "@标题 · abcd",
      mention: { id: "agent-title", name: "标题 · abcd" },
    })
    expect(parts.map((part) => part.text).join("")).toBe("@标题 · abcd 你好")
  })

  it("未命中 token 归入纯文本段", () => {
    const parts = splitMentions("@nobody 你好", PARTICIPANTS)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.mention).toBeUndefined()
    expect(parts[0]?.text).toBe("@nobody 你好")
  })

  it("邮箱（@ 左邻 ASCII 词字符）不切段", () => {
    const parts = splitMentions("mail a@b.com 即可", PARTICIPANTS)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.mention).toBeUndefined()
  })

  it("无提及纯文本整体一段", () => {
    const parts = splitMentions("普通消息", PARTICIPANTS)
    expect(parts).toEqual([{ text: "普通消息" }])
  })
})

describe("MessageBubble @ 高亮", () => {
  it("正文含 @名字 → 渲染 mention-hit", () => {
    const container = render(props({ message: message({ body: "@张三 请看结果" }) }))
    const marks = container.querySelectorAll("mark.mention-hit")
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe("@张三")
  })

  it("无提及 → 无高亮无 chip", () => {
    const container = render(props({ message: message({ body: "普通消息" }) }))
    expect(container.querySelector("mark.mention-hit")).toBeNull()
    expect(container.querySelector(".mention-chip")).toBeNull()
  })
})

describe("MessageBubble 提及 chip", () => {
  it("meta.mentions 有而正文未写 → 出 chip 且含展示名", () => {
    const container = render(
      props({ message: message({ body: "请看结果", meta: { mentions: ["agent-zhang"] } }) }),
    )
    const chip = container.querySelector(".mention-chip")
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain("张三")
    expect(container.querySelector("mark.mention-hit")).toBeNull()
  })

  it("正文已含 @名字 → 不重复出 chip，仅高亮", () => {
    const container = render(
      props({ message: message({ body: "@张三 请看", meta: { mentions: ["agent-zhang"] } }) }),
    )
    expect(container.querySelector(".mention-chip")).toBeNull()
    expect(container.querySelector("mark.mention-hit")).not.toBeNull()
  })

  it("无 meta → 无 chip", () => {
    const container = render(props({ message: message({ body: "请看结果" }) }))
    expect(container.querySelector(".mention-chip")).toBeNull()
  })

  it("meta 指向非参与者 id → 无 chip（无展示名可映射）", () => {
    const container = render(
      props({ message: message({ body: "请看", meta: { mentions: ["ghost-id"] } }) }),
    )
    expect(container.querySelector(".mention-chip")).toBeNull()
  })
})

describe("会话被 @ 标记（unread.ts）", () => {
  const humanRoster = [
    { id: "human-1", name: "我", parent_id: null, vendor: "human", status: "online" },
  ] as unknown as RosterNode[]

  function conversation(metaMentions: string[] | undefined): ConversationSummary {
    const lastMessage = {
      id: "m1",
      seq: 1,
      from: "agent-zhang",
      body: "hi",
      createdAt: 1,
      ...(metaMentions === undefined ? {} : { meta: { mentions: metaMentions } }),
    }
    return { lastMessage } as unknown as ConversationSummary
  }

  it("最新消息 meta.mentions 含人类 id → mentioned true", () => {
    expect(conversationMentioned(conversation(["agent-zhang", "human-1"]), humanRoster)).toBe(true)
  })

  it("mentions 不含人类 id → false", () => {
    expect(conversationMentioned(conversation(["agent-zhang"]), humanRoster)).toBe(false)
  })

  it("无 meta / 无 lastMessage → false", () => {
    expect(conversationMentioned(conversation(undefined), humanRoster)).toBe(false)
    expect(
      conversationMentioned({ lastMessage: null } as unknown as ConversationSummary, humanRoster),
    ).toBe(false)
  })

  it("roster 无人类节点 → false", () => {
    const agentsOnly = [
      { id: "agent-zhang", name: "张三", parent_id: null, vendor: "anthropic", status: "online" },
    ] as unknown as RosterNode[]
    expect(conversationMentioned(conversation(["human-1"]), agentsOnly)).toBe(false)
  })
})
