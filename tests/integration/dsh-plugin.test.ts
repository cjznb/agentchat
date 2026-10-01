/**
 * DSH 适配器插件 ↔ **真 Hub** 端到端集成测试（`adapters/dsh/index.js` 的 `apply`）。
 * 启动真实 Hub（`server/index.ts` `start({port:0})` + 真实路由/store），只把 DSH 宿主
 * （`Context` 与 `agent`）做成假对象 —— 即「适配器 ↔ Hub」这条真实契约；`adapters/dsh`
 * 作为进程外 bundle 不 import 本仓 server 代码，但测试代码可同时 import 两侧。
 *
 * 断言（均为对真 Hub 的可观察状态，不是 mock 调用计数）：
 * ① `agent/created` → roster API 出现会话子节点（vendor=dsh、挂在 container 实例节点下、名唯一）
 * ② 消息先排队、再驱动 `idle` → `followup` 恰一条（含消息 id 与正文），未用 `steer`
 * ③ 该消息的 `wake_jobs` 落 `accepted`（= `pull-lease.test.ts` 同款可观察量）
 * ④ 回执落定后再取件一次：绝不二次注入（`followup` 计数恒为 1）
 * ⑤ `running` 期间认领的交付走 `steer`（见该 describe 的说明）
 * ⑥ `agent/disposed` **不退役**：节点仍在 roster，且同 `task_ref` 可再次注册（同一个 Hub id）
 *
 * 隔离：不用 `child_process`、不连外部网络（仅 127.0.0.1）、无真实 LLM；
 * `HUB_TOKEN`/`AGENTCHAT_HOME`/`AGENTCHAT_URL` 指向本用例临时 Hub 并在 `afterEach` 还原。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { hostname, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RosterNode } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { getAgent } from "../../server/store/agents"
import { getById } from "../../server/store/messages"
import { getWakeJob } from "../../server/store/wake"

// ── 假 DSH 宿主（Context + agent）───────────────────────────────────────────

type Listener = (payload: unknown) => void

interface FakeCtx {
  readonly listeners: Map<string, Listener>
  readonly disposers: Array<() => void>
  ctx: {
    on(name: string, listener: Listener): void
    effect(callback: () => () => void, label?: string): void
    logger: { warn(message: string): void }
  }
}

function fakeContext(): FakeCtx {
  const listeners = new Map<string, Listener>()
  const disposers: Array<() => void> = []
  return {
    listeners,
    disposers,
    ctx: {
      on: (name, listener) => void listeners.set(name, listener),
      effect: (callback) => void disposers.push(callback()),
      logger: { warn: () => {} },
    },
  }
}

interface FakeAgent {
  readonly session: { readonly header: Record<string, unknown> }
  readonly followups: unknown[]
  readonly steers: unknown[]
  followup(message: unknown): void
  steer(message: unknown): void
}

function fakeAgent(sessionId: string, dir: string, extra: Record<string, unknown> = {}): FakeAgent {
  const followups: unknown[] = []
  const steers: unknown[] = []
  return {
    session: { header: { version: 1, id: sessionId, createdAt: "2026-01-01T00:00:00.000Z", cwd: dir, ...extra } },
    followups,
    steers,
    followup: (message) => void followups.push(message),
    steer: (message) => void steers.push(message),
  }
}

/** 注入消息文本：`{content:[{type:'text',text}]}`（与降级的最小 UserMessage 同形）。 */
function textOf(message: unknown): string {
  const content = (message as { readonly content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) throw new Error(`注入消息无 content 数组：${JSON.stringify(message)}`)
  const block = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("注入消息首块不是文本")
  return block.text
}

function flatten(nodes: readonly RosterNode[]): RosterNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

// ── 真 Hub 脚手架 ───────────────────────────────────────────────────────────

let home = ""
let db: Db
let running: RunningServer
let token = ""
let ctx: FakeCtx
let agent: FakeAgent
let workdir = ""
let sessionId = ""
let client: Client
let instanceId = ""
let sessionNodeId = ""
/** 本地中继：把插件请求转发给真 Hub；`holdStates` 拦下 `/internal/state` 直至放行。 */
interface Relay {
  readonly url: string
  holdStates(): void
  releaseStates(): void
  close(): Promise<void>
}
const relays: Relay[] = []
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["AGENTCHAT_HOME", "HUB_TOKEN", "AGENTCHAT_URL", "AGENTCHAT_PORT", "AGENTCHAT_POLL_MS"]

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  home = mkdtempSync(join(tmpdir(), "agentchat-dsh-int-"))
  workdir = mkdtempSync(join(tmpdir(), "agentchat-dsh-cwd-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  token = ensureHubToken(join(home, "hub_token"))
  // 真实路由 + 真实 store；不启 dispatcher（pull 取件由插件经 /internal/wake 自行认领）。
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token"), adapters: [] })
  process.env["AGENTCHAT_HOME"] = home
  process.env["HUB_TOKEN"] = token // 优先读 HUB_TOKEN（留空则回落 <home>/hub_token）
  process.env["AGENTCHAT_URL"] = running.url
  delete process.env["AGENTCHAT_PORT"]
  delete process.env["AGENTCHAT_POLL_MS"]
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  client = new Client({ name: "dsh-plugin-test", version: "0.0.0" })
  await client.connect(transport as Transport)
})

afterEach(async () => {
  for (const disposer of ctx?.disposers ?? []) disposer()
  for (const relay of relays.splice(0)) await relay.close()
  await client?.close().catch(() => undefined)
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 加载**真实插件模块**并 `apply`（读 process.env 指向上面启动的真 Hub / 中继）。 */
async function applyPlugin(pollMs: number, hubUrl = running.url): Promise<void> {
  process.env["AGENTCHAT_URL"] = hubUrl
  ctx = fakeContext()
  const mod = (await import("../../adapters/dsh/index.js")) as {
    apply(context: unknown, config?: unknown): void
  }
  mod.apply(ctx.ctx, { pollMs })
}

async function roster(): Promise<RosterNode[]> {
  return (await (await fetch(`${running.url}/api/roster`)).json()) as RosterNode[]
}

/** roster 是唯一权威：轮询直到目标节点出现（插件注册是 fire-and-forget）。 */
async function waitForNode(name: string): Promise<RosterNode> {
  let found: RosterNode | undefined
  let seen = ""
  await vi.waitFor(async () => {
    const nodes = await roster()
    seen = JSON.stringify(nodes.map((node) => [node.name, node.vendor]))
    found = flatten(nodes).find((node) => node.name === name)
    expect(found, `roster=${seen}`).toBeDefined()
  }, { timeout: 10_000, interval: 25 })
  if (found === undefined) throw new Error(`roster 中始终没有节点 ${name}（见 ${seen}）`)
  return found
}

/** 触发 `agent/created` 并等它出现在 roster；填好会话/实例节点 id。 */
async function emitCreated(): Promise<RosterNode> {
  ctx.listeners.get("agent/created")?.({ agent })
  const node = await waitForNode(`${basename(workdir)}-${sessionId.slice(0, 8)}`)
  sessionNodeId = node.id
  instanceId = node.parent_id ?? ""
  return node
}

/** 触发宿主的 `agent/status`（插件据此切 busy 并停轮询、或启动空闲轮询）。 */
function emitStatus(status: "idle" | "running"): void {
  ctx.listeners.get("agent/status")?.({ agent, status })
}

/** 取工具结果文本（`register`/`send` 均返回 `{content:[{text}]}`）。 */
function toolText(result: unknown): string {
  const content = (result as { readonly content?: unknown }).content
  if (!Array.isArray(content)) throw new Error("工具结果无 content")
  const text = (content[0] as { readonly text?: unknown }).text
  if (typeof text !== "string") throw new Error("工具结果首块无文本")
  return text
}

/** peer 走真 MCP 契约：`register` 认领身份，再以该身份 `send` 一条直达 DSH 会话节点的消息。 */
async function peerMessage(name: string, body: string): Promise<{ peerId: string; messageId: string }> {
  const registered = toolText(await client.callTool({ name: "register", arguments: { name, vendor: "opencode" } }))
  const peerId = (JSON.parse(registered) as { agent?: { id?: unknown } }).agent?.id
  if (typeof peerId !== "string") throw new Error(`register 未返回 agent id：${registered}`)
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "x-agent-id": peerId } },
  })
  const sender = new Client({ name: "dsh-plugin-peer", version: "0.0.0" })
  await sender.connect(transport as Transport)
  try {
    const text = toolText(await sender.callTool({ name: "send", arguments: { to: sessionNodeId, body } }))
    const messageId = (JSON.parse(text) as { message?: { id?: unknown } }).message?.id
    if (typeof messageId !== "string") throw new Error(`send 未返回 message id：${text}`)
    return { peerId, messageId }
  } finally {
    await sender.close()
  }
}

