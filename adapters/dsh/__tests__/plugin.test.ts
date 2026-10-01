/**
 * DSH 主机插件（`adapters/dsh/index.js` 的 `apply`）单测。
 *
 * 覆盖契约：`agent/created` 的「实例根 → 会话子」注册顺序与落盘、持久 join_token 复用、
 * `invalid_join_token` 自愈（清 token 重建、保留 dsh.id）、`agent/status` 的 busy/idle 映射与空闲取件
 * 闭环（followup / steer 分流、seen 去重只补回执）、`agent/disposed` 不退役、插件卸载上报实例
 * offline，以及「Hub 全 500」时所有失败被吞掉（监听器不抛、无未处理拒绝、只落日志）。
 *
 * 隔离：不 import `child_process`（沙箱禁止管道 stdio），不连真实网络（`globalThis.fetch` 全量替换为
 * 本地假 Hub，用 `vi.stubGlobal`）；每个用例自建临时 `AGENTCHAT_HOME`，`afterEach` 还原 env 与全局。
 * 轮询间隔用 `config.pollMs = 1000`（`parsePollMs` 下限）压到最短 + `waitUntil` 条件等待；不用假定时器：
 * `advanceTimersByTimeAsync` 与插件内部的真实 Promise 链（含 `@deepseek-ai/dsh-llm` 的模块解析）混用
 * 会互相等待而死锁——最初的假定时器版本 12/14 用例 30s 超时即此因。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Listener = (payload: unknown) => void
type Json = Record<string, unknown>

// ── 假 ctx（Cordis 上下文最小面）与假 Hub（stub `globalThis.fetch`）───────────

/** `listeners` = `ctx.on` 注册的监听器；`disposers` = `ctx.effect` 回调返回的清理函数。 */
interface FakeContext {
  readonly listeners: Map<string, Listener>
  readonly disposers: Array<() => void>
  /** `ctx.effect` 回调的**返回值**（Cordis 会 await 它；丢掉的承诺 = 卸载不等上报完成）。 */
  readonly disposeResults: unknown[]
  /** 宿主侧观察到的告警（插件把日志同时转发给 `ctx.logger.warn`）。 */
  readonly warnings: string[]
  /** 设置 `ctx.get('agents')` 的返回值（加载期回填用例在 `apply` **之前**调用）。 */
  readonly setRegistry: (value: unknown) => void
  ctx: {
    on: (name: string, listener: Listener) => void
    effect: (callback: () => () => void, label?: string) => void
    logger: { warn: (message: string) => void }
    get: (name: string) => unknown
  }
}

function fakeContext(): FakeContext {
  const listeners = new Map<string, Listener>()
  const disposers: Array<() => void> = []
  const disposeResults: unknown[] = []
  const warnings: string[] = []
  const record = <T>(box: T[]) => (value: T) => void box.push(value)
  let registry: unknown
  return {
    listeners,
    disposers,
    disposeResults,
    warnings,
    setRegistry: (value) => void (registry = value),
    ctx: {
      on: (name, listener) => void listeners.set(name, listener),
      effect: (callback) => void disposers.push(callback()),
      logger: { warn: record(warnings) },
      get: (name) => (name === "agents" ? registry : undefined),
    },
  }
}

interface RequestRecord {
  readonly path: string
  readonly body: Json
  readonly headers: Record<string, string>
}
/** MCP `tools/call` 的假回复：`text` = 工具层原文，`isError` = 工具层错误。 */
interface ToolReply {
  readonly text: string
  readonly isError?: boolean
}
interface HubKit {
  readonly requests: RequestRecord[]
  /** 收到的 `register` 工具入参（按调用序）；断言注册顺序与载荷用。 */
  readonly toolArgs: Json[]
  /** 每次 `tools/call` 的回复覆盖；`undefined` 用默认（`agent-<n>` + 首次 join_token）。 */
  onToolCall: (args: Json, index: number) => ToolReply | undefined
  /** `/internal/*` 的回复覆盖；可为**挂起的 Promise**（卡住在途请求）；`undefined` 用默认。 */
  onInternal: (path: string, body: Json, index: number) => unknown
  /** 为 `true` 时所有请求返回 HTTP 500（可重试退避路径）。 */
  failAll: boolean
}

