/**
 * Task 2 单测：以 mock 插件 API（`PluginInput.client`）+ mock `fetch` 驱动插件，
 * 断言 Hub 调用序列与 payload（根注册→token 落盘、重连认领、子注册父关联、
 * busy/idle、wake→注入→result 闭环、401/5xx 重试与放弃、注入失败→refused）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname as osHostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPluginHandle, type PluginDeps, type PluginHandle } from "../plugin"
import type { Hooks, OpencodeClient, OpencodeEvent, OpencodeSession, PluginInput, SessionListQuery } from "../types"
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
//
// **忠实还原 `@opencode-ai/sdk@1.18.32` 的 `this` 依赖**（核心回归锁）：
// 真实生成类 `_HeyApiClient` 持有 `_client`，`Session.get`/`list`/`promptAsync` 的方法体读
// `this._client`（见 sdk `dist/gen/sdk.gen.js`）。因此把 `session` 做成**类实例**、经 `this._client`
// 分派；`const g = mock.session.get` 这类**解绑**会 `this===undefined` → 抛
// `Cannot read properties of undefined (reading '_client')`，与真机日志同源。
// 旧 mock 用对象字面量（方法不依赖 `this`），解绑无害，故从未抓到该根因（第三次 mock 失真）。

/** 忠实镜像 `_HeyApiClient`：持有 `_client`，方法体一律经 `this._client` 取值。 */
class HeyApiClientLike {
  protected readonly _client: RecordingBackend
  constructor(client: RecordingBackend) {
    this._client = client
  }
}

/** 忠实镜像 `Session`：三个方法均为**非 async**（同步访问 `this._client`），解绑即同步抛错。 */
class SessionLike extends HeyApiClientLike {
  get(input: { readonly path: { readonly id: string } }): Promise<unknown> {
    return this._client.fetchSession(input)
  }
  list(input?: { readonly query?: SessionListQuery }): Promise<unknown> {
    return this._client.fetchList(input)
  }
  promptAsync(input: {
    readonly path: { readonly id: string }
    readonly body: { readonly parts: readonly { readonly type: "text"; readonly text: string }[] }
  }): Promise<unknown> {
    return this._client.inject(input)
  }
}

/** 会话数据的后端（mock 的真实逻辑）；`SessionLike` 经 `this._client` 调它。 */
class RecordingBackend {
  readonly texts: string[] = []
  failInjections = 0
  /** 注入失败时抛/包的错误体；未设置则用 `new Error("inject boom")`。可设为普通对象模拟实测失败体。 */
  injectionError: unknown
  /** A/B 收养用：`sessionID → Session`（预置未映射会话）。 */
  readonly sessions = new Map<string, OpencodeSession>()
  /** `session.list` 返回体（默认空）。 */
  listResult: readonly OpencodeSession[] = []
  /** 非空则 `session.list` 返回该原始值（模拟非数组形状）。 */
  listRaw: unknown
  /**
   * 非空则 `session.get` 报错（模拟 404/不可用）：`bare` 抛错，`fields` 返回包装 `error`。
   * 类型放宽为 `unknown` 以覆盖**实测的真实失败体**（普通对象，非 `Error`）。
   */
  getError: unknown
  /** 非空则 `session.list` 报错（模拟老宿主）：`bare` 抛错，`fields` 返回包装 `error`。 */
  listError: unknown
  /**
   * 返回形状：`"bare"` = 裸值/抛错（旧行为，默认）；`"fields"` = SDK 包装
   * （宿主 `responseStyle!=="data"` / 不抛错时）。
   */
  shape: "bare" | "fields" = "bare"
  readonly getCalls: string[] = []
  readonly listCalls: Array<{ readonly query?: SessionListQuery } | undefined> = []

  /** 由 `get` 分派（经 `SessionLike.get` → `this._client.fetchSession`）。 */
  async fetchSession(input: { readonly path: { readonly id: string } }): Promise<unknown> {
    this.getCalls.push(input.path.id)
    if (this.getError !== undefined) {
      if (this.shape === "fields") return this.fields(undefined, this.getError)
      throw this.getError
    }
    const session = this.sessions.get(input.path.id)
    if (session === undefined) {
      const error = new Error(`session not found: ${input.path.id}`)
      if (this.shape === "fields") return this.fields(undefined, error)
      throw error
    }
    return this.shape === "fields" ? this.fields(session, undefined) : session
  }

  /** 由 `list` 分派（经 `SessionLike.list` → `this._client.fetchList`）。 */
  async fetchList(input?: { readonly query?: SessionListQuery }): Promise<unknown> {
    this.listCalls.push(input)
    if (this.listError !== undefined) {
      if (this.shape === "fields") return this.fields(undefined, this.listError)
      throw this.listError
    }
    const value = this.listRaw === undefined ? this.listResult : this.listRaw
    return this.shape === "fields" ? this.fields(value, undefined) : value
  }

  /** 由 `promptAsync` 分派（经 `SessionLike.promptAsync` → `this._client.inject`）。 */
  async inject(input: {
    readonly path: { readonly id: string }
    readonly body: { readonly parts: readonly { readonly type: "text"; readonly text: string }[] }
  }): Promise<unknown> {
    this.texts.push(input.body.parts[0]?.text ?? "")
    if (this.failInjections > 0) {
      this.failInjections -= 1
      const error = this.injectionError === undefined ? new Error("inject boom") : this.injectionError
      if (this.shape === "fields") return this.fields(undefined, error)
      throw error
    }
    return this.shape === "fields" ? this.fields({}, undefined) : undefined
  }

  /**
   * 把结果包成 SDK `fields` 形状，**严格按实测键集**：
   * - 成功（`error === undefined`）→ `{ data, request, response }`，**无 `error` 键**；
   * - 失败（`error !== undefined`）→ `{ error, request, response }`，**无 `data` 键**。
   *
   * 旧 mock 恒含 `data` 键，与真实失败形状不符，导致「失败包装无 `data`」这一根因
   * 从未被测试覆盖（修复前本用例集仍全绿）。
   */
  private fields(data: unknown, error: unknown): unknown {
    if (error !== undefined) return { error, request: {}, response: {} }
    return { data, request: {}, response: {} }
  }
}

