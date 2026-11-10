/**
 * DSH 适配器核心（`adapters/dsh/lib/*.js`）单测。
 *
 * 覆盖：MCP register 握手（SSE + 裸 JSON）、`/internal/*` 端点的状态/形状归一化（含 wake 过滤
 * 畸形项与 retire 的 404 幂等）、5xx/网络错误的指数退避重试与 4xx 不重试、401 token 自愈、
 * 有界去重集 FIFO 淘汰、空闲轮询器的 tick/无重叠/失败退避、idle 拉取闭环的去重与 refused 路径、
 * 日志轮转阈值、token 落盘往返。
 *
 * 隔离：`fetch` **一律是本地假实现**（绝不接触真实网络，绝不连真实 Hub）；文件类用例一律用
 * 临时 `AGENTCHAT_HOME`（`tests/setup/isolate-home.ts` 已把进程级 home 指向一次性目录）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createIdleFlush, formatMessages } from "../lib/flush.js"
import { createHubClient, HubError, HubToolError } from "../lib/hub.js"
import { createFileLog } from "../lib/log.js"
import { createMcpClient } from "../lib/mcp.js"
import { IdlePoller, DEFAULT_POLL_MS, MAX_POLL_MS, MIN_POLL_MS, parsePollMs } from "../lib/poll.js"
import { agentIdPath, clearToken, readToken, seenPath, tokenPath, writeJson, readJson, writeToken } from "../lib/token.js"
import { createBoundedSet, createTaskQueue, describe as describeError, isRecord, parseCount, parseSwitch } from "../lib/util.js"

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-dsh-lib-"))
  homes.push(home)
  return home
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

// ── 假传输层 ──────────────────────────────────────────────────────────────────

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

interface ReplyOptions {
  readonly status?: number
  readonly body?: string
  readonly sessionId?: string
  /** 有值则**模拟网络层异常**（假 `fetch` 直接抛出，而非返回响应）。 */
  readonly error?: Error
}

interface Reply {
  readonly status: number
  readonly text: string
  readonly sessionId: string | undefined
  readonly error: Error | undefined
}

function replyOf(options: ReplyOptions): Reply {
  return {
    status: options.status ?? 200,
    text: options.body ?? "{}",
    sessionId: options.sessionId,
    error: options.error,
  }
}

function responseLike(reply: Reply): Response {
  return {
    status: reply.status,
    text: async () => reply.text,
    headers: { get: (name: string) => (name === "mcp-session-id" ? (reply.sessionId ?? null) : null) },
  } as unknown as Response
}

/** 极简假 `fetch`：按 URL 路径（+ 可选 MCP 方法）路由到固定回复，并记录每次调用。 */
function fakeFetch(handler: (path: string, body: Record<string, unknown>, call: Call) => Reply): {
  readonly fetch: typeof fetch
  readonly calls: Call[]
} {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(String(url))
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const call: Call = {
      url: String(url),
      method: typeof body["method"] === "string" ? body["method"] : "",
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    }
    calls.push(call)
    const reply = handler(parsed.pathname, body, call)
    if (reply.error !== undefined) throw reply.error
    return responseLike(reply)
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

/** 默认 handler：完成一次合法 MCP 注册，并让 `/internal/*` 返回 200 `{}`。 */
function defaultHandler(registerText: string, sessionId = "sess-1") {
  return (path: string, body: Record<string, unknown>): Reply => {
    if (path === "/mcp" && body["method"] === "initialize") {
      return replyOf({ body: "{}", sessionId })
    }
    if (path === "/mcp" && body["method"] === "tools/call") {
      return replyOf({ body: `data: ${JSON.stringify(sseFrame(registerText))}\n\n` })
    }
    return replyOf({ body: "{}" })
  }
}

/** MCP JSON-RPC 帧：`result.content[0].text` 承载工具返回值（server `toolResult` 约定）。 */
function sseFrame(text: string, isError = false): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  }
}

const REGISTER_PAYLOAD = JSON.stringify({ agent: { id: "agent-7" }, join_token: "jt-7" })

/** 注入文本的固定行（与 `flush.formatMessages` 的措辞一一对应）。 */
const FORMATTED_HEADER = "[AgentChat] 你收到了以下来自其他 agent 的消息，请据此继续工作："
/** 三条沟通规则：信息增量 + R1（agent 对 agent 只回一次）+ R2（不对人类复述工具输出）。 */
const FORMATTED_RULES = [
  "沟通规则：消息须有信息增量；禁纯回执/寒暄与复读循环；确认请并入下一步（详见 README「沟通规范」）。",
  "沟通规则：交流双方均为 agent 时，回复结果只写入 reply 一次，不要既 reply 又向会话重发一遍同样内容——没有观众。",
  "沟通规则：agent 回复人类时工具输出已可见，回话后不要再把工具结果复述一遍。",
]
/** 回复指引（P7/D12：会话 id + 「要回复就用 send」）。 */
const FORMATTED_FOOTER = "要回复就用 send 工具：私聊发给发送者 id，群消息发给会话（群）id —— 每条消息的会话标注里已给出。"
const FORMATTED_TWO_LINES = [
  FORMATTED_HEADER,
  ...FORMATTED_RULES,
  "- [m1] 来自 a1：第一条",
  "- [m2] 来自 a2：第二条",
  FORMATTED_FOOTER,
].join("\n")

