/**
 * DSH MCP stdio 桥（`adapters/dsh/mcp-bridge.mjs`）单测。
 *
 * 隔离纪律：**绝不 spawn 子进程**（沙箱禁止带管道的 stdio）且**绝不触网**——`fetch` 一律本地假实现，
 * 输入/输出是内存假流，`AGENTCHAT_HOME` 一律临时目录。覆盖：换行帧解析（跨 chunk / CRLF / 空行 /
 * 超长丢弃）、initialize 握手与会话 id 回带、token 双来源（env 优先 → `<home>/hub_token`）、
 * `x-agent-id` 懒解析 + 只成功时缓存、tools/list（裸 JSON）与 tools/call（SSE）代理、
 * `x-agentchat-session` 入参剥离 + 请求头转发、404 session_not_found 自愈重试、401/500/连不上/超时
 * → JSON-RPC error 且桥保持存活、非法 JSON 行忽略、未知方法 -32601、未知通知不回响应、
 * 以及「诊断只落文件、stdout 恒为 JSON-RPC 帧」。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBridge, createLineFramer } from "../mcp-bridge.mjs"

// ── 隔离与假件（与 lib.test.ts 同风格：假 fetch + 临时 home）─────────────────────

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-dsh-bridge-"))
  homes.push(home)
  return home
}

/** 预置 `<home>/agents/*` 文件（`dsh.id` = 实例容器 id，`dsh.current` = 当前顶层会话节点提示）。 */
function seedAgents(home: string, files: Record<string, string>): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(home, "agents", name), value)
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

type HubCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
type Reply = { status: number; body: string; sessionId?: string | undefined; contentType?: string | undefined; error?: Error | undefined }

/** 假响应：只实现桥实际用到的 `status/ok/text/headers.get`；`error` 有值 = 模拟网络层异常。 */
function responseLike(reply: Reply): Response {
  // `sessionId` 显式给 `undefined` = **没有**该响应头（真实 Hub 只有 initialize 才发它）。
  const headers = new Map<string, string>(reply.sessionId == null ? [] : [["mcp-session-id", reply.sessionId]])
  if (reply.contentType !== undefined) headers.set("content-type", reply.contentType)
  const body = { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => reply.body }
  return { ...body, headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null } } as unknown as Response
}

const sseAll = (events: unknown[], sessionId?: string): Reply => ({ status: 200, contentType: "text/event-stream", sessionId, body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") })
const sse = (payload: unknown, sessionId?: string): Reply => sseAll([payload], sessionId)
const json = (payload: unknown, sessionId?: string): Reply => ({ status: 200, contentType: "application/json", sessionId, body: JSON.stringify(payload) })
const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result })
const initResult = (id: unknown) => rpc(id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "agentchat-hub", version: "0.1.0" } })
const initFrame = (id: number) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } } })

/** 默认 Hub 假实现：initialize 发会话 id、通知 202、tools/* 正常回包（形状与真实 Hub 一致）。 */
function defaultHub(call: HubCall): Reply {
  const id = call.body["id"]
  const method = call.body["method"]
  if (method === "initialize") return sse(initResult(id), "sess-1")
  if (method === "notifications/initialized") return { status: 202, body: "" }
  if (method === "tools/list") return sse(rpc(id, { tools: [{ name: "register" }] }))
  if (method === "tools/call") return sse(rpc(id, { content: [{ type: "text", text: "ok" }] }))
  return json(rpc(id, {}))
}

/** 内存假 stdin：`on`/`emit` 足够覆盖桥的流接线。 */
function createFakeInput() {
  const handlers = new Map<string, Array<(chunk: string | Uint8Array) => void>>()
  const on = (event: string, listener: (chunk: string | Uint8Array) => void) => handlers.set(event, [...(handlers.get(event) ?? []), listener])
  const emit = (event: string, chunk: string | Uint8Array = "") => (handlers.get(event) ?? []).forEach((listener) => listener(chunk))
  return { on, emit }
}