/** mock 的 `client`：`session` 为**类实例**（方法依赖 `this`），而非对象字面量。 */
class RecordingClient {
  readonly backend = new RecordingBackend()
  readonly client: OpencodeClient = { session: new SessionLike(this.backend) }
  /** 便于既有用例访问 mock 状态（转发到 backend）。 */
  get texts(): string[] {
    return this.backend.texts
  }
  get sessions(): Map<string, OpencodeSession> {
    return this.backend.sessions
  }
  get getCalls(): string[] {
    return this.backend.getCalls
  }
  get listCalls(): Array<{ readonly query?: SessionListQuery } | undefined> {
    return this.backend.listCalls
  }
  set failInjections(value: number) {
    this.backend.failInjections = value
  }
  get failInjections(): number {
    return this.backend.failInjections
  }
  set injectionError(value: unknown) {
    this.backend.injectionError = value
  }
  get injectionError(): unknown {
    return this.backend.injectionError
  }
  set listResult(value: readonly OpencodeSession[]) {
    this.backend.listResult = value
  }
  get listResult(): readonly OpencodeSession[] {
    return this.backend.listResult
  }
  set listRaw(value: unknown) {
    this.backend.listRaw = value
  }
  get listRaw(): unknown {
    return this.backend.listRaw
  }
  set getError(value: unknown) {
    this.backend.getError = value
  }
  get getError(): unknown {
    return this.backend.getError
  }
  set listError(value: unknown) {
    this.backend.listError = value
  }
  get listError(): unknown {
    return this.backend.listError
  }
  set shape(value: "bare" | "fields") {
    this.backend.shape = value
  }
  get shape(): "bare" | "fields" {
    return this.backend.shape
  }
}

/**
 * 解绑调用应同步抛错：V8 报 `Cannot read properties of undefined (reading '_client')`，
 * JSC/终端粘贴可能显示 `undefined is not an object (evaluating 'this._client')`，
 * 故只断言 `TypeError` + 措辞中出现 `_client`（对错误文案格式不敏感）。
 */
function expectUnboundThrows(call: () => unknown): void {
  let thrown: unknown
  try {
    call()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(TypeError)
  expect(String(thrown)).toMatch(/_client/)
}

describe("mock 忠实性（SDK this 依赖回归锁）", () => {
  it("解绑 session.get / list / promptAsync 即抛 this._client 未定义（与真机同源）", () => {
    const session = new SessionLike(new RecordingBackend())
    const get = session.get
    const list = session.list
    const promptAsync = session.promptAsync
    expectUnboundThrows(() => get({ path: { id: "s" } }))
    expectUnboundThrows(() => list({ query: {} }))
    expectUnboundThrows(() =>
      promptAsync({ path: { id: "s" }, body: { parts: [{ type: "text", text: "x" }] } }),
    )
  })

  it("经接收者调用（生产代码形态）则正常返回（get/list）", async () => {
    const backend = new RecordingBackend()
    const session = new SessionLike(backend)
    backend.sessions.set("s1", { id: "s1" })
    const got = await session.get({ path: { id: "s1" } })
    expect(got).toEqual({ id: "s1" })
    backend.listResult = [{ id: "s1" }]
    const listed = await session.list({ query: { scope: "project", roots: true, limit: 5 } })
    expect(listed).toEqual([{ id: "s1" }])
  })
})

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

const rootCreated = (id = "root-sess", title = "根会话标题"): OpencodeEvent => ({
  type: "session.created",
  properties: { info: { id, title } },
})
const childCreated = (id: string, parentID: string, title = "子会话标题"): OpencodeEvent => ({
  type: "session.created",
  properties: { info: { id, parentID, title } },
})

/**
 * 实例节点（根）注册入参期望：`opencode@<host>` 可读名（主机名缺失回退 `opencode`）。
 */
function instanceArgs(joinToken?: string): Record<string, unknown> {
  const host = osHostname()
  const name = host === undefined ? "opencode" : `opencode@${host}`
  return {
    vendor: "opencode",
    purpose: "coding-agent",
    name,
    ...(joinToken === undefined ? {} : { join_token: joinToken }),
  }
}

/** 会话节点注册入参期望：名字=标题（trim 非空）否则 `opencode:<id 前 8 位>`；`model` 可选。 */
function sessionArgs(
  session: OpencodeSession,
  parentRef: string,
  model?: string,
): Record<string, unknown> {
  const title = session.title?.trim()
  const name = title === undefined || title === "" ? `opencode:${session.id.slice(0, 8)}` : title
  return {
    vendor: "opencode",
    parent_ref: parentRef,
    task_ref: session.id,
    name,
    ...(model === undefined ? {} : { model }),
  }
}
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
    // 先认领实例节点（根），再把根会话登记为其子节点（task_ref=sessionid）。
    expect(harness.kit.toolCalls).toEqual([
      instanceArgs(),
      sessionArgs({ id: "root-sess", title: "根会话标题" }, "agent-1"),
    ])
    expect(readFileSync(join(home, "agents", "opencode.token"), "utf8")).toBe("jt-1")
    expect(harness.kit.calls.some((call) => call.headers["authorization"] === "Bearer hub-token")).toBe(true)
  })

  it("persists the node agent id for the MCP identity header", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated())
    expect(readFileSync(join(home, "agents", "opencode.id"), "utf8")).toBe("agent-1")
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
      instanceArgs("old-token"),
      sessionArgs({ id: "root-sess", title: "根会话标题" }, "agent-7"),
    ])
    expect(readFileSync(path, "utf8")).toBe("old-token")
  })

  it("reports a token write failure but still completes registration", async () => {
    const home = join(tempHome(), "not-a-dir")
    writeFileSync(home, "file")
    const harness = setup({ home })
    await emit(harness, rootCreated())
    // 实例 + 会话两次注册（token 落盘失败只记录、不中断）。
    expect(harness.kit.toolCalls).toHaveLength(2)
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

  it("recovers from a stale join_token by clearing it and re-registering as root", async () => {
    const home = tempHome()
    const path = join(home, "agents", "opencode.token")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "stale-token")
    let calls = 0
    const harness = setup({
      home,
      overrides: {
        toolsCall: () => {
          calls += 1
          return calls === 1
            ? toolReply("RegistrationError: unknown join_token [invalid_join_token]", true)
            : toolReply(registerText("agent-new", "jt-new"))
        },
      },
    })
    await emit(harness, rootCreated(), sessionStatus("root-sess", "busy"))
    expect(harness.kit.toolCalls[0]).toEqual(instanceArgs("stale-token"))
    expect(harness.kit.toolCalls[1]).toEqual(instanceArgs())
    expect(harness.kit.toolCalls[2]).toEqual(
      sessionArgs({ id: "root-sess", title: "根会话标题" }, "agent-new"),
    )
    expect(readFileSync(path, "utf8")).toBe("jt-new")
    expect(readFileSync(join(home, "agents", "opencode.id"), "utf8")).toBe("agent-new")
    expect(harness.logs.some((line) => line.includes("stale join_token rejected"))).toBe(true)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-new", state: "busy" }])
  })

  it("keeps the persisted agent id when stale-token recovery re-registration fails", async () => {
    // 回归：陈旧 token 自愈曾连带 clearToken(idPath) 删除 opencode.id，而 OpenCode 配置以
    // {file:…} 引用它 → 下次启动因文件缺失而彻底无法启动（死锁）。id 文件必须保留。
    const home = tempHome()
    const tokenPath = join(home, "agents", "opencode.token")
    const idPath = join(home, "agents", "opencode.id")
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, "stale-token")
    writeFileSync(idPath, "stale-id")
    let calls = 0
    const harness = setup({
      home,
      overrides: {
        toolsCall: () => {
          calls += 1
          return calls === 1
            ? toolReply("RegistrationError: unknown join_token [invalid_join_token]", true)
            : toolReply("RegistrationError: boom [name_taken]", true)
        },
      },
    })
    await emit(harness, rootCreated())
    expect(readFileSync(idPath, "utf8")).toBe("stale-id") // 未被删除
    expect(existsSync(tokenPath)).toBe(false) // token 仍被清除（自愈路径只清 token）
    expect(harness.logs.some((line) => line.includes("stale join_token rejected"))).toBe(true)
  })
})