interface Deps {
  readonly env: Record<string, string | undefined>
  readonly fetch: typeof fetch
  readonly log: (message: string) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly random: () => number
}

/** 默认依赖：即时 `sleep` + 确定 `random`（退避可断言且不真等）。 */
function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    env: { AGENTCHAT_URL: "http://127.0.0.1:9", HUB_TOKEN: "t-1", AGENTCHAT_HOME: tempHome() },
    fetch: fakeFetch(defaultHandler(REGISTER_PAYLOAD)).fetch,
    log: () => undefined,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  }
}

const opencodeBearer = { authorization: "Bearer t-1" }

// ── MCP register 握手 ────────────────────────────────────────────────────────

describe("MCP register 握手", () => {
  it("走 initialize → notifications/initialized → tools/call，并从 SSE 解析 agentId/joinToken", async () => {
    const fake = fakeFetch(defaultHandler(REGISTER_PAYLOAD, "sess-42"))
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    const result = await hub.register({ vendor: "dsh", role_tag: "container" })

    expect(result).toEqual({ agentId: "agent-7", joinToken: "jt-7" })
    expect(fake.calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ])
    expect(fake.calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:9/mcp",
      "http://127.0.0.1:9/mcp",
      "http://127.0.0.1:9/mcp",
    ])
    expect(fake.calls[0]?.headers["mcp-session-id"]).toBeUndefined()
    expect(fake.calls[1]?.headers["mcp-session-id"]).toBe("sess-42")
    expect(fake.calls[2]?.headers["mcp-session-id"]).toBe("sess-42")
    expect(fake.calls[0]?.headers["authorization"]).toBe(opencodeBearer.authorization)
    expect(fake.calls[0]?.headers["accept"]).toBe("application/json, text/event-stream")
    expect((fake.calls[0]?.body["params"] as Record<string, unknown>)["clientInfo"]).toEqual({
      name: "agentchat-dsh",
      version: "0.1.0",
    })
    expect(fake.calls[2]?.body["params"]).toEqual({
      name: "register",
      arguments: { vendor: "dsh", role_tag: "container" },
    })
  })

  it("接受裸 JSON 回复（无 SSE 包装）", async () => {
    const handler = fakeFetch((path, body) => {
      if (path === "/mcp" && body["method"] === "initialize") return replyOf({ body: "{}", sessionId: "s" })
      if (path === "/mcp" && body["method"] === "tools/call") {
        return replyOf({ body: JSON.stringify(sseFrame(REGISTER_PAYLOAD)) })
      }
      return replyOf({ body: "{}" })
    })
    const hub = createHubClient({ ...makeDeps(), fetch: handler.fetch })

    expect(await hub.register({})).toEqual({ agentId: "agent-7", joinToken: "jt-7" })
  })

  it("工具层 isError（HTTP 200）→ HubToolError 且带稳定 code", async () => {
    const fake = fakeFetch((path, body) => {
      if (path === "/mcp" && body["method"] === "initialize") return replyOf({ body: "{}", sessionId: "s" })
      if (path === "/mcp" && body["method"] === "tools/call") {
        return replyOf({ body: `data: ${JSON.stringify(sseFrame("Invalid join token [invalid_join_token]", true))}\n\n` })
      }
      return replyOf({ body: "{}" })
    })
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    const error = await hub.register({ join_token: "stale" }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(HubToolError)
    expect((error as HubToolError).code).toBe("invalid_join_token")
  })

  it("initialize 缺 mcp-session-id → HubError(protocol)", async () => {
    const fake = fakeFetch((path, body) => {
      if (path === "/mcp" && body["method"] === "initialize") return replyOf({ body: "{}" })
      return replyOf({ body: "{}" })
    })
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    const error = await hub.register({}).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as HubError).kind).toBe("protocol")
    expect(fake.calls).toHaveLength(1)
  })
})

// ── 逐调用 MCP 客户端（原生工具面复用同一个 client 服务所有会话）──────────────