/** 内存桥 harness：注入假 stdin/stdout/fetch/env/log；`send` 喂一行帧并等串行链排空。 */
function makeHarness(options: { env?: Record<string, string | undefined>; handle?: (call: HubCall) => Reply } = {}) {
  const home = options.env?.["AGENTCHAT_HOME"] ?? tempHome()
  // 默认给 env token（真实场景 = `HUB_TOKEN`；被清洗的进程走 `<home>/hub_token`，见 token 判序用例）。
  const env = { AGENTCHAT_HOME: home, AGENTCHAT_URL: "http://hub.test", HUB_TOKEN: "test-token", ...(options.env ?? {}) }
  const calls: HubCall[] = []
  const logs: string[] = []
  const output: string[] = []
  const input = createFakeInput()
  const fetchImpl = (async (target: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const call: HubCall = { url: String(target), headers: (init.headers ?? {}) as Record<string, string>, body }
    calls.push(call)
    const reply = (options.handle ?? defaultHub)(call)
    if (reply.error !== undefined) throw reply.error
    return responseLike(reply)
  }) as unknown as typeof fetch
  const bridge = createBridge({
    env,
    input,
    output: { write: (text: string) => { output.push(text); return true } },
    fetch: fetchImpl,
    log: (message: string) => logs.push(message),
    timeoutMs: 1000,
  })
  return {
    calls,
    logs,
    bridge,
    async send(frame: unknown) {
      input.emit("data", `${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`)
      await bridge.drain()
    },
    frames: () => output.join("").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

const errorOf = (frame: Record<string, unknown> | undefined): Record<string, unknown> => (frame?.["error"] ?? {}) as Record<string, unknown>
const messageOf = (frame: Record<string, unknown> | undefined): string => String(errorOf(frame)["message"])

// ── 行帧解析 / initialize 握手 / 身份 / token ─────────────────────────────────

describe("stdio 行帧与 initialize 握手", () => {
  it("跨 chunk 拼接、容忍 CRLF、丢弃空行；超长无换行即丢弃且不产生行", () => {
    const lines: string[] = []
    const overflows: string[] = []
    const framer = createLineFramer((line) => lines.push(line), { maxLength: 32, onOverflow: (message) => overflows.push(message) })
    framer.push('{"a":')
    framer.push('1}\r\n\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    framer.push("x".repeat(40))
    framer.push("\n")
    expect(overflows).toHaveLength(1)
    expect(lines).toHaveLength(2)
  })

  it("转发 initialize、捕获 mcp-session-id 并在后续请求回带", async () => {
    const h = makeHarness({ env: { HUB_TOKEN: "env-token" } })

    await h.send(initFrame(1))

    expect(h.calls[0]?.url).toBe("http://hub.test/mcp")
    // 精确相等 = 三个必备头齐备，且**不带**会话头 / 身份头（dsh.id 未生成 → 省略该头，绝不报错）
    expect(h.calls[0]?.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer env-token",
    })
    expect(h.frames()[0]).toEqual(initResult(1))

    await h.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })

    expect(h.calls[1]?.headers["mcp-session-id"]).toBe("sess-1")
  })

  it("token 判序：HUB_TOKEN 非空优先 → <home>/hub_token（trim）→ 两处皆无则回错且不发请求", async () => {
    const home = tempHome()
    writeFileSync(join(home, "hub_token"), "file-token\n")

    const fromFile = makeHarness({ env: { AGENTCHAT_HOME: home, HUB_TOKEN: undefined } })
    await fromFile.send(initFrame(1))
    expect(fromFile.calls[0]?.headers["authorization"]).toBe("Bearer file-token")

    const fromEnv = makeHarness({ env: { AGENTCHAT_HOME: home, HUB_TOKEN: "env-token" } })
    await fromEnv.send(initFrame(1))
    expect(fromEnv.calls[0]?.headers["authorization"]).toBe("Bearer env-token")

    const none = makeHarness({ env: { HUB_TOKEN: undefined } })
    await none.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(none.calls).toHaveLength(0)
    expect(none.frames()[0]).toMatchObject({ id: 1, error: { code: -32000 } })
    expect(messageOf(none.frames()[0])).toContain("hub_token")
  })

  it("x-agent-id：dsh.id 由插件注册后写出 → 懒解析并只成功时缓存", async () => {
    const home = tempHome()
    const h = makeHarness({ env: { AGENTCHAT_HOME: home } })

    await h.send(initFrame(1))
    expect(h.calls[0]?.headers["x-agent-id"]).toBeUndefined()

    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(join(home, "agents", "dsh.id"), "agent-9\n")
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(h.calls[1]?.headers["x-agent-id"]).toBe("agent-9")

    rmSync(join(home, "agents", "dsh.id"))
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    expect(h.calls[2]?.headers["x-agent-id"]).toBe("agent-9")
  })
})

// ── 出站身份（生产时序）/ 身份变化重建会话 / 400 自愈 ────────────────────────