function responseLike(status: number, text: string, sessionId?: string): Response {
  const get = (name: string) => (name === "mcp-session-id" ? (sessionId ?? null) : null)
  return { status, text: async () => text, headers: { get } } as unknown as Response
}
/** MCP JSON-RPC 帧：`result.content[0].text` 承载工具返回值（server `toolResult` 约定）。 */
function toolFrame(text: string, isError: boolean): string {
  const result = { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
  return `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result })}\n\n`
}
/** 默认 register 文本：仅首次返回 join_token（重连认领不再新发）。 */
function defaultRegisterText(index: number): string {
  const id = `agent-${index + 1}`
  return JSON.stringify({ agent: { id }, ...(index === 0 ? { join_token: `jt-${id}` } : {}) })
}

/** 安装假 Hub 到 `globalThis.fetch`（调用方负责 `vi.unstubAllGlobals()` 还原）。 */
function fakeHub(): HubKit {
  const kit: HubKit = { requests: [], toolArgs: [], onToolCall: () => undefined, onInternal: () => undefined, failAll: false }
  let internalIndex = 0
  const impl = async (input: unknown, init?: { readonly body?: unknown; readonly headers?: unknown }) => {
    const path = new URL(String(input)).pathname
    const body: Json = typeof init?.body === "string" ? JSON.parse(init.body) : {}
    // 插件把 `globalThis.fetch` 交给 hub 客户端，故此处记录即等价于 Hub 收到的请求。
    kit.requests.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> })
    if (kit.failAll) return responseLike(500, "hub down")
    if (path !== "/mcp") {
      const custom = kit.onInternal(path, body, internalIndex)
      internalIndex += 1
      if (custom !== undefined) return responseLike(200, JSON.stringify(await custom))
      return responseLike(200, JSON.stringify(path === "/internal/wake" ? { messages: [] } : {}))
    }
    if (body["method"] === "initialize") return responseLike(200, '{"jsonrpc":"2.0","id":1,"result":{}}', "sess-dsh")
    if (body["method"] === "notifications/initialized") return responseLike(202, "")
    if (body["method"] !== "tools/call") return responseLike(400, '{"error":"unknown mcp method"}')
    const params = body["params"] as Json | undefined
    const args = (params?.["arguments"] ?? {}) as Json
    const index = kit.toolArgs.length
    kit.toolArgs.push(args)
    // `await` 也接住**挂起的 Promise**：注册在途（`hub.register` 卡在 await 上）的竞态用例需要它。
    const reply = (await kit.onToolCall(args, index)) ?? { text: defaultRegisterText(index) }
    return responseLike(200, toolFrame(reply.text, reply.isError === true))
  }
  vi.stubGlobal("fetch", impl as unknown as typeof fetch)
  return kit
}

// ── 事件载荷 / 假 agent ─────────────────────────────────────────────────────

/** 注入消息（契约：`role`/`content`/`source`；`id` 由插件兜底或 `createUserMessage` 生成）。 */
interface InjectedMessage {
  readonly id: string
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>
  readonly source: { readonly kind: string; readonly plugin: string; readonly form: string }
}
/** 假 agent：只实现插件用到的 `followup`（空闲唤醒）与 `steer`（busy 就近交付）。 */
interface FakeAgent {
  readonly session: { readonly header: Json }
  readonly followups: InjectedMessage[]
  readonly steers: InjectedMessage[]
  followup: (message: InjectedMessage) => void
  steer: (message: InjectedMessage) => void
}

function fakeAgent(header: Json): FakeAgent {
  const followups: InjectedMessage[] = []
  const steers: InjectedMessage[] = []
  const push = (box: InjectedMessage[]) => (message: InjectedMessage) => void box.push(message)
  return { session: { header }, followups, steers, followup: push(followups), steer: push(steers) }
}
/** 会话 header：`cwd` 决定节点可读名（目录名），`origin` 标记子代理，`parentSession` 为 fork 血缘。 */
function sessionHeader(id: string, extra: Json = {}): Json {
  return { version: 1, id, createdAt: "2026-01-01T00:00:00.000Z", cwd: "C:\\work\\proj", ...extra }
}
/** 实例节点注册入参期望：`dsh@<host>`（主机名缺失回退 `dsh`）+ `role_tag=container`。 */
function instanceArgs(joinToken?: string): Json {
  const host = hostname()
  const base = { vendor: "dsh", purpose: "coding-agent", name: host === "" ? "dsh" : `dsh@${host}`, role_tag: "container" }
  return { ...base, ...(joinToken === undefined ? {} : { join_token: joinToken }) }
}
/** 会话节点注册入参期望：名 = `<cwd 目录名>-<id 前 8 位>`（无 cwd 则 `dsh-<id8>`，保证跨会话唯一）。 */
function sessionArgs(sessionId: string, parentRef: string, options: { cwd?: string; subagent?: boolean } = {}): Json {
  const suffix = sessionId.slice(0, 8)
  const cwd = options.cwd ?? "C:\\work\\proj"
  const name = cwd === "" ? `dsh-${suffix}` : `${cwd.split("\\").pop()}-${suffix}`
  const purpose = options.subagent === true ? "subagent" : "coding-agent"
  return { vendor: "dsh", purpose, name, parent_ref: parentRef, task_ref: sessionId }
}

// ── 测试脚手架 ──────────────────────────────────────────────────────────────