/** 直达真 Hub 的取件端点（断言「回执落定后不再投递」的可观察量）。 */
async function wake(): Promise<{ messages: unknown[] }> {
  const response = await fetch(`${running.url}/internal/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: sessionNodeId }),
  })
  return (await response.json()) as { messages: unknown[] }
}

/** 本地中继：把插件请求转发给真 Hub，`holdStates` 拦下 `/internal/state` 直至放行。 */
async function startRelay(target: string): Promise<Relay> {
  let holding = false
  let open: Promise<void> | undefined
  let release: (() => void) | undefined
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      void (async () => {
        if (holding && request.url === "/internal/state") await (open ?? Promise.resolve())
        const upstream = await fetch(`${target}${request.url ?? "/"}`, {
          method: request.method ?? "POST",
          headers: { ...(request.headers as Record<string, string>), host: new URL(target).host },
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
        })
        const text = await upstream.text()
        const session = upstream.headers.get("mcp-session-id")
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          ...(session === null ? {} : { "mcp-session-id": session }),
        })
        response.end(text)
      })().catch((error: unknown) => {
        response.writeHead(502, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: String(error) }))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("中继未分配端口")
  return {
    url: `http://127.0.0.1:${address.port}`,
    holdStates() {
      holding = true
      open = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    releaseStates() {
      holding = false
      const done = release
      release = undefined
      open = undefined
      done?.()
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// ── ① 注册：roster API 观测层级、vendor、唯一名、容器角色 ───────────────────

describe("agent/created → 真 Hub roster", () => {
  it("会话节点出现在 roster、挂在 container 实例节点下、vendor=dsh 且名字唯一", async () => {
    await applyPlugin(1000)
    sessionId = "dsh-session-1"
    agent = fakeAgent(sessionId, workdir)
    const node = await emitCreated()
    expect(node.vendor).toBe("dsh")
    expect(node.kind).toBe("runtime")
    expect(node.parent_id).toBe(instanceId)
    expect(node.parent_id).not.toBe(null)

    const nodes = await roster()
    const tree = flatten(nodes)
    const instance = tree.find((entry) => entry.id === instanceId)
    // 实例节点是分组容器（role_tag=container），会话节点是它的子节点；名字整树唯一。
    expect(instance?.role_tag).toBe("container")
    expect(instance?.name).toBe(hostname() === "" ? "dsh" : `dsh@${hostname()}`)
    expect(instance?.children.map((child) => child.id)).toContain(node.id)
    expect(tree.filter((entry) => entry.name === node.name)).toHaveLength(1)
    expect(node.name).toBe(`${basename(workdir)}-${sessionId.slice(0, 8)}`)
    expect(node.status).toBe("online") // 注册后紧跟一次 /internal/state
  })
})

// ── ②③④ 空闲注入、唤醒任务落定、重复取件不二次注入 ─────────────────────────

describe("idle 取件闭环 → followup + wake_job accepted + 不重复注入", () => {
  it("消息先排队；idle 后 followup 恰一条（含 message id 与正文）；job 落 accepted；再取件不重投", async () => {
    await applyPlugin(1000)
    sessionId = "dsh-session-1"
    agent = fakeAgent(sessionId, workdir)
    await emitCreated()

    const body = "来自 peer 的正文"
    const { peerId, messageId } = await peerMessage("dsh-peer", body)
    // ② 尚未 idle：无任何注入（消息在 Hub 侧排队，不是被 mock 收走的）。
    expect(agent.followups).toHaveLength(0)
    expect(agent.steers).toHaveLength(0)
    const seq = getById(db, messageId)?.seq
    if (seq === undefined) throw new Error("消息未入库")
    expect(getWakeJob(db, seq, sessionNodeId)?.state).toBe("pending")

    emitStatus("idle") // 插件先拉一次积压（与轮询同一 flush 路径），随后启动空闲轮询
    await vi.waitFor(() => {
      expect(agent.followups).toHaveLength(1)
    }, { timeout: 10_000, interval: 20 })

    // 恰一条注入，文本含 peer 消息 id、正文与来源 id；未走 steer。
    expect(agent.steers).toHaveLength(0)
    const injected = textOf(agent.followups[0])
    expect(injected).toContain(`[${messageId}]`)
    expect(injected).toContain(body)
    expect(injected).toContain(peerId)

    // ③ 真 Hub 的唤醒状态机落定：回执被理解（job accepted）。
    await vi.waitFor(() => {
      expect(getWakeJob(db, seq, sessionNodeId)?.state).toBe("accepted")
    }, { timeout: 10_000, interval: 20 })

    // ④ 回执落定后再取件：没有可投递消息 → 绝不二次注入。
    expect((await wake()).messages).toEqual([])
    expect(agent.followups).toHaveLength(1)
    expect(agent.steers).toHaveLength(0)
  })
})

// ── ⑤ running 期间认领的交付 → steer ────────────────────────────────────────

/**
 * `steer` 分支只在**认领已发生、而状态在同一轮 flush 之内翻成 running** 时可达
 * （`flush` 先 heartbeat 后 wake；插件在 running 时停轮询，此后不会再有轮询取件）。
 * 这里用本地中继拦住那条真实 `/internal/state`，把「在途 flush」窗口做成确定性的；
 * 其余请求（register 的 MCP 握手、wake、result）仍原样打到真 Hub。
 */
describe("busy 语义：running 期间认领的交付走 steer", () => {
  it("agent/status running 时在途取件的消息经 steer 注入，而非 followup", async () => {
    const relay = await startRelay(running.url)
    relays.push(relay)
    await applyPlugin(1000, relay.url)
    sessionId = "dsh-session-1"
    agent = fakeAgent(sessionId, workdir)
    await emitCreated()

    const body = "运行中到达的急件"
    const { messageId } = await peerMessage("dsh-busy-peer", body)
    const seq = getById(db, messageId)?.seq
    if (seq === undefined) throw new Error("消息未入库")

    // 拦住本轮 flush 的心跳：wake 必须等它返回，于是「认领」与「交付」之间出现窗口，
    // 在窗口内把状态翻成 running —— 交付落定时 entry.busy=true → steer。
    relay.holdStates()
    emitStatus("idle")
    emitStatus("running")
    relay.releaseStates()

    await vi.waitFor(() => {
      // 先确认确实发生了注入（无论哪条通道），再断言通道：必须走 steer。
      expect(agent.steers.length + agent.followups.length).toBe(1)
      expect(agent.steers).toHaveLength(1)
    }, { timeout: 10_000, interval: 20 })

    expect(agent.followups).toHaveLength(0)
    const injected = textOf(agent.steers[0])
    expect(injected).toContain(`[${messageId}]`)
    expect(injected).toContain(body)
    await vi.waitFor(() => {
      expect(getWakeJob(db, seq, sessionNodeId)?.state).toBe("accepted")
    }, { timeout: 10_000, interval: 20 })
  })
})

// ── ⑥ disposed 不退役 ───────────────────────────────────────────────────────

it("agent/disposed 后节点保留在 roster，且同 task_ref 再次注册仍被 Hub 接受（同一 id）", async () => {
  await applyPlugin(1000)
  sessionId = "dsh-session-1"
  agent = fakeAgent(sessionId, workdir)
  await emitCreated()
  const originalId = sessionNodeId
  ctx.listeners.get("agent/disposed")?.({ agent })

  // 节点仍在 roster 且未退役（插件绝不发 /internal/retire）。
  const after = flatten(await roster()).find((node) => node.id === originalId)
  expect(after?.status).not.toBe("retired")
  expect(getAgent(db, originalId)?.status).not.toBe("retired")

  // 再注册同一 task_ref 被接受：Hub 的 registerChild 按 task_ref **收养**既有节点
  // （已退役节点会抛 RegistrationError("retired") —— 这正是「不退役」的理由）。
  const adopted = toolText(await client.callTool({
    name: "register",
    arguments: { vendor: "dsh", name: after?.name ?? "", parent_ref: instanceId, task_ref: sessionId },
  }))
  expect((JSON.parse(adopted) as { agent?: { id?: unknown } }).agent?.id).toBe(originalId)
  expect(getAgent(db, originalId)?.status).not.toBe("retired")
  // 诊断只落文件：disposed 走的是「停跟踪、节点保留」那条路。
  await vi.waitFor(() => {
    expect(readFileSync(join(home, "logs", "dsh-adapter.log"), "utf8")).toContain("停止跟踪")
  }, { timeout: 5000, interval: 20 })
})