describe("createMcpClient", () => {
  /** 假传输：记录每条 JSON-RPC 请求体与请求头，按方法回最小合法响应。 */
  function fakeTransport() {
    const bodies: Record<string, unknown>[] = []
    const headers: Record<string, string>[] = []
    const send = async (
      _path: string,
      body: unknown,
      header: Record<string, string>,
    ): Promise<{ status: number; text: string; sessionId: string | undefined }> => {
      const message = body as Record<string, unknown>
      bodies.push(message)
      headers.push(header)
      if (message["method"] === "initialize") return { status: 200, text: "{}", sessionId: "sess-1" }
      if (message["method"] === "tools/list") {
        return {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: { tools: [] } }),
          sessionId: undefined,
        }
      }
      return {
        status: 200,
        text: JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: { content: [{ type: "text", text: "ok" }] } }),
        sessionId: undefined,
      }
    }
    return { send, bodies, headers }
  }

  it("JSON-RPC id 每 client 自增（initialize 恒为 1）：并发 tools/call 绝不撞 id", async () => {
    const transport = fakeTransport()
    const client = createMcpClient(transport, { authorization: "Bearer t" })
    await client.list() // 建会话：initialize(id=1) + tools/list(id=2)

    // 真机场景：阻塞 ask + 并发 respond_ask —— 旧版两条 tools/call 都是 id:2，Hub 侧错投/超时。
    const results = await Promise.all([
      client.call("send", { to: "a", body: "1" }, "sess-a"),
      client.call("send", { to: "b", body: "2" }, "sess-b"),
      client.call("ask", { to: "c" }, "sess-c"),
    ])
    expect(results).toEqual(["ok", "ok", "ok"])

    const idsOf = (method: string) => transport.bodies.filter((body) => body["method"] === method).map((body) => body["id"])
    expect(idsOf("initialize")).toEqual([1])
    expect(idsOf("tools/list")).toEqual([2])
    const callIds = idsOf("tools/call")
    expect(callIds).toHaveLength(3)
    expect(new Set(callIds).size).toBe(3) // 唯一
    expect(callIds).toEqual([3, 4, 5]) // 且严格递增
    // 逐调用身份头各自成对（同一会话承载多会话调用）
    const callHeaders = transport.headers.filter((_header, index) => transport.bodies[index]?.["method"] === "tools/call")
    expect(callHeaders.map((header) => header["x-agentchat-session"])).toEqual(["sess-a", "sess-b", "sess-c"])
  })
})

// ── 重试 / 退避 ───────────────────────────────────────────────────────────────

describe("重试与退避（与 opencode 策略一致）", () => {
  it("5xx 按 250/500/1000ms（+jitter）退避重试，成功后返回结果", async () => {
    let attempt = 0
    const fake = fakeFetch((path, body) => {
      if (path === "/mcp" && body["method"] === "initialize") {
        attempt += 1
        if (attempt < 3) return replyOf({ status: 503, body: "unavailable" })
        return replyOf({ body: "{}", sessionId: "s-after-retry" })
      }
      if (path === "/mcp" && body["method"] === "tools/call") {
        return replyOf({ body: `data: ${JSON.stringify(sseFrame(REGISTER_PAYLOAD))}\n\n` })
      }
      return replyOf({ body: "{}" })
    })
    const delays: number[] = []
    const hub = createHubClient({
      ...makeDeps(),
      fetch: fake.fetch,
      sleep: async (ms: number) => {
        delays.push(ms)
      },
      random: () => 0.5,
    })

    expect((await hub.register({})).agentId).toBe("agent-7")
    // 每次尝试 = 一次 initialize + 两次后续请求；503 的两次尝试不进入后续步骤。
    expect(attempt).toBe(3)
    expect(fake.calls.filter((call) => call.method === "initialize")).toHaveLength(3)
    // attempt0: 250 + 0.5·250 = 375；attempt1: 500 + 125 = 625。
    expect(delays).toEqual([375, 625])
  })

  it("429 同样重试，4xx（401/400）不重试且抛 HubError(http)", async () => {
    let calls = 0
    const tooMany = fakeFetch(() => {
      calls += 1
      return calls === 1 ? replyOf({ status: 429, body: "slow down" }) : replyOf({ status: 400, body: "bad" })
    })
    const hub429 = createHubClient({ ...makeDeps(), fetch: tooMany.fetch })
    const error429 = await hub429.reportState("a", "idle").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error429 as HubError).kind).toBe("http")
    expect((error429 as HubError).status).toBe(400)
    expect(tooMany.calls).toHaveLength(2)

    const deterministic = fakeFetch(() => replyOf({ status: 404, body: "gone" }))
    const hub404 = createHubClient({ ...makeDeps(), fetch: deterministic.fetch })
    const error404 = await hub404.reportState("a", "idle").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error404 as HubError).status).toBe(404)
    expect(deterministic.calls).toHaveLength(1)
  })

  it("网络错误重试到耗尽 → HubError(network)，共 4 次尝试", async () => {
    const fake = fakeFetch(() => replyOf({ error: new Error("connect ECONNREFUSED 127.0.0.1:9") }))
    const delays: number[] = []
    const hub = createHubClient({
      ...makeDeps(),
      fetch: fake.fetch,
      sleep: async (ms: number) => {
        delays.push(ms)
      },
    })

    const error = await hub.reportState("a", "idle").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as HubError).name).toBe("HubError")
    expect((error as HubError).kind).toBe("network")
    expect((error as HubError).message).toContain("ECONNREFUSED")
    expect(fake.calls).toHaveLength(4)
    expect(delays).toEqual([250, 500, 1000])
  })

  it("401 后重读到新 token → 更新 bearer 并仅重试一次", async () => {
    const home = tempHome()
    writeFileSync(join(home, "hub_token"), "t-1")
    let seenAuth: string[] = []
    let attempt = 0
    const fake = fakeFetch((_path, _body, call) => {
      seenAuth.push(call.headers["authorization"] ?? "")
      attempt += 1
      if (attempt === 1) {
        writeFileSync(join(home, "hub_token"), "t-2")
        return replyOf({ status: 401, body: "unauthorized" })
      }
      return replyOf({ body: "{}" })
    })
    const hub = createHubClient({
      ...makeDeps({ env: { AGENTCHAT_URL: "http://127.0.0.1:9", AGENTCHAT_HOME: home } }),
      fetch: fake.fetch,
    })

    await hub.reportState("a", "idle")

    expect(seenAuth).toEqual(["Bearer t-1", "Bearer t-2"])
    expect(fake.calls).toHaveLength(2)
  })

  it("401 且 token 未变化 → 不重试，抛 HubError(http, 401)", async () => {
    const home = tempHome()
    writeFileSync(join(home, "hub_token"), "t-1")
    const fake = fakeFetch(() => replyOf({ status: 401, body: "unauthorized" }))
    const hub = createHubClient({
      ...makeDeps({ env: { AGENTCHAT_URL: "http://127.0.0.1:9", AGENTCHAT_HOME: home } }),
      fetch: fake.fetch,
    })

    const error = await hub.reportState("a", "idle").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as HubError).status).toBe(401)
    expect(fake.calls).toHaveLength(1)
  })
})