/** 轮询间隔下限（`parsePollMs` 钳制到 ≥1000ms）：用例里压到最短，轮询断言不真等。 */
const POLL_MS = 1000
const homes: string[] = []
const savedEnv: Record<string, string | undefined> = {}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-dsh-plugin-"))
  homes.push(home)
  return home
}
/** 条件等待（每 5ms 复查；预算 6s）。返回条件是否成立，供 `expect(await waitUntil(…)).toBe(true)`。 */
async function waitUntil(predicate: () => boolean, budgetMs = 6000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return predicate()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
/** 等一段真实时间：仅用于「不该发生的事」的负向断言（跨过一个轮询周期）。 */
function settle(ms = POLL_MS + 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function stateBodies(kit: HubKit): Json[] {
  return kit.requests.filter((r) => r.path === "/internal/state").map((r) => r.body)
}
function pathBodies(kit: HubKit, path: string): Json[] {
  return kit.requests.filter((r) => r.path === path).map((r) => r.body)
}
/** 节点已注册（子注册 + online 上报都完成）的判据。 */
function registered(kit: HubKit, sessionId: string): boolean {
  const isOnline = (b: Json) => b["state"] === "online"
  return kit.toolArgs.some((a) => a["task_ref"] === sessionId) && stateBodies(kit).some(isOnline)
}
function logText(home: string): string {
  try {
    return readFileSync(join(home, "logs", "dsh-adapter.log"), "utf8")
  } catch {
    return ""
  }
}
interface Harness {
  readonly kit: HubKit
  readonly ctx: FakeContext
  readonly home: string
  /** 取已注册的监听器（不存在即抛，避免静默跳过断言）。 */
  readonly on: (name: string) => Listener
  /** 运行 `ctx.effect` 的清理函数（等价于 Cordis 卸载插件）。 */
  dispose: () => void
}
/** 建假 ctx + 假 Hub（+ 临时 home / env）并 `apply()` 插件；`agents` = 加载期就已存在的 agent（回填用例）。 */
async function setup(config?: Json, agents?: readonly unknown[]): Promise<Harness> {
  const home = tempHome()
  process.env["AGENTCHAT_HOME"] = home
  process.env["HUB_TOKEN"] = "hub-token"
  process.env["AGENTCHAT_URL"] = "http://hub.test"
  delete process.env["AGENTCHAT_POLL_MS"]
  const kit = fakeHub()
  const fake = fakeContext()
  if (agents !== undefined) fake.setRegistry({ list: () => [...agents] })
  const mod = (await import("../index.js")) as { apply(ctx: unknown, config?: unknown): void }
  mod.apply(fake.ctx, config ?? { pollMs: POLL_MS })
  const on = (name: string): Listener => {
    const listener = fake.listeners.get(name)
    if (listener === undefined) throw new Error(`listener not registered: ${name}`)
    return listener
  }
  const dispose = (): void => {
    for (const [index, fn] of fake.disposers.entries()) {
      // 记录 disposer 的返回值：Cordis **await** 它，卸载路径必须把「实例 offline」上报的 Promise
      // 交出去，否则上报可能还没发出、进程/插件就已经卸载完。
      fake.disposeResults[index] = fn()
    }
  }
  return { kit, ctx: fake, home, on, dispose }
}
/** 在**已有** home/env 上再 `apply()` 一次（复用落盘 token 的用例）。 */
async function applyAgain(): Promise<FakeContext> {
  const fake = fakeContext()
  const mod = (await import("../index.js")) as { apply(ctx: unknown, config?: unknown): void }
  mod.apply(fake.ctx, { pollMs: POLL_MS })
  return fake
}
/** 预置落盘文件（注册前的陈旧状态）。 */
function seed(home: string, files: Record<string, string>): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(home, "agents", name), value)
}
beforeEach(() => {
  savedEnv["AGENTCHAT_HOME"] = process.env["AGENTCHAT_HOME"]
  savedEnv["HUB_TOKEN"] = process.env["HUB_TOKEN"]
  savedEnv["AGENTCHAT_URL"] = process.env["AGENTCHAT_URL"]
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

// ── 注册层级与落盘 ──────────────────────────────────────────────────────────

describe("agent/created：实例根 → 会话子", () => {
  it("先注册实例节点（container），再注册会话子节点（parent_ref/task_ref），并上报 online", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    // 根注册 → 子注册（子节点的 parent_ref 依赖根返回的 id，顺序即契约）。
    expect(h.kit.toolArgs).toEqual([instanceArgs(), sessionArgs("sess-1", "agent-1")])
    expect(h.kit.requests.filter((r) => r.path === "/mcp")).toHaveLength(6) // 每次注册 3 个 /mcp 请求
    expect(h.kit.requests[0]?.headers["authorization"]).toBe("Bearer hub-token")
    expect(h.kit.requests.every((r) => r.headers["content-type"] === "application/json")).toBe(true)
    // 落盘：join_token + 节点 id（MCP 桥出站身份兜底值）+ 会话身份提示（恰好一个顶层会话）。
    expect(readFileSync(join(h.home, "agents", "dsh.token"), "utf8")).toBe("jt-agent-1")
    expect(readFileSync(join(h.home, "agents", "dsh.id"), "utf8")).toBe("agent-1")
    expect(readFileSync(join(h.home, "agents", "dsh.current"), "utf8")).toBe("agent-2")
    expect(stateBodies(h.kit)).toEqual([{ agentId: "agent-2", state: "online" }]) // 注册期只有会话节点报 online；根容器首次被触碰发生在 idle 心跳（见下例）
  })
  it("子代理会话（origin=subagent，父已映射）purpose=subagent 且 parent_ref=父会话节点", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-root")) })
    expect(await waitUntil(() => registered(h.kit, "sess-root"))).toBe(true)
    const child = sessionHeader("sess-child", { origin: "subagent", parentSession: "sess-root" })
    h.on("agent/created")({ agent: fakeAgent(child) })
    expect(await waitUntil(() => registered(h.kit, "sess-child"))).toBe(true)
    expect(h.kit.toolArgs[2]).toEqual(sessionArgs("sess-child", "agent-2", { subagent: true }))
    const online = { agentId: "agent-3", state: "online" }
    expect(stateBodies(h.kit)).toEqual([{ agentId: "agent-2", state: "online" }, online])
  })
  it("cwd 缺失时节点名回退 `dsh-<id 前 8 位>`；header.id 缺失则跳过注册且不抛错", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("abcdefgh-1234", { cwd: undefined })) })
    expect(await waitUntil(() => registered(h.kit, "abcdefgh-1234"))).toBe(true)
    expect(h.kit.toolArgs[1]?.["name"]).toBe("dsh-abcdefgh")
    h.on("agent/created")({ agent: { session: { header: {} } } })
    h.on("agent/created")(undefined)
    expect(await waitUntil(() => logText(h.home).includes("会话缺少 header.id"))).toBe(true)
    expect(h.kit.toolArgs).toHaveLength(2) // 未新增注册
  })
})

