/**
 * 原生工具面测试（修"共享单文件猜身份"的根治方案）。
 *
 * 核心断言：**同一 MCP 会话内，逐调用按调用者会话注入 `x-agentchat-session`**——
 * 两个不同会话并发调用必须各自带自己的 `task_ref`，绝不串号（真机事故的回归）。
 * 另覆盖：拿不到调用者会话时**拒发**（不猜、不回落容器）、工具定义由 `tools/list` 动态生成、
 * Hub 报错转文本不抛、卸载反注册。
 */
import { describe, expect, it } from "vitest"
import { createMcpClient } from "../lib/mcp.js"
import { createNativeTools, NO_SESSION_TEXT, toolDefinition, TOOL_PREFIX } from "../lib/native-tools.js"

interface Sent {
  readonly method: string
  readonly headers: Record<string, string>
  readonly name: string | undefined
  readonly args: unknown
}

/** 假传输：initialize → 会话；tools/list → 两条工具；tools/call → 回显文本。 */
function fakeTransport(tools: unknown[] = defaultTools) {
  const sent: Sent[] = []
  const send = async (_path: string, rawBody: unknown, headers: Record<string, string>) => {
    const body = rawBody as Record<string, unknown>
    sent.push({ method: String(body["method"]), headers, ...callFields(body) })
    if (body["method"] === "initialize") return { status: 200, text: "{}", sessionId: "mcp-sess-1" }
    if (body["method"] === "notifications/initialized") return { status: 202, text: "", sessionId: undefined }
    if (body["method"] === "tools/list") {
      return { status: 200, text: `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } })}\n\n`, sessionId: undefined }
    }
    const name = String(callFields(body).name)
    if (name === "boom") {
      return { status: 200, text: toolFrame("HubToolError: 炸了", true), sessionId: undefined }
    }
    return { status: 200, text: toolFrame(`ok:${name}`), sessionId: undefined }
  }
  return { sent, send }
}

