/**
 * MCP 会话失效自愈（404 → 同调用内重握手 + 原样重发一次）的回归测试。
 *
 * 为什么要有这一层：Hub 重启或 MCP 会话**空闲 TTL 淘汰**后，客户端缓存的 `mcp-session-id` 失效，
 * `tools/call` 直接吃 404。旧行为要等**下一次**调用才自愈 ⇒ 空闲 agent 恰好"被唤醒要回话"时
 * 会看到一次工具失败（写工具下模型可能重讲内容 → 重复消息）。
 *
 * 可安全重发的代码依据：`server/routes/mcp.ts` 在**转发之前**查会话表，未知 id 直接 404
 * ⇒ 该次调用**未被执行**。重发用同一 payload，调用方的 `idempotencyKey` 自动复用。
 *
 * 本文件钉死 A/B 提的五条要求：① 同调用重发一次且**身份头不变**；② 仍 404 → 稳定码
 * `mcp_session_expired` 且文案写明"未执行"；③ 重握手失败 → **透出原始错误**（绝不伪装成功）；
 * ④ 并发 404 → 握手**单飞**（只握一次）；⑤ 非 404（500/网络错）→ **不重试**、原样抛。
 */
import { describe, expect, it } from "vitest"
import { HubError } from "../lib/hub-config.js"
import { createMcpClient } from "../lib/mcp.js"

const bearer = { authorization: "Bearer test-token", "content-type": "application/json" }

interface Reply {
  readonly status: number
  readonly text: string
  readonly sessionId?: string
}
interface Call {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string>
}

/** 工具成功的 JSON-RPC 响应（`parseSseJson` 兼容裸 JSON）。 */
function toolOk(id: unknown, text = "ok"): Reply {
  return {
    status: 200,
    text: JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }),
  }
}
const sessionGone: Reply = { status: 404, text: JSON.stringify({ ok: false, error: "session_not_found" }) }

function makeTransport(handler: (call: Call, calls: readonly Call[]) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  return {
    calls,
    async send(path: string, body: unknown, headers: Record<string, string>) {
      const call: Call = { path, body: body as Record<string, unknown>, headers }
      calls.push(call)
      const reply = await handler(call, calls)
      return { status: reply.status, text: reply.text, sessionId: reply.sessionId }
    },
  }
}

/** 标准握手处理：每次 initialize 发一个新 session id。 */
function handshake(state: { sessions: number }, call: Call): Reply | undefined {
  if (call.body["method"] === "initialize") {
    state.sessions += 1
    return { status: 200, text: "{}", sessionId: `s${state.sessions}` }
  }
  if (call.body["method"] === "notifications/initialized") return { status: 200, text: "" }
  return undefined
}