// ── 注册期释放（僵尸登记）────────────────────────────────────────────────────

describe("注册在途时 agent/disposed", () => {
  it("注册期间被释放 → 不登记映射、不上报 online、不注入；同一会话重开后可正常注册", async () => {
    const h = await setup()
    // 第 2 次 tools/call（= 会话节点 register）**首次尝试**返回挂起的 Promise：注册卡在 await 上。
    // 注册「成功返回」之后才释放，从而精确复现「注册期间收到 agent/disposed」的真实时序。
    // （只挂首次尝试：register 失败会退避重试，若每次都挂，测试只能靠超时收场。）
    let releaseRegister: (() => void) | undefined
    let hung = false
    h.kit.onToolCall = (_args, index) => {
      if (index !== 1 || hung) return undefined
      hung = true
      return new Promise<ToolReply>((resolve) => {
        releaseRegister = () => resolve({ text: JSON.stringify({ agent: { id: "agent-2" } }) })
      }) as unknown as ToolReply
    }

    const first = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent: first })
    // 等到「根已注册 + 会话注册在途」（会话注册入参已到达 Hub，响应尚未返回）。
    expect(await waitUntil(() => h.kit.toolArgs.length === 2)).toBe(true)
    h.on("agent/disposed")({ agent: first }) // 注册在途时释放
    await settle(200) // 远短于 6s：证明注册确实挂在 await 上，而不是已经完成

    releaseRegister?.()
    // 注册返回后必须**放弃登记**：映射里不留僵尸 agent、也不为它上报 online。
    const abandoned = () => h.ctx.warnings.some((line) => line.includes("放弃登记"))
    expect(await waitUntil(abandoned)).toBe(true)
    expect(stateBodies(h.kit)).toEqual([]) // 绝无 online
    expect(hintOf(h.home)).toBeUndefined() // 也不得把已释放会话写进身份提示
    expect(first.followups).toHaveLength(0)
    expect(first.steers).toHaveLength(0)

    // 同一会话重开：`agent/created` 清除释放标记 → 照常注册、上报 online 并写回身份提示
    // （出站身份因此指回活着的会话节点，而不是已释放的那个）。
    const second = fakeAgent(sessionHeader("sess-1"))
    h.kit.onToolCall = () => undefined
    h.on("agent/created")({ agent: second })
    const online3 = () => stateBodies(h.kit).some((b) => b["agentId"] === "agent-3" && b["state"] === "online")
    expect(await waitUntil(online3)).toBe(true)
    expect(await waitUntil(() => hintOf(h.home) === "agent-3")).toBe(true)

    // 重开后的会话走正常的空闲取件路径：消息交给**新** agent（僵尸对象绝不接收）。
    h.kit.onInternal = (path) => (path === "/internal/wake" ? { messages: [{ id: "m1", fromAgentId: "peer", body: "重开后的消息" }] } : undefined)
    h.on("agent/status")({ agent: second, status: "idle" })
    expect(await waitUntil(() => second.followups.length === 1)).toBe(true)
    expect(second.followups[0]?.content[0]?.text).toContain("重开后的消息")
    expect(pathBodies(h.kit, "/internal/result")).toEqual([{ agentId: "agent-3", items: [{ messageId: "m1", result: "delivered" }] }])
    expect(first.followups).toHaveLength(0)
    expect(first.steers).toHaveLength(0)
  })
})

/** 读身份提示文件的当前值（不存在 → `undefined`）。 */
function hintOf(home: string): string | undefined {
  try {
    return readFileSync(join(home, "agents", "dsh.current"), "utf8")
  } catch {
    return undefined
  }
}

// ── 会话身份提示（dsh.current）与出站身份 ────────────────────────────────────