function callFields(body: Record<string, unknown>): { name: string | undefined; args: unknown } {
  const params = body["params"] as Record<string, unknown> | undefined
  return { name: params?.["name"] as string | undefined, args: params?.["arguments"] }
}
function toolFrame(text: string, isError = false): string {
  const result = { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
  return `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result })}\n\n`
}
const defaultTools = [
  { name: "send", description: "发消息", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
  { name: "boom", inputSchema: { type: "object", properties: {} } },
]

/** 建原生工具面 + 记录注册的定义。 */
function setup(tools: unknown[] = defaultTools) {
  const transport = fakeTransport(tools)
  const registered: Record<string, unknown>[] = []
  const unregistered: string[] = []
  const logs: string[] = []
  const sessions = new Map([
    ["session-aaaa", { nodeId: "node-A" }],
    ["session-bbbb", { nodeId: "node-B" }],
  ])
  const native = createNativeTools({
    ctx: { get: () => undefined },
    hub: { mcp: () => client(transport.send) },
    sessions,
    log: (message) => void logs.push(message),
    register: (definition) => {
      registered.push(definition)
      return () => void unregistered.push(String(definition["name"]))
    },
  })
  return { native, transport, registered, unregistered, logs }
}
/** 与 `hub.mcp()` 同形状的客户端（复用生产实现，避免测试与实现漂移）。 */
function client(send: ReturnType<typeof fakeTransport>["send"]) {
  return createMcpClient({ send }, { authorization: "Bearer t", "content-type": "application/json" }, {})
}

describe("原生工具面（逐调用身份）", () => {
  it("从 tools/list 动态生成工具定义：名字带前缀、schema 原样透传、输出走 render", async () => {
    const { native, registered } = setup()
    expect(await native.registerAll()).toBe(2)
    const send = registered.find((d) => d["name"] === `${TOOL_PREFIX}send`)
    expect(send).toBeDefined()
    expect(send?.["description"]).toBe("发消息")
    expect(send?.["parameters"]).toEqual({ type: "object", properties: { to: { type: "string" } } })
    const output = send?.["output"] as { render: (a: unknown, v: unknown) => unknown[] }
    expect(output.render({}, { text: "hi" })).toEqual([{ type: "text", text: "hi" }])
  })

  it("**逐调用按调用者会话注入身份**：两个会话交错调用各自带自己的 task_ref（绝不串号）", async () => {
    const { native, registered, transport } = setup()
    await native.registerAll()
    const send = registered.find((d) => d["name"] === `${TOOL_PREFIX}send`) as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string }>
    }
    const execA = { agent: { session: { header: { id: "session-aaaa" } } } }
    const execB = { agent: { session: { header: { id: "session-bbbb" } } } }
    const [ra, rb, ra2] = await Promise.all([
      send.execute({ to: "成员A" }, execA),
      send.execute({ to: "成员B" }, execB),
      send.execute({ to: "成员A" }, execA),
    ])
    expect([ra.text, rb.text, ra2.text]).toEqual(["ok:send", "ok:send", "ok:send"])
    const calls = transport.sent.filter((entry) => entry.method === "tools/call")
    expect(calls.map((entry) => entry.headers["x-agentchat-session"])).toEqual([
      "session-aaaa",
      "session-bbbb",
      "session-aaaa",
    ])
    // 且 initialize 只握手一次（同一身份头机制承载全部会话）。
    expect(transport.sent.filter((entry) => entry.method === "initialize")).toHaveLength(1)
  })

  it("拿不到调用者会话 → **拒发**（不猜、不回落容器），且不产生任何 tools/call", async () => {
    const { native, registered, transport } = setup()
    await native.registerAll()
    const send = registered.find((d) => d["name"] === `${TOOL_PREFIX}send`) as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string }>
    }
    const results = await Promise.all([
      send.execute({}, undefined),
      send.execute({}, { agent: { session: { header: { id: "session-unknown" } } } }),
      send.execute({}, { agent: undefined }),
    ])
    expect(results.map((r) => r.text)).toEqual([NO_SESSION_TEXT, NO_SESSION_TEXT, NO_SESSION_TEXT])
    expect(transport.sent.filter((entry) => entry.method === "tools/call")).toHaveLength(0)
  })

  it("Hub 工具报错 → 转成文本结果（不抛给宿主），并记日志", async () => {
    const { native, registered, logs } = setup()
    await native.registerAll()
    const boom = registered.find((d) => d["name"] === `${TOOL_PREFIX}boom`) as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string }>
    }
    const result = await boom.execute({}, { agent: { session: { header: { id: "session-aaaa" } } } })
    expect(result.text).toContain("AgentChat 调用失败")
    expect(logs.some((line) => line.includes("原生工具 boom 调用失败"))).toBe(true)
  })

  it("tools 服务不可用 / 注册被拒 → 只记日志、不抛、逐个跳过", async () => {
    const transport = fakeTransport()
    const logs: string[] = []
    const noService = createNativeTools({
      ctx: { get: () => undefined },
      hub: { mcp: () => client(transport.send) },
      sessions: new Map(),
      log: (m) => void logs.push(m),
    })
    expect(await noService.registerAll()).toBe(0)
    expect(logs.some((line) => line.includes("tools 服务不可用"))).toBe(true)

    const partial = createNativeTools({
      ctx: { get: () => undefined },
      hub: { mcp: () => client(transport.send) },
      sessions: new Map(),
      log: (m) => void logs.push(m),
      register: (definition) => {
        if (String(definition["name"]).endsWith("send")) throw new Error("schema 不受支持")
        return () => {}
      },
    })
    expect(await partial.registerAll()).toBe(1)
    expect(logs.some((line) => line.includes("注册原生工具 send 失败"))).toBe(true)
  })

  it("dispose 反注册全部工具", async () => {
    const { native, unregistered } = setup()
    await native.registerAll()
    native.dispose()
    expect(unregistered).toEqual([`${TOOL_PREFIX}send`, `${TOOL_PREFIX}boom`])
    expect(native.definitions).toHaveLength(0)
  })

  it("toolDefinition：缺 description/schema 时给出可用兜底", () => {
    const definition = toolDefinition({ name: "roster" }, async () => "x")
    expect(definition["description"]).toContain("roster")
    expect(definition["parameters"]).toEqual({ type: "object", properties: {} })
  })
})