// ── 传输门 token 解析（env → 磁盘 → 空）────────────────────────────

describe("传输门 token 解析（env → 磁盘 → 空）", () => {
  /** 覆盖 env（不含 HUB_TOKEN）+ 预置/不预置磁盘 hub_token。 */
  function setupWithToken(home: string, env: Record<string, string>): Harness {
    return setup({ home, deps: { env } })
  }

  it("prefers a non-empty HUB_TOKEN from the environment over the disk file", async () => {
    const home = tempHome()
    writeFileSync(join(home, "hub_token"), "disk-token")
    const harness = setupWithToken(home, {
      AGENTCHAT_HOME: home,
      HUB_TOKEN: "env-token",
      AGENTCHAT_URL: "http://hub.test",
    })
    await emit(harness, rootCreated())
    expect(harness.kit.calls.some((call) => call.headers["authorization"] === "Bearer env-token")).toBe(true)
    expect(harness.kit.calls.every((call) => call.headers["authorization"] !== "Bearer disk-token")).toBe(true)
  })

  it("falls back to <home>/hub_token (trimmed) when HUB_TOKEN is unset", async () => {
    const home = tempHome()
    writeFileSync(join(home, "hub_token"), "  disk-token\n")
    const harness = setupWithToken(home, { AGENTCHAT_HOME: home, AGENTCHAT_URL: "http://hub.test" })
    await emit(harness, rootCreated())
    expect(harness.kit.calls.some((call) => call.headers["authorization"] === "Bearer disk-token")).toBe(true)
  })

  it("warns clearly and sends an empty bearer when neither source provides a token", async () => {
    const home = tempHome()
    const harness = setupWithToken(home, { AGENTCHAT_HOME: home, AGENTCHAT_URL: "http://hub.test" })
    await emit(harness, rootCreated())
    // 既有失败路径：空 Bearer → Hub 会 401（这里断言请求确实带了空 token；
    // `Headers` 会剥掉值尾随空白，故为 "Bearer"）。
    expect(harness.kit.calls.some((call) => call.headers["authorization"] === "Bearer")).toBe(true)
    expect(harness.logs.some((line) => line.includes("HUB_TOKEN"))).toBe(true)
  })
})

// ── 子注册 ──────────────────────────────────────────────────────────

describe("子会话注册（父关联）", () => {
  it("registers a child with parent_ref=its session node id and task_ref=session id", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), childCreated("child-1", "root-sess"))
    // 层级 实例(agent-1) → 根会话(agent-2) → 子代理(agent-3)：子代理父 = 根会话节点。
    expect(harness.kit.toolCalls[2]).toEqual(
      sessionArgs({ id: "child-1", parentID: "root-sess", title: "子会话标题" }, "agent-2"),
    )
  })

  it("skips a child whose parent session is unmapped (never falls back to the instance)", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), childCreated("child-2", "unknown-sess"))
    // 绝不回落实例节点：父会话未映射即跳过（只保留实例 + 根会话两次注册）。
    expect(harness.kit.toolCalls).toHaveLength(2)
    expect(
      harness.logs.some((line) =>
        line.includes("adopt child child-2 skipped: parent unknown-sess not mapped"),
      ),
    ).toBe(true)
  })
})

// ── 状态上报 ────────────────────────────────────────────────────────

describe("状态上报", () => {
  it("reports busy then idle for the root session", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionStatus("root-sess", "busy"), sessionStatus("root-sess", "idle"))
    // 状态按**会话节点 id**（实例 agent-1 的根会话节点 = agent-2）。
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-2", state: "busy" },
      { agentId: "agent-2", state: "idle" },
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
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })

  it("retires every session node on deletion and never reports offline", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(
      harness,
      rootCreated(),
      childCreated("child-1", "root-sess"),
      { type: "session.deleted", properties: { info: { id: "child-1", parentID: "root-sess" } } },
      { type: "session.deleted", properties: { info: { id: "root-sess", title: "根会话标题" } } },
    )
    // 根会话/子代理皆为实例节点的子节点 → 删除即退役（子节点不得报 offline）。
    const retires = harness.kit.internalCalls
      .filter((call) => call.path === "/internal/retire")
      .map((call) => call.body)
    expect(retires).toEqual([{ agentId: "agent-3" }, { agentId: "agent-2" }])
    const offline = stateCalls(harness.kit).filter(
      (body) => isRecord(body) && body["state"] === "offline",
    )
    expect(offline).toEqual([])
  })
})

describe("会话映射与状态归属", () => {
  it("skips state and wake for unmapped sessions instead of falling back to the root", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      overrides: {
        internal: (path) =>
          path === "/internal/wake"
            ? jsonResponse({
                messages: [{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi" }],
                receipts: [],
              })
            : undefined,
      },
    })
    await emit(
      harness,
      rootCreated(),
      sessionStatus("ghost-sess", "busy"),
      sessionIdle("ghost-sess"),
    )
    expect(stateCalls(harness.kit)).toEqual([])
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/wake")).toBe(false)
    expect(harness.client.texts).toEqual([])
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
  })
})

// ── 已存在/被恢复会话的收养（缺陷：未映射即跳过 → 历史会话永不出现在 AgentChat）──