describe("会话身份提示 dsh.current", () => {
  it("仅一个顶层会话时写入其节点 id；第二个顶层会话出现即删除，剩一个时又写回", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-a")) })
    expect(await waitUntil(() => registered(h.kit, "sess-a"))).toBe(true)
    expect(hintOf(h.home)).toBe("agent-2") // 出站身份 = 会话节点（容器不可作为 DM 收件方）

    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-b")) })
    expect(await waitUntil(() => registered(h.kit, "sess-b"))).toBe(true)
    expect(hintOf(h.home)).toBeUndefined() // ≥2 个顶层会话 → 删除（桥回落到容器，回复会被 Hub 拒）

    h.on("agent/disposed")({ agent: fakeAgent(sessionHeader("sess-b")) })
    expect(await waitUntil(() => hintOf(h.home) === "agent-2")).toBe(true) // 只剩 sess-a → 写回它的节点 id
  })

  it("子代理会话不参与计数：顶层会话的提示保持不变", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-root")) })
    expect(await waitUntil(() => registered(h.kit, "sess-root"))).toBe(true)
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-child", { origin: "subagent", parentSession: "sess-root" })) })
    expect(await waitUntil(() => registered(h.kit, "sess-child"))).toBe(true)
    expect(hintOf(h.home)).toBe("agent-2") // 仍是顶层会话节点，而不是子代理节点 agent-3
  })

  it("唯一会话释放 → 提示删除；插件卸载 → 提示删除（桥不再带陈旧会话身份）", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/disposed")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => hintOf(h.home) === undefined)).toBe(true)

    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-2")) })
    expect(await waitUntil(() => registered(h.kit, "sess-2"))).toBe(true)
    expect(hintOf(h.home)).toBe("agent-3")
    h.dispose()
    expect(await waitUntil(() => hintOf(h.home) === undefined)).toBe(true)
  })
})

// ── join_token 复用与陈旧自愈 ───────────────────────────────────────────────

describe("join_token 复用与陈旧自愈", () => {
  it("第二次 apply 复用落盘 token：根注册带 join_token，Hub 未回传时旧值不被覆写", async () => {
    const h = await setup()
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    expect(readFileSync(join(h.home, "agents", "dsh.token"), "utf8")).toBe("jt-agent-1")
    // 第二次 apply（同一 home）：认领成功但 Hub **不回传**新 token（只回 agent id）。
    h.kit.onToolCall = () => ({ text: JSON.stringify({ agent: { id: "agent-7" } }) })
    h.kit.toolArgs.length = 0
    const fake2 = await applyAgain()
    fake2.listeners.get("agent/created")?.({ agent: fakeAgent(sessionHeader("sess-2")) })
    const online7 = (b: Json) => b["agentId"] === "agent-7" && b["state"] === "online"
    expect(await waitUntil(() => h.kit.toolArgs.length === 2 && stateBodies(h.kit).some(online7))).toBe(true)
    expect(h.kit.toolArgs[0]).toEqual(instanceArgs("jt-agent-1"))
    expect(h.kit.toolArgs[1]).toEqual(sessionArgs("sess-2", "agent-7"))
    expect(readFileSync(join(h.home, "agents", "dsh.token"), "utf8")).toBe("jt-agent-1")
    expect(readFileSync(join(h.home, "agents", "dsh.id"), "utf8")).toBe("agent-7")
  })
  it("invalid_join_token → 清 token 后按首次注册重来（恰好两次根注册），dsh.id 保留", async () => {
    const h = await setup()
    seed(h.home, { "dsh.token": "stale-token" }) // 模拟「Hub 换库」后的第一次注册
    h.kit.onToolCall = (_args, index) =>
      index === 0
        ? { text: "RegistrationError: unknown join_token [invalid_join_token]", isError: true }
        : { text: JSON.stringify({ agent: { id: "agent-9" }, join_token: "jt-new" }) }
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    // 第一次带陈旧 token；第二次**不带**（按首次注册重建，不存在可重复的根）。
    expect(h.kit.toolArgs).toEqual([instanceArgs("stale-token"), instanceArgs(), sessionArgs("sess-1", "agent-9")])
    expect(readFileSync(join(h.home, "agents", "dsh.token"), "utf8")).toBe("jt-new")
    expect(readFileSync(join(h.home, "agents", "dsh.id"), "utf8")).toBe("agent-9")
    expect(logText(h.home)).toContain("join_token 失效")
  })
  it("自愈后的第二次根注册仍失败 → 本次不注册会话节点，dsh.id 不被删除", async () => {
    const h = await setup()
    seed(h.home, { "dsh.id": "stale-id", "dsh.token": "stale-token" })
    h.kit.onToolCall = (_args, index) =>
      index === 0
        ? { text: "RegistrationError: unknown join_token [invalid_join_token]", isError: true }
        : { text: "RegistrationError: boom [name_taken]", isError: true }
    h.on("agent/created")({ agent: fakeAgent(sessionHeader("sess-1")) })
    expect(await waitUntil(() => logText(h.home).includes("name_taken"))).toBe(true)
    expect(h.kit.toolArgs).toHaveLength(2) // 只有两次根注册，无会话注册
    expect(stateBodies(h.kit)).toEqual([])
    expect(readFileSync(join(h.home, "agents", "dsh.id"), "utf8")).toBe("stale-id")
  })
})