// ── /internal/* 端点 ─────────────────────────────────────────────────────────

describe("/internal 端点", () => {
  it("reportState / reportResult 发送约定载荷并接受 200", async () => {
    const fake = fakeFetch(() => replyOf({ body: "{}" }))
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    await hub.reportState("agent-7", "busy")
    await hub.reportResult("agent-7", [{ messageId: "m1", result: "delivered" }])

    expect(fake.calls[0]?.url).toBe("http://127.0.0.1:9/internal/state")
    expect(fake.calls[0]?.body).toEqual({ agentId: "agent-7", state: "busy" })
    expect(fake.calls[1]?.url).toBe("http://127.0.0.1:9/internal/result")
    expect(fake.calls[1]?.body).toEqual({ agentId: "agent-7", items: [{ messageId: "m1", result: "delivered" }] })
  })

  it("wake 过滤畸形项并保留合法消息", async () => {
    const body = JSON.stringify({
      messages: [
        { id: "m1", fromAgentId: "a1", body: "第一条", conversationId: "c1" },
        { id: 42, fromAgentId: "a1", body: "id 非字符串" },
        { id: "m2", fromAgentId: null, body: "from 非字符串" },
        { id: "m3", fromAgentId: "a1", body: 7 },
        null,
        "not-an-object",
        { id: "m4", fromAgentId: "a2", body: "第二条" },
      ],
    })
    const fake = fakeFetch(() => replyOf({ body }))
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    const messages = await hub.wake("agent-7")

    expect(messages).toEqual([
      { id: "m1", fromAgentId: "a1", body: "第一条", conversationId: "c1" },
      { id: "m4", fromAgentId: "a2", body: "第二条" },
    ])
    expect(fake.calls[0]?.body).toEqual({ agentId: "agent-7" })
  })

  it("wake 响应缺 messages 数组 → HubError(protocol)（不静默当作空）", async () => {
    const fake = fakeFetch(() => replyOf({ body: JSON.stringify({ nope: true }) }))
    const hub = createHubClient({ ...makeDeps(), fetch: fake.fetch })

    const error = await hub.wake("agent-7").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as HubError).kind).toBe("protocol")
  })

  it("retire：404 视为已退役（不抛错），200 静默成功，500 抛错", async () => {
    const gone = createHubClient({ ...makeDeps(), fetch: fakeFetch(() => replyOf({ status: 404, body: "agent_not_found" })).fetch })
    await expect(gone.retire("agent-7")).resolves.toBeUndefined()

    const ok = fakeFetch(() => replyOf({ body: "{}" }))
    await expect(createHubClient({ ...makeDeps(), fetch: ok.fetch }).retire("agent-7")).resolves.toBeUndefined()
    expect(ok.calls[0]?.body).toEqual({ agentId: "agent-7" })

    const failing = createHubClient({ ...makeDeps(), fetch: fakeFetch(() => replyOf({ status: 500, body: "boom" })).fetch })
    const error = await failing.retire("agent-7").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as HubError).kind).toBe("exhausted")
  })

  it("Hub 地址解析：AGENTCHAT_PORT 兜底 + URL 末尾斜杠归一化", async () => {
    const fake = fakeFetch(() => replyOf({ body: "{}" }))
    const hub = createHubClient({
      ...makeDeps({ env: { AGENTCHAT_URL: "http://127.0.0.1:7777///", AGENTCHAT_PORT: "4646", HUB_TOKEN: "t-1" } }),
      fetch: fake.fetch,
    })

    await hub.reportState("a", "idle")
    expect(fake.calls[0]?.url).toBe("http://127.0.0.1:7777/internal/state")

    const byPort = fakeFetch(() => replyOf({ body: "{}" }))
    const hubByPort = createHubClient({
      ...makeDeps({ env: { AGENTCHAT_PORT: "5555", HUB_TOKEN: "t-1", AGENTCHAT_HOME: tempHome() } }),
      fetch: byPort.fetch,
    })
    await hubByPort.reportState("a", "idle")
    expect(byPort.calls[0]?.url).toBe("http://127.0.0.1:5555/internal/state")
  })
})