describe("MCP 会话失效自愈（404 → 重握手 + 原样重发）", () => {
  it("首次 404 → 同调用内重握手并原样重发一次；逐调用身份头与 payload 不变", async () => {
    const state = { sessions: 0 }
    let toolCalls = 0
    const transport = makeTransport((call) => {
      const init = handshake(state, call)
      if (init !== undefined) return init
      expect(call.body["method"]).toBe("tools/call")
      toolCalls += 1
      return toolCalls === 1 ? sessionGone : toolOk(call.body["id"], "pong")
    })
    const client = createMcpClient(transport, bearer)

    await expect(client.call("inbox", { ack: true }, "session-abc")).resolves.toBe("pong")

    expect(state.sessions).toBe(2) // 首次握手 + 失效后重握手
    expect(toolCalls).toBe(2) // 404 + 重发
    const toolRequests = transport.calls.filter((c) => c.body["method"] === "tools/call")
    expect(toolRequests[1]?.headers["x-agentchat-session"]).toBe("session-abc") // 身份不丢（A 的回归要求）
    expect(toolRequests[1]?.headers["mcp-session-id"]).toBe("s2") // 用的是新会话
    expect(toolRequests[1]?.body["params"]).toEqual(toolRequests[0]?.body["params"]) // 原样重发
  })

  it("重发仍 404 → 抛稳定码 mcp_session_expired，文案写明「该次调用未执行」", async () => {
    const state = { sessions: 0 }
    const transport = makeTransport((call) => handshake(state, call) ?? sessionGone)
    const client = createMcpClient(transport, bearer)

    const error = await client.call("send", { to: "x", body: "y" }, "session-abc").then(
      () => undefined,
      (reason: unknown) => reason as HubError & { code?: string },
    )
    expect(error?.code).toBe("mcp_session_expired")
    expect(error?.status).toBe(404)
    expect(error?.message).toContain("未执行")
    expect(error?.message).toContain("原样重试")
    expect(state.sessions).toBe(2) // 只多握一次，不无限重试
  })

  it("重握手本身失败（Hub 仍在重启）→ 透出原始错误，绝不伪装成功", async () => {
    const state = { sessions: 0 }
    const transport = makeTransport((call) => {
      if (call.body["method"] === "initialize") {
        state.sessions += 1
        return state.sessions === 1
          ? { status: 200, text: "{}", sessionId: "s1" }
          : { status: 503, text: "hub restarting" }
      }
      if (call.body["method"] === "notifications/initialized") return { status: 200, text: "" }
      return sessionGone
    })
    const client = createMcpClient(transport, bearer)

    const error = await client.call("inbox", {}, "session-abc").then(
      () => undefined,
      (reason: unknown) => reason as HubError,
    )
    expect(error).toBeInstanceOf(HubError)
    expect(error?.status).toBe(503) // 原始 503 原样透出（不是 session_expired，也不是成功）
    expect(state.sessions).toBe(2)
  })

  it("并发两个调用同时 404 → 握手单飞（只握一次），两边都成功", async () => {
    const state = { sessions: 0 }
    const seenSessions = new Set<string>()
    let toolCalls = 0
    const transport = makeTransport((call) => {
      const init = handshake(state, call)
      if (init !== undefined) return init
      toolCalls += 1
      const sid = call.headers["mcp-session-id"] ?? ""
      seenSessions.add(sid)
      // 前两次（旧会话上的）调用 404；新会话上的调用全部成功
      if (sid === "s1") return sessionGone
      return toolOk(call.body["id"], "ok")
    })
    const client = createMcpClient(transport, bearer)

    const results = await Promise.all([
      client.call("inbox", { n: 1 }, "session-a"),
      client.call("inbox", { n: 2 }, "session-b"),
    ])

    expect(results).toEqual(["ok", "ok"])
    expect(state.sessions).toBe(2) // 初始 1 次 + 单飞的 1 次（不是 3 次）
    expect(seenSessions.has("s1")).toBe(true)
    expect(seenSessions.has("s2")).toBe(true)
    expect(toolCalls).toBe(4) // 两个调用各自的 404 + 重发
  })

  it("非 404（如 500）与网络错 → 不重试、原样抛出", async () => {
    const state = { sessions: 0 }
    let toolCalls = 0
    const transport = makeTransport((call) => {
      const init = handshake(state, call)
      if (init !== undefined) return init
      toolCalls += 1
      return { status: 500, text: "boom" }
    })
    const client = createMcpClient(transport, bearer)
    const error500 = await client.call("inbox", {}, "session-abc").then(
      () => undefined,
      (reason: unknown) => reason as HubError,
    )
    expect(error500?.status).toBe(500)
    expect(toolCalls).toBe(1) // 不重试
    expect(state.sessions).toBe(1)

    const networkError = new HubError("network", undefined, "fetch failed")
    const netTransport = makeTransport(() => {
      throw networkError
    })
    const netClient = createMcpClient(netTransport, bearer)
    const errorNet = await netClient.call("inbox", {}, "session-abc").then(
      () => undefined,
      (reason: unknown) => reason as HubError,
    )
    expect(errorNet).toBe(networkError) // 同一对象原样透出
  })
})