// ── 状态映射 / 注入分流 / 去重 ──────────────────────────────────────────────

describe("agent/status：busy/idle 与空闲取件", () => {
  it("running → busy；idle → 会话+实例 idle 心跳 + wake + followup 单条合并消息 + 逐条 delivered", async () => {
    const h = await setup()
    const two = [{ id: "m1", fromAgentId: "peer-1", body: "第一条" }, { id: "m2", fromAgentId: "peer-2", body: "第二条" }]
    h.kit.onInternal = (path) => (path === "/internal/wake" ? { messages: two } : undefined)
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "running" })
    expect(await waitUntil(() => stateBodies(h.kit).some((b) => b["state"] === "busy"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => agent.followups.length === 1)).toBe(true)
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/result").length === 1)).toBe(true)
    expect(stateBodies(h.kit)).toEqual([
      { agentId: "agent-2", state: "online" },
      { agentId: "agent-2", state: "busy" },
      { agentId: "agent-1", state: "busy" }, // 根容器搭车同态上报（长回合期间也不被判 offline）
      { agentId: "agent-2", state: "idle" },
      { agentId: "agent-1", state: "idle" }, // 根容器搭车心跳（否则被判 offline）
    ])
    expect(agent.steers).toHaveLength(0) // 恰好一次注入：单条消息，文本含每条新消息的 id 与正文
    const message = agent.followups[0]!
    expect(message.role).toBe("user")
    expect(message.source).toEqual({ kind: "plugin:agentchat", form: "relay" }) // v4 只收生产者自有 kind（`kind:'plugin'` 会被会话格式校验拒绝）
    expect(typeof message.id).toBe("string")
    expect(message.content).toHaveLength(1)
    expect(message.content[0]?.type).toBe("text")
    const text = message.content[0]?.text ?? ""
    for (const fragment of ["[m1]", "第一条", "[m2]", "第二条"]) expect(text).toContain(fragment)
    const items = [{ messageId: "m1", result: "delivered" }, { messageId: "m2", result: "delivered" }]
    expect(pathBodies(h.kit, "/internal/result")).toEqual([{ agentId: "agent-2", items }])
  })
  it("seen 去重：轮询第二轮遇同一消息不再 followup，只补 delivered 回执", async () => {
    const h = await setup()
    const payload = { messages: [{ id: "m1", fromAgentId: "peer-1", body: "第一条" }] }
    h.kit.onInternal = (path) => (path === "/internal/wake" ? payload : undefined)
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => agent.followups.length === 1)).toBe(true)
    const receipt = { agentId: "agent-2", items: [{ messageId: "m1", result: "delivered" }] }
    expect(pathBodies(h.kit, "/internal/result")).toEqual([receipt])
    // 空闲轮询（pollMs=1000）触发第二轮：同一消息已在 seen → 不重复注入，只补回执。
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 2)).toBe(true)
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/result").length === 2)).toBe(true)
    expect(agent.followups).toHaveLength(1)
    expect(pathBodies(h.kit, "/internal/result")[1]).toEqual(receipt)
  })
  it("busy 状态停轮询（跨过一个轮询周期不 wake），且 running 期间不注入", async () => {
    const h = await setup()
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 1)).toBe(true)
    h.on("agent/status")({ agent, status: "running" })
    expect(await waitUntil(() => stateBodies(h.kit).some((b) => b["state"] === "busy"))).toBe(true)
    await settle() // 跨过一个完整轮询周期：若轮询未停，这里会出现第二次 wake
    expect(pathBodies(h.kit, "/internal/wake")).toHaveLength(1)
    expect(agent.followups).toHaveLength(0)
    expect(agent.steers).toHaveLength(0)
  })
  it("轮询在途时切到 running → 该轮交付改走 steer（busy 语义）而非 followup", async () => {
    const h = await setup()
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 1)).toBe(true)
    // 第二轮 wake 挂起，把轮询的 flush 卡在「心跳已过、交付未发生」处：先切 running 再放行。
    const payload = { messages: [{ id: "m9", fromAgentId: "peer", body: "急件" }] }
    let release: (() => void) | undefined
    let held = false
    h.kit.onInternal = (path) => {
      if (path !== "/internal/wake") return undefined
      if (held) return payload
      held = true
      return new Promise((resolve) => {
        release = () => resolve(payload)
      })
    }
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 2)).toBe(true)
    h.on("agent/status")({ agent, status: "running" })
    expect(await waitUntil(() => stateBodies(h.kit).some((b) => b["state"] === "busy"))).toBe(true)
    release?.()
    expect(await waitUntil(() => agent.steers.length === 1)).toBe(true)
    expect(agent.followups).toHaveLength(0)
    expect(agent.steers[0]?.content[0]?.text).toContain("急件")
    const receipt = { agentId: "agent-2", items: [{ messageId: "m9", result: "delivered" }] }
    expect(pathBodies(h.kit, "/internal/result")).toContainEqual(receipt)
  })
})

// ── disposed / 卸载 ─────────────────────────────────────────────────────────