// ── util ─────────────────────────────────────────────────────────────────────

describe("util", () => {
  it("createBoundedSet FIFO 淘汰最旧，重复 add 不改变顺序", () => {
    const seen = createBoundedSet(3)
    seen.add("a")
    seen.add("b")
    seen.add("c")
    expect(seen.has("a")).toBe(true)
    seen.add("a") // 重复：不刷新年龄
    seen.add("d") // 淘汰最旧的 a
    expect(seen.has("a")).toBe(false)
    expect(seen.has("b")).toBe(true)
    expect(seen.has("d")).toBe(true)
  })

  it("createBoundedSet(0) 不保留任何 id", () => {
    const seen = createBoundedSet(0)
    seen.add("a")
    expect(seen.has("a")).toBe(false)
  })

  it("parseSwitch：布尔/1/0/on/off/yes/no 都认；空串与无法识别回落 fallback", () => {
    expect(parseSwitch(true, false)).toBe(true)
    expect(parseSwitch(false, true)).toBe(false)
    expect(parseSwitch(1, false)).toBe(true) // YAML `busyInject: 1`
    expect(parseSwitch(0, true)).toBe(false)
    expect(parseSwitch(" ON ", false)).toBe(true)
    expect(parseSwitch("0", true)).toBe(false)
    expect(parseSwitch("NO", true)).toBe(false)
    expect(parseSwitch("", true)).toBe(true) // 空串 ≠ false
    expect(parseSwitch(undefined, true)).toBe(true)
    expect(parseSwitch("maybe", false)).toBe(false)
  })

  it("parseCount：空串/负数/非数值回落 fallback；小数向下取整；0 合法", () => {
    expect(parseCount(2, 1)).toBe(2)
    expect(parseCount("3", 1)).toBe(3)
    expect(parseCount("2.9", 1)).toBe(2)
    expect(parseCount("", 1)).toBe(1) // 空串 ≠ 0
    expect(parseCount(undefined, 1)).toBe(1)
    expect(parseCount("-1", 1)).toBe(1)
    expect(parseCount("abc", 1)).toBe(1)
    expect(parseCount(0, 1)).toBe(0) // 0 = 忙时不注入，是合法配额
  })

  it("createTaskQueue 串行保序并吞掉任务异常；flush 等待排空", async () => {
    const queue = createTaskQueue()
    const order: string[] = []
    queue.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push("first")
    })
    queue.push(async () => {
      order.push("boom")
      throw new Error("ignored")
    })
    queue.push(async () => {
      order.push("third")
    })
    await queue.flush()
    expect(order).toEqual(["first", "boom", "third"])
  })

  it("describe 渲染各类错误（HubError / HubToolError / Error / 普通对象截断）", () => {
    const hubError = new HubError("network", undefined, "boom")
    expect(describeError(hubError)).toBe("network: boom")
    expect(describeError(new HubToolError("invalid_join_token", "bad [invalid_join_token]"))).toBe(
      "invalid_join_token: bad [invalid_join_token]",
    )
    expect(describeError(new Error("plain"))).toBe("plain")
    expect(describeError("raw string")).toBe("raw string")
    expect(describeError({ error: "not found" })).toBe('{"error":"not found"}')
    expect(describeError({ blob: "x".repeat(500) }).length).toBe(200)
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    expect(typeof describeError(circular)).toBe("string")
  })

  it("isRecord 排除数组与 null", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
  })
})

// ── 空闲轮询 ─────────────────────────────────────────────────────────────────

describe("parsePollMs / IdlePoller", () => {
  it("非法值回落默认，合法值钳制到 [1s, 1h]", () => {
    expect(parsePollMs(undefined)).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("abc")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("0")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("-5")).toBe(DEFAULT_POLL_MS)
    expect(parsePollMs("5000")).toBe(5000)
    expect(parsePollMs("500")).toBe(MIN_POLL_MS)
    expect(parsePollMs("99999999")).toBe(MAX_POLL_MS)
  })

  it("成功按基础间隔持续 tick，重复 start 不叠加", async () => {
    vi.useFakeTimers()
    let runs = 0
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: async () => {
        runs += 1
        return true
      },
    })
    poller.start()
    poller.start()
    expect(runs).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    poller.stop()
    expect(poller.isRunning).toBe(false)
  })

  it("run 未落定时不重入（无重叠执行）", async () => {
    vi.useFakeTimers()
    let runs = 0
    let release: (() => void) | undefined
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: () => {
        runs += 1
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        })
      },
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toBe(1)
    release?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    poller.stop()
  })

  it("失败按指数退避并在成功后复位", async () => {
    vi.useFakeTimers()
    let runs = 0
    let remainingFailures = 2
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: async () => {
        runs += 1
        if (remainingFailures > 0) {
          remainingFailures -= 1
          return false
        }
        return true
      },
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1999)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(3999)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toBe(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(4)
    poller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toBe(4)
  })

  it("run 抛错按失败处理（不冒泡），stop 后不再 tick", async () => {
    vi.useFakeTimers()
    let runs = 0
    const poller = new IdlePoller({
      intervalMs: 1000,
      run: async () => {
        runs += 1
        throw new Error("boom")
      },
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(runs).toBe(2)
    poller.stop()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toBe(2)
  })
})