/** 只把 initialize 之外的请求喂给 `handle`，initialize 一律发新会话 id（便于数初始化次数）。 */
function initCountingHub(onCall: (call: HubCall) => Reply | undefined) {
  let inits = 0
  return {
    count: () => inits,
    handle: (call: HubCall): Reply => {
      if (call.body["method"] === "initialize") {
        inits += 1
        return sse(initResult(call.body["id"]), `sess-${inits}`)
      }
      if (call.body["method"] === "notifications/initialized") return { status: 202, body: "" }
      return onCall(call) ?? defaultHub(call)
    },
  }
}

describe("出站身份：逐请求解析 + 身份变化重建 Hub 会话", () => {
  it("真实生产时序：桥建会话时 dsh.id 尚未生成 → 文件出现后下一次请求重新 initialize 并带上 x-agent-id", async () => {
    const home = tempHome()
    // 用「每次 initialize 发新会话 id」的假 Hub：只有它能显式暴露「重建了会话」这件事。
    const hub = initCountingHub(() => undefined)
    const h = makeHarness({ env: { AGENTCHAT_HOME: home }, handle: hub.handle })

    // ① 宿主开机后的第一次工具调用（此刻插件还没注册，两个身份文件都不存在）：桥自建会话，
    //    Hub 会话因此没有身份 —— 除 register 外的工具都会被 Hub 拒（identity_required）。
    await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(h.calls.map((call) => call.body["method"])).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
    expect(h.calls[0]?.headers["x-agent-id"]).toBeUndefined()
    expect(h.calls[2]?.headers["x-agent-id"]).toBeUndefined()
    expect(h.calls[2]?.headers["mcp-session-id"]).toBe("sess-1")

    // ② 身份仍未出现 → 沿用同一 Hub 会话（`undefined` 未变化，不重建、不触盘）。
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(h.calls).toHaveLength(4)
    expect(h.calls[3]?.headers["x-agent-id"]).toBeUndefined()
    expect(h.calls[3]?.headers["mcp-session-id"]).toBe("sess-1")

    // ③ 插件注册成功后写出 dsh.id → 身份 undefined → 已定义，必须重建会话（Hub 只在 initialize
    //    读该头，既有会话永不重读），否则后续工具调用会被 Hub 以 identity_required 拒绝。
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(join(home, "agents", "dsh.id"), "agent-9\n")
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })

    expect(h.calls.map((call) => call.body["method"])).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
    const fresh = h.calls[4]
    expect(fresh?.headers["x-agent-id"]).toBe("agent-9")
    expect(fresh?.headers["mcp-session-id"]).toBeUndefined()
    expect(h.calls[5]?.headers["x-agent-id"]).toBe("agent-9")
    expect(h.calls[6]?.headers["x-agent-id"]).toBe("agent-9")
    expect(h.calls[6]?.headers["mcp-session-id"]).toBe("sess-2")
    expect(h.frames()).toHaveLength(3)
    expect(h.frames()[2]).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "register" }] } })
  })

  it("dsh.current 提示优先于 dsh.id；提示变化触发重建，提示不变不重建", async () => {
    const home = tempHome()
    seedAgents(home, { "dsh.id": "container-1\n" })
    const hub = initCountingHub(() => undefined)
    const h = makeHarness({ env: { AGENTCHAT_HOME: home }, handle: hub.handle })

    // 首次调用：提示文件不存在 → 回落到实例容器 id（并建立 Hub 会话 sess-1）。
    await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(h.calls[0]?.headers["x-agent-id"]).toBe("container-1")
    expect(hub.count()).toBe(1)

    // 值未变（文件被重写为同一 id）→ **不**重建：沿用会话 sess-1，且不再多发 initialize。
    writeFileSync(join(home, "agents", "dsh.current"), "container-1\n")
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(hub.count()).toBe(1)
    expect(h.calls.at(-1)?.headers["x-agent-id"]).toBe("container-1")
    expect(h.calls.at(-1)?.headers["mcp-session-id"]).toBe("sess-1")

    // 提示指向另一个节点 → 必须重建会话（否则既有 Hub 会话仍是容器身份，对端回复会被拒）。
    writeFileSync(join(home, "agents", "dsh.current"), "session-1\n")
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    expect(hub.count()).toBe(2)
    expect(h.calls.at(-1)?.headers["x-agent-id"]).toBe("session-1")
    expect(h.calls.at(-1)?.headers["mcp-session-id"]).toBe("sess-2")

    // 提示被插件删除（≥2 个顶层会话）→ 回落容器，同样重建（身份变了）。
    rmSync(join(home, "agents", "dsh.current"))
    await h.send({ jsonrpc: "2.0", id: 4, method: "tools/list" })
    expect(hub.count()).toBe(3)
    expect(h.calls.at(-1)?.headers["x-agent-id"]).toBe("container-1")
    expect(h.frames()).toHaveLength(4)
  })

  it("400 agent_not_found：清缓存身份与会话，重读文件后只重试一次", async () => {
    const home = tempHome()
    seedAgents(home, { "dsh.id": "stale-1\n" })
    let first = true
    // initialize 由 initCountingHub 统一应答（新会话 id）；这里只处理 tools/list。
    const hub = initCountingHub(() => {
      if (first) {
        first = false
        // Hub 数据重置后本地 id 陈旧：第一次 tools/list 被拒；插件重注册后写出新 id。
        writeFileSync(join(home, "agents", "dsh.id"), "fresh-1\n")
        return { status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "agent_not_found" }) }
      }
      return undefined
    })
    const h = makeHarness({ env: { AGENTCHAT_HOME: home }, handle: hub.handle })

    await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })

    expect(h.calls.map((call) => call.body["method"])).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
    expect(h.calls[0]?.headers["x-agent-id"]).toBe("stale-1")
    // 重试前先重建会话（Hub 只在 initialize 认身份），因此重试携带的是新 id。
    expect(h.calls[3]?.headers["x-agent-id"]).toBe("fresh-1")
    expect(h.calls[3]?.headers["mcp-session-id"]).toBeUndefined()
    expect(h.calls[5]?.headers["x-agent-id"]).toBe("fresh-1")
    expect(h.calls[5]?.headers["mcp-session-id"]).toBe("sess-2")
    expect(h.frames()).toHaveLength(1)
    expect(h.frames()[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "register" }] } })
  })

  it("400 agent_not_found 持续存在 → 只重试一次（绝不循环），请求回 JSON-RPC error", async () => {
    const home = tempHome()
    seedAgents(home, { "dsh.id": "stale-1\n" })
    const hub = initCountingHub((call) =>
      call.body["method"] === "tools/list"
        ? { status: 400, contentType: "application/json", body: JSON.stringify({ error: "agent_not_found" }) }
        : undefined,
    )
    const h = makeHarness({ env: { AGENTCHAT_HOME: home }, handle: hub.handle })

    await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })

    expect(h.calls.filter((call) => call.body["method"] === "tools/list")).toHaveLength(2)
    expect(h.calls.filter((call) => call.body["method"] === "initialize")).toHaveLength(2)
    expect(h.frames()).toHaveLength(1)
    expect(errorOf(h.frames()[0])["code"]).toBe(-32000)
    expect(messageOf(h.frames()[0])).toContain("agent_not_found")
  })
})