describe("agent/disposed 与插件卸载", () => {
  it("disposed 停轮询、不退役（绝不发 /internal/retire，也不报 offline）", async () => {
    const h = await setup()
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 1)).toBe(true)
    h.on("agent/disposed")({ agent })
    h.on("agent/disposed")(undefined) // 形状不符是安全的空操作
    await settle()
    expect(pathBodies(h.kit, "/internal/wake")).toHaveLength(1) // 轮询已停
    expect(h.kit.requests.some((r) => r.path === "/internal/retire")).toBe(false)
    // 子节点也不报 offline（Hub 以 child_never_offline 拒绝）；离开即静默。
    expect(stateBodies(h.kit).some((b) => b["state"] === "offline")).toBe(false)
    expect(logText(h.home)).toContain("停止跟踪")
  })
  it("ctx.effect 清理 → 实例节点上报 offline，且此后不再轮询", async () => {
    const h = await setup()
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    h.on("agent/status")({ agent, status: "idle" })
    expect(await waitUntil(() => pathBodies(h.kit, "/internal/wake").length === 1)).toBe(true)
    h.dispose()
    // disposer **必须返回**离线上报的 Promise（Cordis await 它）；丢弃它 = 卸载不等上报完成。
    expect(h.ctx.disposeResults[0]).toBeInstanceOf(Promise)
    await expect(h.ctx.disposeResults[0]).resolves.toBeUndefined()
    expect(await waitUntil(() => stateBodies(h.kit).some((b) => b["state"] === "offline"))).toBe(true)
    const states = stateBodies(h.kit)
    expect(states[states.length - 1]).toEqual({ agentId: "agent-1", state: "offline" })
    await settle()
    expect(pathBodies(h.kit, "/internal/wake")).toHaveLength(1)
  })
})

// ── 失败吞没 ────────────────────────────────────────────────────────────────

describe("失败吞噬（Hub 全 500）", () => {
  it("所有监听器同步不抛、无未处理拒绝，失败落 dsh-adapter.log", async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => void rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    try {
      const h = await setup()
      h.kit.failAll = true
      const agent = fakeAgent(sessionHeader("sess-1"))
      expect(() => h.on("agent/created")({ agent })).not.toThrow()
      expect(() => h.on("agent/status")({ agent, status: "running" })).not.toThrow()
      expect(() => h.on("agent/status")({ agent, status: "idle" })).not.toThrow()
      expect(() => h.on("agent/disposed")({ agent })).not.toThrow()
      expect(() => h.on("agent/disposed")(undefined)).not.toThrow()
      // 首次根注册重试耗尽（4 次尝试 + 250/500/1000ms 退避 + jitter）后落一条告警。
      const warned = () => h.ctx.warnings.some((line) => line.includes("实例节点注册失败"))
      expect(await waitUntil(warned, 15_000)).toBe(true)
      await settle(300)
      expect(rejections).toEqual([])
      expect(logText(h.home)).toContain("实例节点注册失败")
      // 实例注册即失败 → 无会话注册、无任何 /internal 调用；桥把每次「首帧」重试 4 次
      // （`lib/hub-config.js`：1 次首次 + 3 次退避重试），且从不进到 notifications/initialized。
      expect(h.kit.requests.every((r) => r.path === "/mcp")).toBe(true)
      const mcp = h.kit.requests.filter((r) => r.path === "/mcp")
      expect(mcp.filter((r) => r.body["method"] === "initialize")).toHaveLength(4)
      expect(mcp.filter((r) => r.body["method"] === "notifications/initialized")).toHaveLength(0)
      expect(mcp.filter((r) => r.body["method"] === "tools/call")).toHaveLength(0)
      expect(h.kit.toolArgs).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })
})

// ── 加载期回填（运行中安装 / profile 热重组 / HMR）──────────────────────────

describe("加载期回填", () => {
  it("插件晚于会话加载：没有 agent/created 也把已存在的 agent 会话注册为节点", async () => {
    // 真实场景：把适配器装进正在运行的 DSH 时，用户当前打开的会话早已创建 —— 其 `agent/created`
    // 发生在插件加载**之前**，永远收不到；只有 `agent/status`（回合边界）才会被动收养它。
    // `ctx.agents.list()` 回填把这段空窗期消掉。
    const agent = fakeAgent(sessionHeader("sess-existing"))
    const h = await setup(undefined, [agent])
    expect(await waitUntil(() => registered(h.kit, "sess-existing"))).toBe(true)
    // 仍是实例容器在前、会话子节点在后（与 created 路径同一注册序），父引用指向实例节点 `agent-1`。
    expect(h.kit.toolArgs[0]).toMatchObject({ vendor: "dsh", role_tag: "container" })
    expect(h.kit.toolArgs[1]).toMatchObject({ task_ref: "sess-existing", parent_ref: "agent-1" })
    const log = logText(h.home)
    expect(log).toContain("加载期回填 1 个已存在的 agent 会话")
    expect(log).toContain("插件已加载")
    h.dispose()
  })

  it("ctx.agents 不可用或 list() 非数组时不抛错、不注册（尽力而为）", async () => {
    const h1 = await setup()
    h1.dispose()
    expect(h1.kit.toolArgs).toEqual([]) // 无 registry：零注册
    const h2 = await setup()
    h2.ctx.setRegistry({ list: "not-a-function" })
    h2.dispose()
    expect(h2.kit.toolArgs).toEqual([])
  })
})