describe("会话收养（A 懒收养 / B 启动枚举）", () => {
  const wakeOne = {
    internal: (path: string) =>
      path === "/internal/wake"
        ? jsonResponse({ messages: [{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi" }] })
        : undefined,
  }

  it("A/根：adopts an unmapped existing root via token claim then processes the event", async () => {
    const home = tempHome()
    const tokenPath = join(home, "agents", "opencode.token")
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, "existing-token")
    const harness = setup({
      home,
      overrides: { toolsCall: () => toolReply(registerText("agent-1")), ...wakeOne },
    })
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "idle"), sessionIdle("old-root"))
    expect(harness.client.getCalls).toEqual(["old-root"])
    expect(harness.kit.toolCalls).toEqual([
      instanceArgs("existing-token"),
      sessionArgs({ id: "old-root", title: "旧根会话" }, "agent-1"),
    ])
    expect(readFileSync(tokenPath, "utf8")).toBe("existing-token") // 复用旧 token，未新建节点/新 token
    expect(stateCalls(harness.kit)).toContainEqual({ agentId: "agent-1", state: "idle" })
    expect(harness.client.texts).toHaveLength(1)
    expect(harness.client.texts[0]).toContain("hi")
  })

  it("A/子（父已映射）：registers the child under its session node", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated())
    harness.client.sessions.set("child-x", { id: "child-x", parentID: "root-sess", title: "子会话X" })
    await emit(harness, sessionStatus("child-x", "busy"))
    expect(harness.client.getCalls).toEqual(["child-x"])
    // 子代理父 = 其所属根会话节点（agent-2）。
    expect(harness.kit.toolCalls[2]).toEqual(
      sessionArgs({ id: "child-x", parentID: "root-sess", title: "子会话X" }, "agent-2"),
    )
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-3", state: "busy" }])
  })

  it("A/子（父未映射）：skips with warn and never falls back to the root", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.sessions.set("child-y", { id: "child-y", parentID: "ghost-parent" })
    await emit(harness, sessionStatus("child-y", "busy"), sessionIdle("child-y"))
    expect(harness.kit.toolCalls).toEqual([])
    expect(stateCalls(harness.kit)).toEqual([])
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/wake")).toBe(false)
    expect(harness.logs.some((line) => line.includes("adopt child child-y skipped"))).toBe(true)
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
  })

  it("A/查询失败：keeps skip+warn and does not crash when session.get throws (404)", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.getError = new Error("404 not found")
    await emit(harness, rootCreated(), sessionStatus("ghost-sess", "busy"))
    expect(harness.client.getCalls).toEqual(["ghost-sess"])
    expect(stateCalls(harness.kit)).toEqual([])
    expect(harness.logs.some((line) => line.includes("session lookup failed for ghost-sess"))).toBe(true)
    expect(harness.logs.some((line) => line.includes("unmapped session"))).toBe(true)
  })

  it("A/幂等：adopts a session only once across repeated events", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(
      harness,
      sessionStatus("old-root", "busy"),
      sessionStatus("old-root", "idle"),
      sessionStatus("old-root", "busy"),
    )
    expect(harness.client.getCalls).toEqual(["old-root"])
    // 实例 + 会话各一次注册；后续同态事件不再重注册。
    expect(harness.kit.toolCalls).toHaveLength(2)
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-2", state: "busy" },
      { agentId: "agent-2", state: "idle" },
      { agentId: "agent-2", state: "busy" },
    ])
  })

  it("session.updated：adopts a restored session that never emitted session.created", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.sessions.set("revived", { id: "revived", title: "被恢复的会话" })
    await emit(harness, { type: "session.updated", properties: { info: { id: "revived" } } })
    // session.updated 的 info 无标题 → 用回退名登记（实例 + 会话两次注册）。
    expect(harness.client.getCalls).toEqual([])
    expect(harness.kit.toolCalls).toHaveLength(2)
  })

  it("B/枚举：lists bounded roots, filters archived, tolerates a failed session", async () => {
    const home = tempHome()
    let registers = 0
    const harness = setup({
      home,
      deps: {
        env: {
          AGENTCHAT_HOME: home,
          HUB_TOKEN: "hub-token",
          AGENTCHAT_URL: "http://hub.test",
          AGENTCHAT_ADOPT_LIMIT: "3",
        },
      },
      overrides: {
        toolsCall: () => {
          registers += 1
          // 第 1 次是实例节点（成功）；第 2 次（r1 会话）**不可恢复**失败被容忍。
          // 注意：`name_taken` 不再是终态（会带稳定后缀重试一次），故此处用别的 code 表达「失败」。
          return registers === 2
            ? toolReply("RegistrationError: boom [parent_not_found]", true)
            : toolReply(registerText("agent-ok"))
        },
      },
    })
    harness.client.listResult = [
      { id: "r1" },
      { id: "r2" },
      { id: "r3", time: { archived: 1 } }, // 归档：客户端过滤
      { id: "r4" },
      { id: "r5" }, // 超出 limit=3：未收养
    ]
    await harness.handle.flush()
    expect(harness.client.listCalls).toHaveLength(1)
    expect(harness.client.listCalls[0]?.query).toEqual({ scope: "project", roots: true, limit: 3 })
    await emit(
      harness,
      sessionStatus("r2", "busy"),
      sessionStatus("r4", "idle"),
      sessionStatus("r5", "busy"),
      sessionStatus("r3", "busy"),
    )
    // r1 会话注册失败被容忍，r2/r4 挂同一（mock 恒定）节点；r5/r3 未收养 → 各自 warn
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-ok", state: "busy" },
      { agentId: "agent-ok", state: "idle" },
    ])
    expect(harness.logs.some((line) => line.includes("session register failed"))).toBe(true)
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
  })

  it("B/降级：keeps lazy adoption working when session.list throws", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.listError = new Error("list unavailable")
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(harness.logs.some((line) => line.includes("startup adoption list failed"))).toBe(true)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })

  it("B/关闭：does not call session.list when AGENTCHAT_ADOPT=0 (A still effective)", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      deps: {
        env: {
          AGENTCHAT_HOME: home,
          HUB_TOKEN: "hub-token",
          AGENTCHAT_URL: "http://hub.test",
          AGENTCHAT_ADOPT: "0",
        },
      },
    })
    await harness.handle.flush()
    expect(harness.client.listCalls).toHaveLength(0)
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })
})

// ── SDK 返回形状容错（fields 包装 / bare 裸值）──────────────────────
//
// mock 严格复刻 `@opencode-ai/sdk@1.18.32` 实测键集：成功包装 `{data,request,response}`（无 `error`）、
// 失败包装 `{error,request,response}`（**无 `data`**）。后者是缺陷根因——旧判定以 `data` 存在为包装前提，
// 会把失败包装误判为「裸值成功」。