// ── 代理转发 / 失败路径：一律回 JSON-RPC error 且桥保持存活 ─────────────────────

describe("MCP 代理、失败路径与畸形输入", () => {
  it("tools/list（响应前夹带 Hub 下发的通知）与 tools/call（SSE）都原样转发", async () => {
    const h = makeHarness({
      handle: (call) =>
        call.body["method"] !== "tools/list"
          ? defaultHub(call)
          : sseAll([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, rpc(call.body["id"], { tools: [{ name: "send" }] })]),
    })

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: "list-1", method: "tools/list", params: { cursor: "c1" } })
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send", arguments: { body: "hi" } } })

    expect(h.calls[1]?.body).toEqual({ jsonrpc: "2.0", id: "list-1", method: "tools/list", params: { cursor: "c1" } })
    expect(h.frames()[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    expect(h.frames()[2]).toEqual({ jsonrpc: "2.0", id: "list-1", result: { tools: [{ name: "send" }] } })
    expect(h.frames()[3]).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } })
  })

  it("x-agentchat-session：从入参剥离（Hub 绝不看到）并转请求头；无该键则不带该头", async () => {
    const h = makeHarness()

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send", arguments: { "x-agentchat-session": "sess-abc", body: "hi" } } })

    expect((h.calls[1]?.body["params"] as Record<string, unknown>)["arguments"]).toEqual({ body: "hi" })
    expect(h.calls[1]?.headers["x-agentchat-session"]).toBe("sess-abc")

    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: { body: "yo" } } })
    expect(h.calls[2]?.headers["x-agentchat-session"]).toBeUndefined()
  })

  it("404 session_not_found：重新 initialize（+initialized）后重试同一请求一次", async () => {
    let inits = 0
    const h = makeHarness({
      handle: (call) => {
        if (call.body["method"] === "initialize") return sse(initResult(call.body["id"]), `sess-${(inits += 1)}`)
        if (call.body["method"] === "notifications/initialized") return { status: 202, body: "" }
        if (inits === 1) return { status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "session_not_found" }) }
        return sse(rpc(call.body["id"], { tools: [] }))
      },
    })

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })

    expect(h.calls.map((call) => call.body["method"])).toEqual(["initialize", "tools/list", "initialize", "notifications/initialized", "tools/list"])
    expect(h.calls.at(-1)?.headers["mcp-session-id"]).toBe("sess-2")
    expect(h.frames()[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } })
  })

  it.each([401, 500])("Hub %i → JSON-RPC error（-32000），桥继续服务后续请求", async (status) => {
    let fail = true
    const h = makeHarness({
      handle: (call) => {
        if (call.body["method"] === "initialize") return sse(initResult(call.body["id"]), "sess-1")
        if (!fail) return defaultHub(call)
        fail = false
        return { status, contentType: "application/json", body: JSON.stringify({ ok: false, error: "boom" }) }
      },
    })

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })

    expect(errorOf(h.frames()[1])["code"]).toBe(-32000)
    expect(messageOf(h.frames()[1])).toContain(String(status))
    expect(h.frames()[2]).toMatchObject({ id: 3, result: { tools: [{ name: "register" }] } })
  })

  it("连不上 Hub / 请求超时 → JSON-RPC error，桥保持存活", async () => {
    const failures: Error[] = [new Error("connect ECONNREFUSED 127.0.0.1:4646"), Object.assign(new Error("aborted"), { name: "AbortError" })]
    let index = 0
    const h = makeHarness({
      handle: (call) => {
        if (call.body["method"] === "initialize") return sse(initResult(call.body["id"]), "sess-1")
        const failure = failures[index]
        index += 1
        return failure === undefined ? defaultHub(call) : { status: 200, body: "", error: failure }
      },
    })

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    await h.send({ jsonrpc: "2.0", id: 4, method: "tools/list" })

    expect(messageOf(h.frames()[1])).toContain("无法连接 AgentChat Hub")
    expect(messageOf(h.frames()[2])).toContain("请求 Hub 超时")
    // 先断言帧**存在**（否则 `[3]?.["error"]` 会在帧缺失时静默通过）；第 4 次调用成功 → 帧 3 是结果帧。
    expect(h.frames()).toHaveLength(4)
    expect(h.frames()[3]).toEqual({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "register" }] } })
  })

  it("非法 JSON 行忽略、未知方法 -32601、未知通知不回响应、initialized 照常转发", async () => {
    const h = makeHarness()

    await h.send("{not json")
    expect(h.frames()).toHaveLength(0)
    expect(h.logs.some((line) => line.includes("忽略非法 JSON"))).toBe(true)

    await h.send(initFrame(1))
    await h.send({ jsonrpc: "2.0", id: 2, method: "tools/delete" })
    expect(errorOf(h.frames()[1])["code"]).toBe(-32601)

    await h.send({ jsonrpc: "2.0", method: "notifications/unknown" })
    await h.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    expect(h.frames()).toHaveLength(2) // 通知绝不回响应
    expect(h.calls.map((call) => call.body["method"])).toEqual(["initialize", "notifications/initialized"])
  })

  it("诊断只落 <home>/logs/dsh-adapter.log（scope mcp-bridge），stdout 恒为 JSON-RPC 帧", async () => {
    const home = tempHome()
    const output: string[] = []
    const input = createFakeInput()
    // 三重观察 stdout 纯度：注入写端（正常通道）+ `process.stdout.write`（stray 写）+ console.*
    // （误用 console.log 也会污染 MCP 帧流）。只 spy、不改实现，故日志仍照真实路径写盘。
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const bridge = createBridge({
      env: { AGENTCHAT_HOME: home, AGENTCHAT_URL: "http://hub.test", HUB_TOKEN: "test-token" },
      input,
      output: { write: (text: string) => { output.push(text); return true } },
      fetch: (async () => { throw new Error("connect ECONNREFUSED") }) as unknown as typeof fetch,
      timeoutMs: 1000,
    })

    input.emit("data", "{not json\n")
    input.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
    await bridge.drain()

    const lines = output.join("").split("\n").filter((line) => line !== "")
    expect(lines).toHaveLength(1) // 诊断绝不出现在 stdout
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32000 } })
    expect(lines.every((line) => line.startsWith("{"))).toBe(true)
    expect(stdout).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()

    const log = readFileSync(join(home, "logs", "dsh-adapter.log"), "utf8")
    expect(log).toContain("[mcp-bridge]")
    expect(log).toContain("忽略非法 JSON")
    expect(log).toContain("无法连接 AgentChat Hub")
    expect(consoleError).not.toHaveBeenCalled() // 默认落文件；`AGENTCHAT_LOG=console` 的 stderr 回退见 lib.test.ts
  })
})
