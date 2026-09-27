// @vitest-environment jsdom
/**
 * Plan 3 T3 —— 客户端数据层单测：
 * - reducer 四类事件（message / receipt / agent / approval 分流）+ 游标去重 + resync 清缓存 + 解析失败忽略
 * - WS 客户端（注入假 socket）：since 续传 / resync / 退避 / 非法帧忽略
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  ApprovalSnapshot,
  ConversationSummary,
  RosterNode,
  WsServerFrame,
} from "../../../shared/contracts"
import { initialState, planReload, reducer, reduceFrame, type AppState } from "../reducers"
import { backoffDelay, WsClient, type WsSocketLike } from "../ws"

const humanConv: ConversationSummary = {
  id: "c1",
  name: null,
  kind: "dm",
  key: "dm:a_b",
  lastMessage: { id: "old1", seq: 1, from: "agent-1", body: "old", createdAt: 1 },
  unread: 1,
}
const otherConv: ConversationSummary = {
  id: "c2",
  name: "群",
  kind: "group",
  key: "group:c2",
  lastMessage: { id: "old2", seq: 2, from: "agent-2", body: "newer", createdAt: 2 },
  unread: 0,
}

function withConversations(state: AppState, ...conversations: readonly ConversationSummary[]): AppState {
  return reducer(state, {
    type: "conversations",
    payload: { conversations: [...conversations], unreadByRoot: {} },
  })
}

function messageFrame(seq: number, conversationId: string, messageId: string, body = "hi"): WsServerFrame {
  return {
    type: "message",
    seq,
    payload: { conversationId, messageId, seq, from: "agent-1", body, kind: "text", createdAt: seq },
  }
}

function receiptFrame(seq: number, conversationId: string, messageId: string): WsServerFrame {
  return {
    type: "receipt",
    seq,
    payload: { conversationId, messageId, seq, receipts: [{ agentId: "agent-1", stage: "read" }] },
  }
}

function agentFrame(seq: number, tree: readonly RosterNode[]): WsServerFrame {
  return { type: "agent", seq, payload: { tree } }
}

function snapshot(id: string, status: ApprovalSnapshot["status"] = "pending"): ApprovalSnapshot {
  return { id, requesterAgentId: "root", action: "shout", payload: {}, status, createdAt: 1, decidedAt: null }
}

function approvalFrame(seq: number, kind: "action" | "ask", approval: ApprovalSnapshot): WsServerFrame {
  return { type: "approval", seq, payload: { kind, approval } }
}

function rosterNode(id: string): RosterNode {
  return {
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
    unread: 0,
    children: [],
  }
}

/** 打开 c1 并预置一条消息（消息入桶 + 列表预览可断言）。 */
function openedWithMessage(): AppState {
  let state = withConversations(initialState, humanConv)
  state = reducer(state, { type: "open", conversationId: "c1" })
  return reduceFrame(state, messageFrame(1, "c1", "m1", "hello"))
}

describe("reducer: 四类事件", () => {
  it("message 入会话、更新预览并按最后消息时间重排列表", () => {
    let state = withConversations(initialState, otherConv, humanConv)
    state = reducer(state, { type: "open", conversationId: "c1" })
    state = reduceFrame(state, messageFrame(5, "c1", "m9", "hello"))

    expect(state.messages.get("c1")?.map((message) => message.id)).toEqual(["m9"])
    expect(state.conversations[0]?.id).toBe("c1")
    expect(state.conversations[0]?.lastMessage?.body).toBe("hello")
    expect(state.appliedSeq).toBe(5)
  })

  it("receipt 在会话已加载/打开时计划该会话消息重拉", () => {
    const plan = planReload(openedWithMessage(), receiptFrame(2, "c1", "m1"))
    expect(plan.messages).toEqual(["c1"])

    const idle = planReload(withConversations(initialState, humanConv), receiptFrame(2, "c1", "m1"))
    expect(idle.messages).toEqual([])
  })

  it("agent 应用 roster 树并计划 roster 重拉", () => {
    const state = reduceFrame(initialState, agentFrame(1, [rosterNode("root")]))
    expect(state.roster.map((node) => node.id)).toEqual(["root"])
    expect(planReload(state, agentFrame(2, [rosterNode("root")])).roster).toBe(true)
  })

  it("approval 按 kind 分流：action 入审批列，ask 归通知重拉，已决 action 移除", () => {
    const pending = reduceFrame(initialState, approvalFrame(1, "action", snapshot("a1")))
    expect(pending.approvals.map((entry) => entry.id)).toEqual(["a1"])
    expect(planReload(pending, approvalFrame(2, "action", snapshot("a1"))).approvals).toBe(true)

    const ask = reduceFrame(pending, approvalFrame(2, "ask", snapshot("k1")))
    expect(ask.approvals.map((entry) => entry.id)).toEqual(["a1"])
    expect(planReload(ask, approvalFrame(3, "ask", snapshot("k1", "answered"))).notifications).toBe(true)

    const decided = reduceFrame(pending, approvalFrame(2, "action", snapshot("a1", "approved")))
    expect(decided.approvals).toEqual([])
  })
})

