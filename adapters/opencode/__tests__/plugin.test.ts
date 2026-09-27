/**
 * Task 2 单测：以 mock 插件 API（`PluginInput.client`）+ mock `fetch` 驱动插件，
 * 断言 Hub 调用序列与 payload（根注册→token 落盘、重连认领、子注册父关联、
 * busy/idle、wake→注入→result 闭环、401/5xx 重试与放弃、注入失败→refused）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createPluginHandle, type PluginDeps, type PluginHandle } from "../plugin"
import type { Hooks, OpencodeClient, OpencodeEvent, PluginInput } from "../types"
import { isRecord } from "../util"

// ── mock fetch ──────────────────────────────────────────────────────

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly json: unknown
}

interface InternalCall {
  readonly path: string
  readonly body: unknown
}

interface FetchOverrides {
  /** 覆盖 MCP `tools/call`（register）响应；`index` = 第几次 register（从 0 起）。 */
  readonly toolsCall?: (args: unknown, index: number) => Response
  /** 覆盖 `/internal/*`；返回 `undefined` 走默认成功响应。抛错 = 模拟网络故障。 */
  readonly internal?: (path: string, body: unknown, index: number) => Response | undefined
}

interface FetchKit {
  readonly fetch: typeof fetch
  readonly calls: Call[]
  readonly toolCalls: unknown[]
  readonly internalCalls: InternalCall[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sseResponse(payload: unknown, sessionId?: string): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }) },
  })
}

function registerText(agentId: string, joinToken?: string): string {
  return JSON.stringify({
    agent: { id: agentId },
    unread: 0,
    ...(joinToken === undefined ? {} : { join_token: joinToken }),
  })
}

function toolReply(text: string, isError = false): Response {
  return sseResponse({
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  })
}

function buildFetch(overrides: FetchOverrides = {}): FetchKit {
  const calls: Call[] = []
  const toolCalls: unknown[] = []
  const internalCalls: InternalCall[] = []
  let toolIndex = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    const json: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url, method: init?.method ?? "GET", headers, json })
    const path = new URL(url).pathname
    if (path === "/mcp") {
      const method = isRecord(json) ? json["method"] : undefined
      if (method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: {} }, "sess-1")
      if (method === "notifications/initialized") return new Response("", { status: 202 })
      if (method === "tools/call") {
        const params = isRecord(json) ? json["params"] : undefined
        const args = isRecord(params) ? params["arguments"] : undefined
        toolCalls.push(args)
        const index = toolIndex
        toolIndex += 1
        return overrides.toolsCall?.(args, index) ?? toolReply(registerText(`agent-${index + 1}`, "jt-1"))
      }
      return jsonResponse({}, 400)
    }
    const index = internalCalls.length
    internalCalls.push({ path, body: json })
    const custom = overrides.internal?.(path, json, index)
    if (custom !== undefined) return custom
    if (path === "/internal/wake") return jsonResponse({ messages: [], receipts: [] })
    return jsonResponse({ ok: true })
  }
  return { fetch: fetchImpl, calls, toolCalls, internalCalls }
}

// ── mock 插件 API ───────────────────────────────────────────────────

class RecordingClient {
  readonly texts: string[] = []
  failInjections = 0
  readonly client: OpencodeClient = {
    session: {
      promptAsync: async (input) => {
        this.texts.push(input.body.parts[0]?.text ?? "")
        if (this.failInjections > 0) {
          this.failInjections -= 1
          throw new Error("inject boom")
        }
      },
    },
  }
}

interface Harness {
  readonly handle: PluginHandle
  readonly kit: FetchKit
  readonly client: RecordingClient
  readonly hooks: Promise<Hooks>
  readonly logs: string[]
}

function setup(options: {
  readonly home: string
  readonly overrides?: FetchOverrides
  readonly deps?: Partial<PluginDeps>
}): Harness {
  const kit = buildFetch(options.overrides ?? {})
  const logs: string[] = []
  const deps: PluginDeps = {
    env: { AGENTCHAT_HOME: options.home, HUB_TOKEN: "hub-token", AGENTCHAT_URL: "http://hub.test" },
    fetch: kit.fetch,
    log: (message) => logs.push(message),
    sleep: async () => undefined,
    random: () => 0,
    ...options.deps,
  }
  const handle = createPluginHandle(deps)
  const client = new RecordingClient()
  const input: PluginInput = { client: client.client, directory: "/tmp", worktree: "/tmp" }
  return { handle, kit, client, hooks: handle.plugin(input), logs }
}