// ── idle 拉取闭环 ────────────────────────────────────────────────────────────

interface FlushHarness {
  readonly flush: (
    nodeId: string,
    agentId: string,
    options?: { readonly state?: HeartbeatState; readonly claim?: boolean },
  ) => Promise<boolean>
  readonly deliveries: Array<{ readonly nodeId: string; readonly texts: readonly string[] }>
  readonly receipts: Array<ReadonlyArray<{ messageId: string; result: string }>>
  readonly heartbeats: string[]
  /** 每轮心跳的 `agentId:state`（忙时必须 `busy`，见 `heartbeat` 参数化）。 */
  readonly heartbeatStates: string[]
  /** 每次 `wake` 收到的 `agentId`（`claim:false` 时应当为空）。 */
  readonly wakes: string[]
  readonly logs: string[]
  readonly seen: { has(id: string): boolean; add(id: string): void; size(): number }
}

type HeartbeatState = "idle" | "busy"

function makeFlush(
  messages: ReadonlyArray<{ id: string; fromAgentId: string; body: string }>,
  outcome: "delivered" | "refused" | (() => Promise<"delivered" | "refused">) = "delivered",
): FlushHarness {
  const deliveries: FlushHarness["deliveries"] = []
  const receipts: FlushHarness["receipts"] = []
  const heartbeats: string[] = []
  const heartbeatStates: string[] = []
  const wakes: string[] = []
  const logs: string[] = []
  const seen = createBoundedSet(256)
  const hub = {
    wake: async (agentId: string) => {
      wakes.push(agentId)
      return messages
    },
    reportResult: async (_agentId: string, items: ReadonlyArray<{ messageId: string; result: string }>) => {
      receipts.push(items)
    },
  }
  const flush = createIdleFlush({
    hub,
    deliver: async (nodeId, texts) => {
      deliveries.push({ nodeId, texts })
      return typeof outcome === "function" ? outcome() : outcome
    },
    seen,
    heartbeat: async (agentId: string, state: HeartbeatState) => {
      heartbeats.push(agentId)
      heartbeatStates.push(`${agentId}:${state}`)
    },
    log: (message) => logs.push(message),
  })
  return { flush, deliveries, receipts, heartbeats, heartbeatStates, wakes, logs, seen }
}