describe("reducer: 游标去重与 resync", () => {
  it("同 seq 帧幂等忽略，同 id 消息不重复入桶", () => {
    const state = openedWithMessage()
    expect(reduceFrame(state, messageFrame(1, "c1", "m1", "hello"))).toBe(state)
    expect(reduceFrame(state, messageFrame(1, "c1", "m2", "dup-seq"))).toBe(state)

    const advanced = reduceFrame(state, messageFrame(2, "c1", "m1", "same-id-new-seq"))
    expect(advanced.messages.get("c1")).toHaveLength(1)
    expect(advanced.appliedSeq).toBe(2)
  })

  it("resync 清空缓存、对齐游标并计划整页重拉", () => {
    let state = openedWithMessage()
    state = reduceFrame(state, agentFrame(2, [rosterNode("root")]))
    const resync: WsServerFrame = { type: "resync", seq: 99, payload: {} }

    const next = reduceFrame(state, resync)
    expect(next.conversations).toEqual([])
    expect(next.roster).toEqual([])
    expect(next.messages.size).toBe(0)
    expect(next.appliedSeq).toBe(99)
    expect(next.openConversationId).toBe("c1")

    const plan = planReload(state, resync)
    expect([plan.roster, plan.conversations, plan.notifications, plan.approvals]).toEqual([
      true,
      true,
      true,
      true,
    ])
  })
})

describe("reducer: 前向兼容（解析失败忽略）", () => {
  afterEach(() => vi.restoreAllMocks())

  it("payload 解析失败时 warn 并忽略数据、仅推进游标", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const bogus: WsServerFrame = { type: "message", seq: 3, payload: { unexpected: true } }
    const next = reduceFrame(initialState, bogus)
    expect(warn).toHaveBeenCalled()
    expect(next.messages.size).toBe(0)
    expect(next.appliedSeq).toBe(3)
  })
})

describe("backoffDelay", () => {
  it("指数增长至 30s 上限，并带可注入 jitter", () => {
    const low = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, () => 0))
    expect(low).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    const high = [0, 1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, () => 1))
    expect(high).toEqual([2000, 3000, 5000, 9000, 17000, 30000])
  })
})

class FakeSocket implements WsSocketLike {
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  close(): void {
    this.closed = true
  }
}

function harness(): {
  readonly client: WsClient
  readonly urls: string[]
  readonly sockets: FakeSocket[]
  readonly frames: WsServerFrame[]
} {
  const urls: string[] = []
  const sockets: FakeSocket[] = []
  const frames: WsServerFrame[] = []
  const client = new WsClient({
    url: "/api/ws",
    socketFactory: (url) => {
      const socket = new FakeSocket()
      urls.push(url)
      sockets.push(socket)
      return socket
    },
    onFrame: (frame) => frames.push(frame),
    random: () => 0,
    warn: () => {},
  })
  return { client, urls, sockets, frames }
}

describe("WsClient", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("首连不带 since，应用事件推进游标，断线重连带 ?since 续传", () => {
    vi.useFakeTimers()
    const { client, urls, sockets, frames } = harness()
    client.start()
    expect(urls).toEqual(["/api/ws"])

    sockets[0]!.onopen?.()
    sockets[0]!.onmessage?.({ data: JSON.stringify(messageFrame(7, "c1", "m1")) })
    expect(client.since).toBe(7)
    expect(frames).toHaveLength(1)

    sockets[0]!.onclose?.()
    vi.advanceTimersByTime(1000)
    expect(urls).toEqual(["/api/ws", "/api/ws?since=7"])
    client.stop()
  })

  it("resync 首帧对齐游标并转发给订阅者", () => {
    const { client, sockets, frames } = harness()
    client.start()
    sockets[0]!.onopen?.()
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "resync", seq: 42, payload: {} }) })
    expect(client.since).toBe(42)
    expect(frames[0]).toMatchObject({ type: "resync" })
    client.stop()
  })

  it("非法 JSON 与契约外帧被忽略（不崩、不转发）", () => {
    const { client, sockets, frames } = harness()
    client.start()
    sockets[0]!.onopen?.()
    sockets[0]!.onmessage?.({ data: "{" })
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "future", seq: 1, payload: null }) })
    expect(frames).toHaveLength(0)
    expect(client.since).toBe(0)
    client.stop()
  })
})