async function emit(harness: Harness, ...events: OpencodeEvent[]): Promise<void> {
  const hooks = await harness.hooks
  for (const event of events) await hooks.event?.({ event })
  await harness.handle.flush()
}

// ── 事件构造 ────────────────────────────────────────────────────────

const rootCreated = (id = "root-sess"): OpencodeEvent => ({
  type: "session.created",
  properties: { info: { id } },
})
const childCreated = (id: string, parentID: string): OpencodeEvent => ({
  type: "session.created",
  properties: { info: { id, parentID } },
})
const sessionStatus = (sessionID: string, type: "idle" | "busy" | "retry"): OpencodeEvent => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
})
const sessionIdle = (sessionID: string): OpencodeEvent => ({
  type: "session.idle",
  properties: { sessionID },
})

// ── 测试脚手架 ──────────────────────────────────────────────────────

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-oc-"))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function stateCalls(kit: FetchKit): unknown[] {
  return kit.internalCalls.filter((call) => call.path === "/internal/state").map((call) => call.body)
}

function resultItems(kit: FetchKit): unknown {
  const call = kit.internalCalls.find((entry) => entry.path === "/internal/result")
  if (call === undefined) return undefined
  const body = call.body
  return isRecord(body) ? body["items"] : undefined
}

// ── 根注册与 token ──────────────────────────────────────────────────

describe("根会话注册与 join_token 落盘", () => {
  it("first root session registers without join_token and writes the returned token", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated())
    expect(harness.kit.toolCalls).toEqual([{ vendor: "opencode", purpose: "coding-agent" }])
    expect(readFileSync(join(home, "agents", "opencode.token"), "utf8")).toBe("jt-1")
    expect(harness.kit.calls.some((call) => call.headers["authorization"] === "Bearer hub-token")).toBe(true)
  })

  it("reconnect with an existing token claims via join_token without overwriting on omitted response", async () => {
    const home = tempHome()
    const path = join(home, "agents", "opencode.token")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "old-token")
    const harness = setup({
      home,
      overrides: { toolsCall: () => toolReply(registerText("agent-7")) },
    })
    await emit(harness, rootCreated())
    expect(harness.kit.toolCalls).toEqual([
      { vendor: "opencode", purpose: "coding-agent", join_token: "old-token" },
    ])
    expect(readFileSync(path, "utf8")).toBe("old-token")
  })

  it("reports a token write failure but still completes registration", async () => {
    const home = join(tempHome(), "not-a-dir")
    writeFileSync(home, "file")
    const harness = setup({ home })
    await emit(harness, rootCreated())
    expect(harness.kit.toolCalls).toHaveLength(1)
    expect(harness.logs.some((line) => line.includes("token write failed"))).toBe(true)
  })

  it("logs a registration failure without throwing", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      overrides: {
        toolsCall: () => toolReply("RegistrationError: unknown join_token [invalid_join_token]", true),
      },
    })
    await emit(harness, rootCreated())
    expect(harness.logs.some((line) => line.includes("root register failed"))).toBe(true)
    expect(harness.kit.internalCalls).toHaveLength(0)
  })
})

// ── 子注册 ──────────────────────────────────────────────────────────

describe("子会话注册（父关联）", () => {
  it("registers a child with parent_ref=root agent id and task_ref=session id", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), childCreated("child-1", "root-sess"))
    expect(harness.kit.toolCalls[1]).toEqual({
      vendor: "opencode",
      parent_ref: "agent-1",
      task_ref: "child-1",
    })
  })

  it("falls back to the current root when the parent session is unmapped", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), childCreated("child-2", "unknown-sess"))
    expect(harness.kit.toolCalls[1]).toEqual({
      vendor: "opencode",
      parent_ref: "agent-1",
      task_ref: "child-2",
    })
  })
})

// ── 状态上报 ────────────────────────────────────────────────────────