// ── 真机撞名事故回归（10/1：DSH 会话 id 形如 `session-<uuid>`）────────────────

describe("会话命名与 name_taken 兜底", () => {
  it("同目录的两个 `session-<uuid>` 会话注册出**不同**名字（不再同为 `proj-session-`）", async () => {
    const h = await setup()
    const a = fakeAgent(sessionHeader("session-91fa2fb6-fbce-4b44-9853-4b5f738677b2"))
    const b = fakeAgent(sessionHeader("session-f79d9a5c-1111-2222-3333-444455556666"))
    h.on("agent/created")({ agent: a })
    h.on("agent/created")({ agent: b })
    const names = (): string[] =>
      h.kit.toolArgs.map((args) => String(args["name"])).filter((name) => name.startsWith("proj-"))
    expect(await waitUntil(() => names().length === 2)).toBe(true)
    expect(new Set(names()).size).toBe(2)
    // 修复前两者都是 `proj-session-`（`session-` 恰好 8 字符被 slice 吃掉）→ Hub 唯一索引拒绝第二个。
    expect(names()).not.toContain("proj-session-")
    expect(names()).toContain("proj-91fa2fb6")
  })

  it("Hub 回 `name_taken` 时不放弃：按短哈希后缀重试一次并注册成功", async () => {
    const h = await setup()
    // 第 1 次 `tools/call` 是根注册；第 2 次（首个会话）判为撞名，第 3 次（带后缀）成功。
    h.kit.onToolCall = (_args, index) =>
      index === 1 ? { text: "McpToolError: agent name already taken: proj-sess-1 [name_taken]", isError: true } : undefined
    const agent = fakeAgent(sessionHeader("sess-1"))
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-1"))).toBe(true)
    expect(h.kit.toolArgs).toHaveLength(3)
    expect(String(h.kit.toolArgs[2]?.["name"])).toMatch(/^proj-sess-1-[0-9a-f]{6}$/)
    expect(h.kit.toolArgs[2]?.["task_ref"]).toBe("sess-1")
    expect(logText(h.home)).toContain("已被占用，改用")
  })
})

// ── 补注册重试（10/1 真机：Hub 与 DSH 前后脚重启，注册失败后干等回合事件）────────────

describe("补注册重试", () => {
  it("Hub 不可达导致注册失败后，恢复时**无需任何回合事件**即自动补注册", async () => {
    const h = await setup({ pollMs: 1000, retryMs: 1000 })
    h.kit.failAll = true
    const agent = fakeAgent(sessionHeader("sess-retry"))
    h.on("agent/created")({ agent })
    // 第一次注册因 Hub 全 500 失败（4 次重试退避后落日志）。
    expect(await waitUntil(() => logText(h.home).includes("实例节点注册失败"), 20_000)).toBe(true)
    expect(registered(h.kit, "sess-retry")).toBe(false)
    h.kit.failAll = false
    // 关键：此后不再触发 agent/created / agent/status —— 只能靠 lib/retry.js 的定时器收敛。
    const recovered = await waitUntil(() => registered(h.kit, "sess-retry"), 20_000)
    if (!recovered) {
      console.error("[诊断] log=\n" + logText(h.home))
      console.error("[诊断] 请求数=" + h.kit.requests.length + " 路径样本=" + h.kit.requests.slice(-6).map((r) => r.path).join(","))
      console.error("[诊断] toolArgs=" + JSON.stringify(h.kit.toolArgs))
    }
    expect(recovered).toBe(true)
    expect(logText(h.home)).toContain("仍有 1 个会话未注册，稍后重试")
    expect(await waitUntil(() => logText(h.home).includes("会话提示 = "), 10_000)).toBe(true)
    h.dispose()
  })
})

// ── 空闲期取件（10/1 真机：注册先于任何回合 → 无 idle 跳变 → 消息永远排队）────────────

describe("登记即开轮询", () => {
  it("只发生 agent/created（宿主从未发过 idle 状态）时，空闲期消息仍会被轮询认领并注入", async () => {
    const h = await setup({ pollMs: 1000 })
    h.kit.onInternal = (path) =>
      path === "/internal/wake" ? { messages: [{ id: "m-idle", fromAgentId: "peer-1", body: "空闲期消息" }] } : undefined
    const agent = fakeAgent(sessionHeader("sess-idle"))
    // 关键：**只有 created**，不触发任何 agent/status。
    // 修复前 `ensurePolling` 只由 `agent/status=idle` 分支启动 → 该会话永远不会取件（真机「一直排队」）。
    h.on("agent/created")({ agent })
    expect(await waitUntil(() => registered(h.kit, "sess-idle"))).toBe(true)
    expect(await waitUntil(() => agent.followups.length === 1, 12_000)).toBe(true)
    expect(pathBodies(h.kit, "/internal/wake").length).toBeGreaterThan(0)
    const text = (agent.followups[0]!).content[0]?.text ?? ""
    expect(text).toContain("[m-idle]")
    h.dispose()
  })
})