describe("SDK 返回形状容错（fields 包装 / bare 裸值）", () => {
  const wakeOne = {
    internal: (path: string) =>
      path === "/internal/wake"
        ? jsonResponse({ messages: [{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi" }] })
        : undefined,
  }
  const twoMessages = [
    { id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hello" },
    { id: "m2", fromAgentId: "peer", conversationId: "c1", body: "world" },
  ]
  const wakeTwo = {
    internal: (path: string) => (path === "/internal/wake" ? jsonResponse({ messages: twoMessages }) : undefined),
  }

  it("fields/get + error（404）：跳过 + warn，绝不误判为根、不注册", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.shape = "fields"
    harness.client.getError = new Error("404 not found")
    await emit(harness, rootCreated(), sessionStatus("ghost-sess", "busy"), sessionIdle("ghost-sess"))
    expect(harness.client.getCalls).toEqual(["ghost-sess", "ghost-sess"])
    // 仅 rootCreated 的实例 + 会话两次注册；ghost 未被误判为根。
    expect(harness.kit.toolCalls).toHaveLength(2)
    expect(harness.logs.some((line) => line.includes("session lookup failed for ghost-sess"))).toBe(true)
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/wake")).toBe(false)
  })

  it("fields/get + 普通对象 error（真实失败体，无 data）：无既有根时绝不注册根", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.shape = "fields"
    harness.client.getError = { error: "not found" } // 实测：错误体为普通对象，非 Error
    await emit(harness, sessionStatus("ghost-sess", "busy"), sessionIdle("ghost-sess"))
    // 无既有根：若把失败包装误判为裸值 Session，会走 adoptRoot → 触发根注册（toolCalls 增加）。
    expect(harness.kit.toolCalls).toEqual([])
    expect(harness.client.getCalls).toEqual(["ghost-sess", "ghost-sess"])
    expect(harness.logs.filter((line) => line.includes("session lookup failed for ghost-sess"))).toHaveLength(2)
    expect(harness.logs.some((line) => line.includes('{"error":"not found"}'))).toBe(true)
    expect(harness.logs.every((line) => !line.includes("[object Object]"))).toBe(true)
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/wake")).toBe(false)
  })

  it("fields/get + data（根）：复用 token 认领，正常根收养", async () => {
    const home = tempHome()
    const tokenPath = join(home, "agents", "opencode.token")
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, "existing-token")
    const harness = setup({
      home,
      overrides: { toolsCall: () => toolReply(registerText("agent-1")), ...wakeOne },
    })
    harness.client.shape = "fields"
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "idle"), sessionIdle("old-root"))
    expect(harness.client.getCalls).toEqual(["old-root"])
    expect(harness.kit.toolCalls).toEqual([
      instanceArgs("existing-token"),
      sessionArgs({ id: "old-root", title: "旧根会话" }, "agent-1"),
    ])
    expect(readFileSync(tokenPath, "utf8")).toBe("existing-token")
    expect(stateCalls(harness.kit)).toContainEqual({ agentId: "agent-1", state: "idle" })
    expect(harness.client.texts).toHaveLength(1)
  })

  it("fields/get + data（子，父已映射）：子注册 parent_ref=父 agent", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.shape = "fields"
    await emit(harness, rootCreated())
    harness.client.sessions.set("child-x", { id: "child-x", parentID: "root-sess", title: "子会话X" })
    await emit(harness, sessionStatus("child-x", "busy"))
    expect(harness.client.getCalls).toEqual(["child-x"])
    expect(harness.kit.toolCalls[2]).toEqual(
      sessionArgs({ id: "child-x", parentID: "root-sess", title: "子会话X" }, "agent-2"),
    )
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-3", state: "busy" }])
  })

  it("fields/get + data（子，父未映射）：跳过 + warn，不回落根", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.shape = "fields"
    harness.client.sessions.set("child-y", { id: "child-y", parentID: "ghost-parent" })
    await emit(harness, sessionStatus("child-y", "busy"), sessionIdle("child-y"))
    expect(harness.kit.toolCalls).toEqual([])
    expect(stateCalls(harness.kit)).toEqual([])
    expect(harness.logs.some((line) => line.includes("adopt child child-y skipped"))).toBe(true)
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
  })

  it("bare/get：裸 Session 仍正常收养（向后兼容）", async () => {
    const home = tempHome()
    const harness = setup({ home }) // shape 默认 "bare"
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(harness.client.getCalls).toEqual(["old-root"])
    expect(harness.kit.toolCalls).toHaveLength(2)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })

  it("fields/list + data（数组）：过滤归档、限流、逐个根收养", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      deps: {
        env: {
          AGENTCHAT_HOME: home,
          HUB_TOKEN: "hub-token",
          AGENTCHAT_URL: "http://hub.test",
          AGENTCHAT_ADOPT_LIMIT: "3",
        },
      },
    })
    harness.client.shape = "fields"
    harness.client.listResult = [
      { id: "r1" },
      { id: "r2" },
      { id: "r3", time: { archived: 1 } }, // 归档：客户端过滤
      { id: "r4" },
      { id: "r5" }, // 超出 limit=3：未收养
    ]
    await harness.handle.flush()
    expect(harness.client.listCalls).toHaveLength(1)
    expect(harness.client.listCalls[0]?.query).toEqual({ scope: "project", roots: true, limit: 3 })
    await emit(
      harness,
      sessionStatus("r2", "busy"),
      sessionStatus("r4", "idle"),
      sessionStatus("r5", "busy"),
      sessionStatus("r3", "busy"),
    )
    // 实例=agent-1；r1=agent-2、r2=agent-3、r4=agent-4（按注册序）。
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-3", state: "busy" },
      { agentId: "agent-4", state: "idle" },
    ])
    // r5（超 limit）+ r3（归档）未收养 → 各自 warn
    expect(harness.logs.filter((line) => line.includes("unmapped session"))).toHaveLength(2)
  })

  it("fields/list + error：静默降级、不抛错，懒收养（A）仍生效", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.shape = "fields"
    harness.client.listError = new Error("list unavailable")
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(harness.logs.some((line) => line.includes("startup adoption list unavailable"))).toBe(true)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })

  it("bare/list 非数组：静默降级、不抛错，懒收养（A）仍生效", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.listRaw = { unexpected: true }
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(harness.logs.some((line) => line.includes("startup adoption list unavailable"))).toBe(true)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "busy" }])
  })

  it("fields/promptAsync + error：refused（不写 seen、不报 delivered），重投再注入", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wakeTwo })
    harness.client.shape = "fields"
    harness.client.failInjections = 1
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(2)
    const reportItems = (): unknown[] =>
      harness.kit.internalCalls
        .filter((call) => call.path === "/internal/result")
        .map((call) => (isRecord(call.body) ? call.body["items"] : undefined))
    expect(reportItems()[0]).toEqual([
      { messageId: "m1", result: "refused" },
      { messageId: "m2", result: "delivered" },
    ])
    // 失败者绝不报 delivered、绝不写 seen。
    expect(reportItems()[0]).not.toContainEqual({ messageId: "m1", result: "delivered" })
    expect(harness.logs.some((line) => line.includes("inject failed for m1"))).toBe(true)
    // m1 未写入 seen → 第二次 idle 会重新注入 m1（m2 已在 seen，不重复注入）。
    await emit(harness, sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(3)
    expect(harness.client.texts[2]).toContain("hello")
    expect(reportItems()[1]).toEqual([
      { messageId: "m1", result: "delivered" },
      { messageId: "m2", result: "delivered" },
    ])
  })

  it("fields/promptAsync + 普通对象 error：refused，日志为 JSON 而非 [object Object]", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wakeOne })
    harness.client.shape = "fields"
    harness.client.failInjections = 1
    harness.client.injectionError = { error: "rejected" } // 实测真实失败体
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(resultItems(harness.kit)).toEqual([{ messageId: "m1", result: "refused" }])
    expect(harness.logs.some((line) => line.includes('{"error":"rejected"}'))).toBe(true)
    expect(harness.logs.every((line) => !line.includes("[object Object]"))).toBe(true)
  })

  it("fields/promptAsync + data：204 语义，视为 delivered", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wakeTwo })
    harness.client.shape = "fields"
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(2)
    expect(resultItems(harness.kit)).toEqual([
      { messageId: "m1", result: "delivered" },
      { messageId: "m2", result: "delivered" },
    ])
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
    // 投递/状态按**会话节点 id**（实例 agent-1 的根会话节点 = agent-2）。
    expect(harness.kit.internalCalls.find((call) => call.path === "/internal/wake")?.body).toEqual({
      agentId: "agent-2",
    })
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-2", state: "idle" }])
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