describe("状态上报", () => {
  it("reports busy then idle for the root session", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionStatus("root-sess", "busy"), sessionStatus("root-sess", "idle"))
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-1", state: "busy" },
      { agentId: "agent-1", state: "idle" },
    ])
  })

  it("deduplicates repeated same-state reports", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(
      harness,
      rootCreated(),
      sessionStatus("root-sess", "busy"),
      sessionStatus("root-sess", "busy"),
    )
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-1", state: "busy" }])
  })

  it("reports offline on root deletion but not on child deletion", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(
      harness,
      rootCreated(),
      childCreated("child-1", "root-sess"),
      { type: "session.deleted", properties: { info: { id: "child-1", parentID: "root-sess" } } },
      { type: "session.deleted", properties: { info: { id: "root-sess" } } },
    )
    const offline = stateCalls(harness.kit).filter(
      (body) => isRecord(body) && body["state"] === "offline",
    )
    expect(offline).toEqual([{ agentId: "agent-1", state: "offline" }])
  })
})

// ── 唤醒 → 注入 → result ────────────────────────────────────────────

describe("session.idle 唤醒闭环", () => {
  const wake = (messages: unknown[]): FetchOverrides => ({
    internal: (path) => (path === "/internal/wake" ? jsonResponse({ messages, receipts: [] }) : undefined),
  })
  const twoMessages = [
    { id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hello" },
    { id: "m2", fromAgentId: "peer", conversationId: "c1", body: "world" },
  ]

  it("wakes, injects every message, and reports delivered", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wake(twoMessages) })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(2)
    expect(harness.client.texts[0]).toContain("hello")
    expect(harness.client.texts[0]).toContain("peer")
    expect(harness.kit.internalCalls.find((call) => call.path === "/internal/wake")?.body).toEqual({
      agentId: "agent-1",
    })
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-1", state: "idle" }])
    expect(resultItems(harness.kit)).toEqual([
      { messageId: "m1", result: "delivered" },
      { messageId: "m2", result: "delivered" },
    ])
  })

  it("marks refused when injection throws and continues", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wake(twoMessages) })
    harness.client.failInjections = 1
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(resultItems(harness.kit)).toEqual([
      { messageId: "m1", result: "refused" },
      { messageId: "m2", result: "delivered" },
    ])
    expect(harness.logs.some((line) => line.includes("inject failed"))).toBe(true)
  })

  it("skips result reporting when the wake has no messages", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/result")).toBe(false)
  })
})

// ── 重试与确定性错误 ────────────────────────────────────────────────

describe("网络健壮性", () => {
  it("retries 5xx with exponential backoff until success", async () => {
    const home = tempHome()
    const delays: number[] = []
    let attempts = 0
    const harness = setup({
      home,
      deps: { sleep: async (ms) => void delays.push(ms) },
      overrides: {
        internal: (path) => {
          if (path !== "/internal/state") return undefined
          attempts += 1
          return attempts <= 2 ? jsonResponse({ ok: false }, 503) : jsonResponse({ ok: true })
        },
      },
    })
    await emit(harness, rootCreated(), sessionStatus("root-sess", "busy"))
    expect(attempts).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  it("does not retry 401 and degrades without throwing", async () => {
    const home = tempHome()
    let attempts = 0
    const harness = setup({
      home,
      overrides: {
        internal: (path) => {
          if (path !== "/internal/state") return undefined
          attempts += 1
          return jsonResponse({ ok: false, error: "unauthorized" }, 401)
        },
      },
    })
    await emit(harness, rootCreated(), sessionStatus("root-sess", "busy"))
    expect(attempts).toBe(1)
    expect(harness.logs.some((line) => line.includes("state busy failed"))).toBe(true)
  })

  it("retries network errors up to the cap, then logs the wake failure", async () => {
    const home = tempHome()
    let attempts = 0
    const harness = setup({
      home,
      overrides: {
        internal: (path) => {
          if (path !== "/internal/wake") return undefined
          attempts += 1
          throw new Error("network down")
        },
      },
    })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(attempts).toBe(4)
    expect(harness.logs.some((line) => line.includes("wake failed"))).toBe(true)
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/result")).toBe(false)
  })
})