describe("createIdleFlush 闭环", () => {
  it("心跳 → wake → 注入 → 逐条回执 delivered，并把 id 记入 seen", async () => {
    const messages = [
      { id: "m1", fromAgentId: "a1", body: "第一条" },
      { id: "m2", fromAgentId: "a2", body: "第二条" },
    ]
    const h = makeFlush(messages)

    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)

    expect(h.heartbeats).toEqual(["agent-7"])
    expect(h.deliveries).toHaveLength(1)
    expect(h.deliveries[0]?.nodeId).toBe("node-1")
    expect(h.deliveries[0]?.texts).toEqual([FORMATTED_TWO_LINES])
    expect(h.receipts).toEqual([
      [
        { messageId: "m1", result: "delivered" },
        { messageId: "m2", result: "delivered" },
      ],
    ])
    expect(h.seen.has("m1")).toBe(true)
    expect(h.seen.has("m2")).toBe(true)
  })

  it("租约重投的重复消息不重复注入，只补回执；混合新旧时只注入新消息", async () => {
    const h = makeFlush([
      { id: "m1", fromAgentId: "a1", body: "第一条" },
      { id: "m2", fromAgentId: "a2", body: "第二条" },
      { id: "m3", fromAgentId: "a3", body: "第三条" },
    ])
    h.seen.add("m1")
    h.seen.add("m2")

    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)

    expect(h.deliveries).toHaveLength(1)
    expect(h.deliveries[0]?.texts[0]).toContain("第三条")
    expect(h.deliveries[0]?.texts[0]).not.toContain("第一条")
    expect(h.receipts).toEqual([
      [
        { messageId: "m1", result: "delivered" },
        { messageId: "m2", result: "delivered" },
        { messageId: "m3", result: "delivered" },
      ],
    ])
  })

  it("全部命中 seen 时完全不调用 deliver，只补回执", async () => {
    const h = makeFlush([{ id: "m1", fromAgentId: "a1", body: "第一条" }])
    h.seen.add("m1")

    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)
    expect(h.deliveries).toHaveLength(0)
    expect(h.receipts).toEqual([[{ messageId: "m1", result: "delivered" }]])
  })

  it("无消息时不注入也不回执", async () => {
    const h = makeFlush([])
    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)
    expect(h.deliveries).toHaveLength(0)
    expect(h.receipts).toHaveLength(0)
  })

  it("心跳携带真实状态：state:'busy' → 上报 busy；缺省仍是 idle", async () => {
    const h = makeFlush([{ id: "m1", fromAgentId: "a1", body: "第一条" }])
    await expect(h.flush("node-1", "agent-7", { state: "busy" })).resolves.toBe(true)
    expect(h.heartbeatStates).toEqual(["agent-7:busy"]) // 忙时报 busy，绝不把 Hub 的 busy 反翻成 online
    expect(h.deliveries).toHaveLength(1)
    expect(h.receipts).toEqual([[{ messageId: "m1", result: "delivered" }]])

    const idle = makeFlush([])
    await idle.flush("node-1", "agent-7") // 不传 options = 旧的 idle 语义
    expect(idle.heartbeatStates).toEqual(["agent-7:idle"])
  })

  it("claim:false → 只发心跳：绝不 wake/注入/回执/写 seen（忙时配额用尽）", async () => {
    const h = makeFlush([{ id: "m1", fromAgentId: "a1", body: "第一条" }])
    await expect(h.flush("node-1", "agent-7", { state: "busy", claim: false })).resolves.toBe(true)
    expect(h.heartbeatStates).toEqual(["agent-7:busy"])
    expect(h.wakes).toEqual([]) // 不认领：消息留在 Hub 排队，绝不留未回执的在途租约
    expect(h.deliveries).toHaveLength(0)
    expect(h.receipts).toHaveLength(0)
    expect(h.seen.has("m1")).toBe(false)
  })

  it("deliver 返回 refused → 回执 refused 且**不**记入 seen（下次仍可注入）", async () => {
    const h = makeFlush([{ id: "m1", fromAgentId: "a1", body: "第一条" }], "refused")

    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)
    expect(h.receipts).toEqual([[{ messageId: "m1", result: "refused" }]])
    expect(h.seen.has("m1")).toBe(false)
    expect(h.logs.some((line) => line.includes("inject refused for m1"))).toBe(true)

    // 第二轮仍会尝试注入（因为未被记为已注入）。
    await h.flush("node-1", "agent-7")
    expect(h.deliveries).toHaveLength(2)
  })

  it("deliver 抛错 → 逐条 refused、不写入 seen、绝不冒泡", async () => {
    const h = makeFlush([{ id: "m1", fromAgentId: "a1", body: "第一条" }], async () => {
      throw new Error("host exploded")
    })

    await expect(h.flush("node-1", "agent-7")).resolves.toBe(true)
    expect(h.receipts).toEqual([[{ messageId: "m1", result: "refused" }]])
    expect(h.seen.has("m1")).toBe(false)
    expect(h.logs.some((line) => line.includes("host exploded"))).toBe(true)
  })

  it("wake 失败 → 返回 false（供退避）且不注入", async () => {
    const logs: string[] = []
    const flush = createIdleFlush({
      hub: {
        wake: async () => {
          throw new HubError("network", undefined, "connect ECONNREFUSED")
        },
        reportResult: async () => undefined,
      },
      deliver: async () => "delivered",
      seen: createBoundedSet(16),
      heartbeat: async () => undefined,
      log: (message) => logs.push(message),
    })

    await expect(flush("node-1", "agent-7")).resolves.toBe(false)
    expect(logs.some((line) => line.includes("wake failed: network: connect ECONNREFUSED"))).toBe(true)
  })

  it("回执上报失败 → 返回 false；心跳失败只记日志、不阻断本轮注入", async () => {
    const logs: string[] = []
    const seen = createBoundedSet(16)
    const flush = createIdleFlush({
      hub: {
        wake: async () => [{ id: "m1", fromAgentId: "a1", body: "第一条" }],
        reportResult: async () => {
          throw new HubError("exhausted", 503, "retries exhausted")
        },
      },
      deliver: async () => "delivered",
      seen,
      heartbeat: async () => {
        throw new Error("heartbeat down")
      },
      log: (message) => logs.push(message),
    })

    await expect(flush("node-1", "agent-7")).resolves.toBe(false)
    expect(seen.has("m1")).toBe(true)
    expect(logs.some((line) => line.includes("idle heartbeat failed: heartbeat down"))).toBe(true)
    expect(logs.some((line) => line.includes("result report failed: exhausted: retries exhausted"))).toBe(true)
  })

  it("formatMessages：头部 + 三条规则 + 每条一行（含会话 id）+ 回复指引；空白正文被丢弃", () => {
    expect(formatMessages([])).toBe([FORMATTED_HEADER, ...FORMATTED_RULES, FORMATTED_FOOTER].join("\n"))
    const text = formatMessages([
      { id: "m1", fromAgentId: "a1", body: "正文", conversationId: "conv-7" },
      { id: "m2", fromAgentId: "a2", body: "   " },
    ])
    expect(text.split("\n")).toEqual([
      FORMATTED_HEADER,
      ...FORMATTED_RULES,
      "- [m1] 来自 a1（会话 conv-7）：正文", // 前缀 `- [id] 来自 <from>` 原样，会话 id 追加在其后
      FORMATTED_FOOTER,
    ])
    // 无 conversationId（旧 Hub / 非会话消息）→ 省略括号，前缀契约不变（矩阵用它解析 messageId）
    expect(formatMessages([{ id: "m3", fromAgentId: "a3", body: "正文" }])).toContain("- [m3] 来自 a3：正文")
    expect(/^-\s+\[m3\]\s+来自\s/m.test(formatMessages([{ id: "m3", fromAgentId: "a3", body: "x" }]))).toBe(true)
    expect(text).toContain("send") // D12：要回复就用 send
  })
})