// ── 租约重投去重（pull 语义）────────────────────────────────────────

describe("租约重投去重", () => {
  const redelivered = [
    { id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hello" },
    { id: "m2", fromAgentId: "peer", conversationId: "c1", body: "world" },
  ]
  const wake = {
    internal: (path: string) =>
      path === "/internal/wake" ? jsonResponse({ messages: redelivered, receipts: [] }) : undefined,
  }

  it("does not re-inject message ids redelivered by the wake lease; reports delivered again", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wake })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    await emit(harness, sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(2) // 只注入一次；重投不重复注入
    const results = harness.kit.internalCalls.filter((call) => call.path === "/internal/result")
    expect(results).toHaveLength(2)
    expect(resultItems(harness.kit)).toEqual([
      { messageId: "m1", result: "delivered" },
      { messageId: "m2", result: "delivered" },
    ])
  })
})

// ── 运行期子节点退役（缺陷 #4 适配器侧）─────────────────────────────

describe("子节点退役", () => {
  const childDeleted: OpencodeEvent = {
    type: "session.deleted",
    properties: { info: { id: "child-1", parentID: "root-sess" } },
  }

  it("retires the session node on deletion and never reports offline (sessions are children)", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), childCreated("child-1", "root-sess"), childDeleted, {
      type: "session.deleted",
      properties: { info: { id: "root-sess", title: "根会话标题" } },
    })
    // 子代理(agent-3) 与根会话(agent-2) 各自退役；实例节点 agent-1 保留。
    const retires = harness.kit.internalCalls
      .filter((call) => call.path === "/internal/retire")
      .map((call) => call.body)
    expect(retires).toEqual([{ agentId: "agent-3" }, { agentId: "agent-2" }])
    const offline = stateCalls(harness.kit).filter((body) => isRecord(body) && body["state"] === "offline")
    expect(offline).toEqual([])
  })

  it("treats 404 from /internal/retire as already retired (no failure log)", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      overrides: {
        internal: (path) =>
          path === "/internal/retire" ? jsonResponse({ ok: false, error: "agent_not_found" }, 404) : undefined,
      },
    })
    await emit(harness, rootCreated(), childCreated("child-1", "root-sess"), childDeleted)
    expect(harness.kit.internalCalls.some((call) => call.path === "/internal/retire")).toBe(true)
    expect(harness.logs.some((line) => line.includes("retire failed"))).toBe(false)
  })

  it("logs a retire network failure without throwing", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      overrides: {
        internal: (path) => {
          if (path === "/internal/retire") throw new Error("network down")
          return undefined
        },
      },
    })
    await emit(harness, rootCreated(), childCreated("child-1", "root-sess"), childDeleted)
    expect(harness.logs.some((line) => line.includes("retire failed"))).toBe(true)
  })
})

// ── 会话即联系人（实例 → 会话 → 子代理）────────────────────────────

describe("会话即联系人", () => {
  it("session.created 把根会话登记为实例的子节点（task_ref=sessionid，名字=标题）", async () => {
    const home = tempHome()
    const harness = setup({ home })
    const title = "多AI聊天协作工具开源项目调研"
    await emit(harness, rootCreated("sess-1", title))
    expect(harness.kit.toolCalls).toEqual([
      instanceArgs(),
      { vendor: "opencode", parent_ref: "agent-1", task_ref: "sess-1", name: title },
    ])
  })

  it("空标题回退 `opencode:<sessionid 前 8 位>`；带 model 时透传", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, { type: "session.updated", properties: { info: { id: "abcdefgh1234" } } })
    expect(harness.kit.toolCalls[1]).toEqual({
      vendor: "opencode",
      parent_ref: "agent-1",
      task_ref: "abcdefgh1234",
      name: "opencode:abcdefgh",
    })
    const home2 = tempHome()
    const harness2 = setup({ home: home2 })
    await emit(harness2, {
      type: "session.updated",
      properties: { info: { id: "m-sess", title: "带模型", model: { id: "claude-x" } } },
    })
    expect(harness2.kit.toolCalls[1]).toEqual(
      sessionArgs({ id: "m-sess", title: "带模型" }, "agent-1", "claude-x"),
    )
  })

  it("标题变化恰好重注册一次并带新名；未变化不重注册", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated("root-sess", "初始标题"))
    const afterCreate = harness.kit.toolCalls.length // 实例 + 会话
    const info = (title: string): OpencodeEvent => ({
      type: "session.updated",
      properties: { info: { id: "root-sess", title } },
    })

    // 同标题 → no-op（session.updated 会频繁 touch）。
    await emit(harness, info("初始标题"))
    expect(harness.kit.toolCalls).toHaveLength(afterCreate)

    // 变化 → 恰好一次重注册，带新名，仍挂实例节点、task_ref 不变。
    await emit(harness, info("新标题"))
    expect(harness.kit.toolCalls).toHaveLength(afterCreate + 1)
    expect(harness.kit.toolCalls[afterCreate]).toEqual(
      sessionArgs({ id: "root-sess", title: "新标题" }, "agent-1"),
    )

    // 再发同新标题 → 不再重注册。
    await emit(harness, info("新标题"))
    expect(harness.kit.toolCalls).toHaveLength(afterCreate + 1)
  })

  it("子代理标题变化重注册时 parent_ref 仍是其所属会话节点", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated()) // 实例 agent-1 → 根会话 agent-2
    harness.client.sessions.set("child-1", { id: "child-1", parentID: "root-sess", title: "子旧名" })
    await emit(harness, sessionStatus("child-1", "busy")) // 懒收养 → 子代理 agent-3
    const before = harness.kit.toolCalls.length
    await emit(harness, {
      type: "session.updated",
      properties: { info: { id: "child-1", parentID: "root-sess", title: "子新名" } },
    })
    expect(harness.kit.toolCalls).toHaveLength(before + 1)
    expect(harness.kit.toolCalls[before]).toEqual(
      sessionArgs({ id: "child-1", parentID: "root-sess", title: "子新名" }, "agent-2"),
    )
  })

  it("B 枚举把根会话收为实例的子节点并带标题", async () => {
    const home = tempHome()
    const harness = setup({ home })
    harness.client.listResult = [{ id: "r1", title: "项目调研" }]
    await harness.handle.flush()
    expect(harness.kit.toolCalls).toEqual([
      instanceArgs(),
      sessionArgs({ id: "r1", title: "项目调研" }, "agent-1"),
    ])
  })
})

// ── 同名标题冲突（#1：`name_taken` → 稳定别名重试，绝不丢会话）──────────

describe("同名标题冲突（name_taken → 稳定别名重试）", () => {
  /** 按 `index` 定点返回 `name_taken` 错误，其余照常成功（`agent-<index+1>`）。 */
  function nameTakenOn(...failures: number[]) {
    return (_args: unknown, index: number): Response =>
      failures.includes(index)
        ? toolReply("McpToolError: agent name already taken [name_taken]", true)
        : toolReply(registerText(`agent-${index + 1}`))
  }

  const titled = (id: string, title: string): OpencodeEvent => ({
    type: "session.created",
    properties: { info: { id, title } },
  })
  const sessionNode = (id: string, title: string): Record<string, unknown> => ({
    vendor: "opencode",
    parent_ref: "agent-1",
    task_ref: id,
    name: title,
  })

  it("两个同标题会话都成为联系人（第二个用 `<标题> · <sessionid 前 4 位>`）", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: { toolsCall: nameTakenOn(2) } })
    await emit(harness, titled("aaaa-sess", "同名标题"), titled("bbbb-sess", "同名标题"))

    // 实例 + A + B(冲突) + B(别名重试)：B 不被吞。
    expect(harness.kit.toolCalls).toHaveLength(4)
    expect(harness.kit.toolCalls[1]).toEqual(sessionNode("aaaa-sess", "同名标题"))
    expect(harness.kit.toolCalls[3]).toEqual(sessionNode("bbbb-sess", "同名标题 · bbbb"))
    expect(harness.logs.some((line) => line.includes('registered as "同名标题 · bbbb"'))).toBe(true)

    // 两个都成为联系人：各自状态上报到各自节点。
    await emit(harness, sessionStatus("aaaa-sess", "busy"), sessionStatus("bbbb-sess", "idle"))
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-2", state: "busy" },
      { agentId: "agent-4", state: "idle" },
    ])
  })

  it("别名注册幂等：重复事件不重复改名、不重复注册", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: { toolsCall: nameTakenOn(2) } })
    await emit(harness, titled("aaaa-sess", "同名标题"), titled("bbbb-sess", "同名标题"))
    const after = harness.kit.toolCalls.length

    await emit(
      harness,
      { type: "session.updated", properties: { info: { id: "bbbb-sess", title: "同名标题" } } },
      sessionStatus("bbbb-sess", "busy"),
      sessionStatus("bbbb-sess", "busy"),
    )
    // 标题台账记的是**派生名** → 同标题重注册恒 no-op；同态状态去重。
    expect(harness.kit.toolCalls).toHaveLength(after)
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-4", state: "busy" }])
  })

  it("标题变化的重注册同样在 name_taken 时带稳定别名重试", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: { toolsCall: nameTakenOn(2) } })
    await emit(harness, rootCreated("root-sess", "初始标题")) // index0 实例 / index1 会话
    const before = harness.kit.toolCalls.length
    const info = (title: string): OpencodeEvent => ({
      type: "session.updated",
      properties: { info: { id: "root-sess", title } },
    })

    await emit(harness, info("新标题"))
    expect(harness.kit.toolCalls).toHaveLength(before + 2)
    expect(harness.kit.toolCalls[before]).toEqual(sessionNode("root-sess", "新标题"))
    expect(harness.kit.toolCalls[before + 1]).toEqual(sessionNode("root-sess", "新标题 · root"))

    await emit(harness, info("新标题"))
    expect(harness.kit.toolCalls).toHaveLength(before + 2)
  })

  it("标题恰好等于实例节点名（opencode@<host>）同样不被吞", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: { toolsCall: nameTakenOn(1) } })
    const host = osHostname()
    const title = host === undefined ? "opencode" : `opencode@${host}`
    await emit(harness, titled("same-sess", title))

    expect(harness.kit.toolCalls[1]).toEqual(sessionNode("same-sess", title))
    expect(harness.kit.toolCalls[2]).toEqual(sessionNode("same-sess", `${title} · same`))

    await emit(harness, sessionStatus("same-sess", "busy"))
    expect(stateCalls(harness.kit)).toEqual([{ agentId: "agent-3", state: "busy" }])
  })

  it("别名仍冲突（极小概率）→ 保持既有 skip+warn，不落映射、不崩", async () => {
    const home = tempHome()
    const harness = setup({
      home,
      overrides: {
        toolsCall: (_args, index) =>
          index === 0
            ? toolReply(registerText("agent-1"))
            : toolReply("McpToolError: agent name already taken [name_taken]", true),
      },
    })
    await emit(harness, rootCreated("root-sess", "同名标题"))
    expect(harness.kit.toolCalls).toHaveLength(3) // 实例 + 首次 + 别名重试
    expect(
      harness.logs.some(
        (line) => line.includes("session register failed for root-sess") && line.includes("name_taken"),
      ),
    ).toBe(true)

    await emit(harness, sessionStatus("root-sess", "busy"))
    expect(stateCalls(harness.kit)).toEqual([])
    expect(harness.logs.some((line) => line.includes("unmapped session"))).toBe(true)
  })
})