// ── 文件：日志 / token ───────────────────────────────────────────────────────

describe("createFileLog", () => {
  it("追加 `<ISO> [scope] message` 行，并在超阈值时轮转到 `.1`（只保留一份）", () => {
    const home = tempHome()
    const write = createFileLog({ AGENTCHAT_HOME: home }, "plugin", 64)
    const logFile = join(home, "logs", "dsh-adapter.log")

    write("A".repeat(100))
    expect(existsSync(`${logFile}.1`)).toBe(false)

    write("after-rotate")
    expect(readFileSync(`${logFile}.1`, "utf8")).toContain("A".repeat(100))
    const current = readFileSync(logFile, "utf8")
    expect(current).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[plugin\] after-rotate\n$/)

    write("B".repeat(100))
    write("third")
    const rotated = readFileSync(`${logFile}.1`, "utf8")
    expect(rotated).toContain("B".repeat(100))
    expect(rotated).toContain("after-rotate")
    expect(rotated).not.toContain("A".repeat(100))
  })

  it("AGENTCHAT_LOG=console 打 stderr，不落文件", () => {
    const home = tempHome()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const write = createFileLog({ AGENTCHAT_HOME: home, AGENTCHAT_LOG: "console" }, "plugin")

    write("console-mode probe")

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatch(/\[plugin\] console-mode probe$/)
    expect(existsSync(join(home, "logs", "dsh-adapter.log"))).toBe(false)
  })

  it("路径不可写时静默（日志失败绝不影响宿主）", () => {
    const blocker = join(tempHome(), "blocker")
    writeFileSync(blocker, "a plain file, not a directory")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const write = createFileLog({ AGENTCHAT_HOME: join(blocker, "home") }, "plugin")

    expect(() => write("cannot be written")).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("token 文件", () => {
  it("路径：vendor id 为 dsh", () => {
    const home = join("C:", "tmp", "home")
    expect(tokenPath(home)).toBe(join(home, "agents", "dsh.token"))
    expect(agentIdPath(home)).toBe(join(home, "agents", "dsh.id"))
    expect(seenPath(home)).toBe(join(home, "agents", "dsh.seen.json"))
  })

  it("writeToken → readToken 往返；clearToken 后读回 undefined", () => {
    const home = tempHome()
    const path = tokenPath(home)

    expect(writeToken(path, "jt-roundtrip")).toEqual({ ok: true })
    expect(readToken(path)).toBe("jt-roundtrip")

    expect(clearToken(path)).toEqual({ ok: true })
    expect(readToken(path)).toBeUndefined()
    // 再次 clear（文件不存在）视为成功。
    expect(clearToken(path)).toEqual({ ok: true })
  })

  it("writeJson / readJson 往返；空白文件与非法 JSON 视为「无」", () => {
    const home = tempHome()
    const path = seenPath(home)

    expect(writeJson(path, { ids: ["m1", "m2"], at: 1 })).toEqual({ ok: true })
    expect(readJson(path)).toEqual({ ids: ["m1", "m2"], at: 1 })

    writeFileSync(path, "   \n")
    expect(readJson(path)).toBeUndefined()

    writeFileSync(path, "{ not json")
    expect(readJson(path)).toBeUndefined()
    expect(readToken(join(home, "agents", "missing.token"))).toBeUndefined()
  })

  it("readToken：ENOENT 不重试；瞬时 EPERM 有限重试", () => {
    const home = tempHome()
    let enoentCalls = 0
    const enoent = (): string => {
      enoentCalls += 1
      const error = new Error("ENOENT") as NodeJS.ErrnoException
      error.code = "ENOENT"
      throw error
    }
    expect(readToken(tokenPath(home), { read: enoent, delayMs: 0 })).toBeUndefined()
    expect(enoentCalls).toBe(1)

    let calls = 0
    const noisy = (): string => {
      calls += 1
      if (calls < 3) {
        const error = new Error("EPERM") as NodeJS.ErrnoException
        error.code = "EPERM"
        throw error
      }
      return "agent-9\n"
    }
    expect(readToken(agentIdPath(home), { read: noisy, delayMs: 0 })).toBe("agent-9")
    expect(calls).toBe(3)
  })
})