// ── 空闲轮询（缺陷 A：消息在「已经 idle 之后」到达）──────────────────

describe("空闲轮询（idle 期间周期补拉）", () => {
  afterEach(() => vi.useRealTimers())

  function wakeCalls(kit: FetchKit): number {
    return kit.internalCalls.filter((call) => call.path === "/internal/wake").length
  }

  it("polls while idle with no new event, injects the backlog, and reports delivered", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    let calls = 0
    const harness = setup({
      home,
      overrides: {
        internal: (path) => {
          if (path !== "/internal/wake") return undefined
          calls += 1
          const messages =
            calls === 1
              ? []
              : [{ id: "p1", fromAgentId: "peer", conversationId: "c1", body: "later" }]
          return jsonResponse({ messages })
        },
      },
    })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.client.texts).toHaveLength(1)
    expect(harness.client.texts[0]).toContain("later")
    expect(resultItems(harness.kit)).toEqual([{ messageId: "p1", result: "delivered" }])
    // 每次轮询都上报 idle（同态上报即心跳触碰，修复长时间空闲被判 offline）。
    const idles = stateCalls(harness.kit).filter(
      (body) => isRecord(body) && body["state"] === "idle",
    )
    expect(idles.length).toBeGreaterThanOrEqual(2)

    await (await harness.hooks).dispose?.()
  })

  it("stops polling once the session turns busy", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    const afterIdle = wakeCalls(harness.kit)

    await emit(harness, sessionStatus("root-sess", "busy"))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wakeCalls(harness.kit)).toBe(afterIdle)
    await (await harness.hooks).dispose?.()
  })

  it("clears the poll timer on dispose", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    const afterIdle = wakeCalls(harness.kit)

    await (await harness.hooks).dispose?.()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wakeCalls(harness.kit)).toBe(afterIdle)
  })

  it("does not re-inject ids redelivered by a lease while polling", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    const redelivered = [
      { id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hello" },
      { id: "m2", fromAgentId: "peer", conversationId: "c1", body: "world" },
    ]
    const harness = setup({
      home,
      overrides: {
        internal: (path) =>
          path === "/internal/wake" ? jsonResponse({ messages: redelivered }) : undefined,
      },
    })
    await emit(harness, rootCreated(), sessionIdle("root-sess"))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.client.texts).toHaveLength(2) // 只注入一次
    const results = harness.kit.internalCalls.filter((call) => call.path === "/internal/result")
    expect(results.length).toBeGreaterThanOrEqual(2) // 每轮补回执（幂等）
    await (await harness.hooks).dispose?.()
  })

  it("skips polling for unmapped sessions", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated(), sessionIdle("ghost-sess"))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wakeCalls(harness.kit)).toBe(0)
    expect(harness.logs.some((line) => line.includes("unmapped session"))).toBe(true)
    await (await harness.hooks).dispose?.()
  })
})

// ── 归档会话（#2：A 懒收养与 B 启动枚举口径一致）─────────────────────

describe("归档会话（A 与 B 口径一致）", () => {
  afterEach(() => vi.useRealTimers())

  const wakeOne = {
    internal: (path: string) =>
      path === "/internal/wake"
        ? jsonResponse({ messages: [{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi" }] })
        : undefined,
  }
  const retires = (kit: FetchKit): unknown[] =>
    kit.internalCalls.filter((call) => call.path === "/internal/retire").map((call) => call.body)
  const wakes = (kit: FetchKit): number =>
    kit.internalCalls.filter((call) => call.path === "/internal/wake").length

  it("A/未映射的归档会话事件 → 不注册、不注入，且有 warn", async () => {
    const home = tempHome()
    const harness = setup({ home, overrides: wakeOne })
    harness.client.sessions.set("arch-sess", {
      id: "arch-sess",
      title: "已归档",
      time: { archived: 1 },
    })
    await emit(
      harness,
      sessionStatus("arch-sess", "busy"),
      sessionIdle("arch-sess"),
      { type: "session.updated", properties: { info: { id: "arch-sess", title: "已归档", time: { archived: 1 } } } },
    )

    // 事件本身照常查询（A 路径），但归档判定在收养入口拦下。
    expect(harness.client.getCalls).toEqual(["arch-sess", "arch-sess"])
    expect(harness.kit.toolCalls).toEqual([]) // 连实例节点都未注册（未走到 ensureInstance）
    expect(stateCalls(harness.kit)).toEqual([])
    expect(wakes(harness.kit)).toBe(0)
    expect(harness.client.texts).toEqual([])
    expect(retires(harness.kit)).toEqual([]) // 未映射 = 无节点可退役
    expect(harness.logs.filter((line) => line.includes("archived session arch-sess skipped"))).toHaveLength(3)
  })

  it("已映射会话变归档 → 退役、清映射、停轮询，之后不再上报与注入", async () => {
    vi.useFakeTimers()
    const home = tempHome()
    const harness = setup({ home, overrides: wakeOne })
    await emit(harness, rootCreated("root-sess", "活跃会话"))
    await emit(harness, sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(1) // 归档前照常注入
    const wakesBefore = wakes(harness.kit)

    await emit(harness, {
      type: "session.updated",
      properties: { info: { id: "root-sess", title: "活跃会话", time: { archived: 1 } } },
    })
    expect(retires(harness.kit)).toEqual([{ agentId: "agent-2" }])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wakes(harness.kit)).toBe(wakesBefore) // 轮询已停

    await emit(harness, sessionIdle("root-sess"))
    expect(harness.client.texts).toHaveLength(1) // 映射已清：不再注入
    expect(
      stateCalls(harness.kit).filter((body) => isRecord(body) && body["agentId"] === "agent-2"),
    ).toHaveLength(1) // 只剩归档前那一次 idle 上报
    expect(retires(harness.kit)).toEqual([{ agentId: "agent-2" }]) // 不重复退役
    await (await harness.hooks).dispose?.()
  })

  it("非归档会话行为不变：session.updated 不退役，未映射的历史会话照常收养", async () => {
    const home = tempHome()
    const harness = setup({ home })
    await emit(harness, rootCreated())
    await emit(harness, {
      type: "session.updated",
      properties: { info: { id: "root-sess", title: "根会话标题" } },
    })
    expect(retires(harness.kit)).toEqual([])

    await emit(harness, sessionStatus("root-sess", "busy"))
    harness.client.sessions.set("old-root", { id: "old-root", title: "旧根会话" })
    await emit(harness, sessionStatus("old-root", "busy"))
    expect(stateCalls(harness.kit)).toEqual([
      { agentId: "agent-2", state: "busy" },
      { agentId: "agent-3", state: "busy" },
    ])
    expect(retires(harness.kit)).toEqual([])
  })
})

