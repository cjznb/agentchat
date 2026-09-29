/**
 * Task 8 —— MCP 端点集成测试（brief DoD）：真实 MCP SDK 客户端连 `POST /mcp`（Bearer）。
 * ① `tools/list` 恰为锁定十二名 + 金样例过 `MCP_TOOL_INPUTS`
 * ② `send{wait}` 端到端：对方 core 回信 → 调用方在 wait 内解锁拿到 reply
 * ③ 错误契约：未知收件人 RecipientNotFound / 子 shout Forbidden / `to:'*'` use_shout_tool
 *    / 缺身份 identity_required / 无 Bearer 401
 * ④ `register` 首次 → join_token → 离线后再认领同 id 回 online
 * ⑤ Task 3：`ask`/`respond_ask` 端到端（human 与 agent 两答复路径）+ 错误码
 *    conversation_required / invalid_choice / ask_already_answered
 * 每个用例独立临时 $AGENTCHAT_HOME，真实监听 `start({port:0})`。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MCP_TOOL_INPUTS,
  MCP_TOOLS,
  MCP_TOOL_OUTPUTS,
  type McpToolName,
} from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { inbox, sendMessage } from "../../server/core/messaging"
import { ask, ensureHuman, respondAsk } from "../../server/core/permissions"
import { start, type RunningServer } from "../../server/index"
import { applyAgentState, ensureHubToken } from "../../server/routes/internal"
import { getAgent, insertAgent, type Agent } from "../../server/store/agents"
import { listApprovals } from "../../server/store/approvals"

/** 十二工具金样例（运行时注入真实 peer id 与可答复 ask id；键集合即「接线错误」检测基准）。 */
function goldenInputs(
  peerId: string,
  answerableAskId: string,
): Record<McpToolName, Record<string, unknown>> {
  return {
    register: { name: "golden-root", kind: "runtime", vendor: "opencode", model: "test" },
    send: { to: peerId, body: "hi" },
    inbox: { conversation: "c", after: 0, ack: true },
    ack: { message_ids: ["abcdef"] },
    roster: { filter: "golden", online_only: true },
    conversation: { id: "conv", before: 10, limit: 5 },
    group: { op: "create", name: "golden-group", member_ids: [] },
    shout: { body: "hello" },
    status: { text: "busy" },
    message_status: { ids: ["abcdef"] },
    ask: { to: "human", question: "golden ask?", options: ["yes", "no"], allow_custom: true },
    respond_ask: { ask_id: answerableAskId, choice: "yes" },
  }
}

let home = ""
let db: Db
let running: RunningServer
let token = ""

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentchat-mcp-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  token = ensureHubToken(join(home, "hub_token"))
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
})

afterEach(async () => {
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

async function connect(agentId?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        ...(agentId === undefined ? {} : { "x-agent-id": agentId }),
      },
    },
  })
  const client = new Client({ name: "mcp-test", version: "0.0.0" })
  // SDK 1.30 的 `Transport.sessionId` 可选性与 exactOptionalPropertyTypes 不兼容
  // （class getter 返回 `string | undefined`）—— 单点收窄，仅此一处。
  await client.connect(transport as Transport)
  return client
}

/** 带任意额外请求头的客户端（所有请求回带；用于逐调用身份头 `x-agentchat-session`）。 */
async function connectHeaders(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
  })
  const client = new Client({ name: "mcp-test", version: "0.0.0" })
  await client.connect(transport as Transport)
  return client
}

function callTool(client: Client, name: McpToolName, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

/** 裸 HTTP 建会话（返回 `mcp-session-id`），用于精确观测 404/TTL 行为。 */
async function initializeSession(): Promise<string> {
  const response = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    }),
  })
  await response.text() // 排空 SSE 流，避免连接悬挂
  const sessionId = response.headers.get("mcp-session-id")
  if (sessionId === null) throw new Error(`no session id (status ${response.status})`)
  return sessionId
}

/** 用既有 session id 发一个请求，返回 HTTP 状态码（未知/过期会话应为 404）。 */
async function probeSession(sessionId: string): Promise<number> {
  const response = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  })
  await response.text()
  return response.status
}

/** 裸 initialize 请求体（供**逐请求改头**的时序用例）。 */
function initializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw-timing", version: "0" },
    },
  }
}

/**
 * 裸 HTTP 往返（**可逐请求改头**）：SDK 客户端的 `requestInit.headers` 对同一连接的所有请求固定，
 * 无法复刻真实桥「initialize 不带会话头、随后的 tools/call 才带」的时序，故此处直接发原始请求。
 */
async function rawPost(
  body: unknown,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly sessionId: string | null; readonly text: string }> {
  const response = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text: await response.text() }
}

/** 从裸 MCP 响应体（JSON 或 SSE）取 JSON-RPC `result`（取最后一个含 `result` 的帧）。 */
function rawResult(text: string): unknown {
  const trimmed = text.trim()
  const frames = trimmed.includes("data:")
    ? trimmed
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [trimmed]
  for (const frame of frames.reverse()) {
    if (frame === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      continue
    }
    if (typeof parsed === "object" && parsed !== null && "result" in parsed) return parsed.result
  }
  throw new Error(`no JSON-RPC result in response: ${trimmed.slice(0, 200)}`)
}

/** 取工具结果的文本内容（`unknown` 入参 + 运行时收窄，避开 SDK 结果类型并集）。 */
function textOf(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("expected tool result with content")
  }
  const content: unknown = result.content
  if (!Array.isArray(content)) throw new Error("expected content array")
  const block: unknown = content[0]
  if (typeof block !== "object" || block === null || !("text" in block)) {
    throw new Error("expected text content block")
  }
  const text: unknown = block.text
  if (typeof text !== "string") throw new Error("expected text string")
  return text
}

function toolFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("isError" in result)) return false
  const value: unknown = result.isError
  return value === true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error("condition not met in time")
}

describe("tools/list 与十二工具金样例端到端（DoD ①，Important #1）", () => {
  it("advertises the contract schemas and executes every one of the twelve tools with its golden input", async () => {
    const actor = makeAgent("mcp-golden-actor")
    const peer = makeAgent("mcp-golden-peer")
    // 预置一条可答复 ask（peer → actor：actor 为 target），令 respond_ask 金样例有落点。
    sendMessage(db, { from: peer.id, to: actor.id, body: "seed-dm" })
    const seeded = ask(db, peer.id, { to: actor.id, question: "seeded?", options: ["yes", "no"] })
    const golden = goldenInputs(peer.id, seeded.ask.id)
    const client = await connect(actor.id)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOLS])

      // 金样例入参一律过 `MCP_TOOL_INPUTS`（契约单源；ask/respond_ask 为 Task 3 新增）。
      for (const name of MCP_TOOLS) {
        const parsedInput = MCP_TOOL_INPUTS[name].safeParse(golden[name])
        if (!parsedInput.success) {
          throw new Error(`${name} golden input violates the contract: ${parsedInput.error.message}`)
        }
      }

      // 广告 schema 接线校验：每个 object 工具的 properties 必须覆盖其金样例键
      // （若 conversation/roster 等被对调，键集即不匹配而失败）。
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      for (const name of MCP_TOOLS) {
        if (name === "group") continue // discriminatedUnion → SDK 广告为空对象 schema，见下条断言
        const advertised = Object.keys(byName.get(name)?.inputSchema.properties ?? {})
        expect({ name, advertised }).toEqual({
          name,
          advertised: expect.arrayContaining(Object.keys(golden[name])),
        })
      }
      // group 是 discriminatedUnion：SDK 无法对象化 → 广告空 properties，
      // 真正的联合校验由下面 `op:"create"` 正向 + 非法 `op` 反向调用端到端证明。
      expect(Object.keys(byName.get("group")?.inputSchema.properties ?? {})).toEqual([])

      // 逐一用金样例真调：任一 schema 接线错误或工具未执行都会在此暴露；
      // 出参一律过 `MCP_TOOL_OUTPUTS`（spec §13.5：出参契约集中在 shared/contracts）。
      for (const name of MCP_TOOLS) {
        const result = await callTool(client, name, golden[name])
        if (toolFailed(result)) throw new Error(`${name} rejected golden input: ${textOf(result)}`)
        const parsed = MCP_TOOL_OUTPUTS[name].safeParse(JSON.parse(textOf(result)))
        if (!parsed.success) {
          throw new Error(`${name} output violates the contract: ${parsed.error.message}`)
        }
      }
    } finally {
      await client.close()
    }
  })

  it("rejects an invalid group discriminant end-to-end (union is enforced, not a loose schema)", async () => {
    const actor = makeAgent("mcp-group-guard")
    const client = await connect(actor.id)
    try {
      const result = await callTool(client, "group", { op: "bogus" })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("Input validation error")
    } finally {
      await client.close()
    }
  })
})

describe("send{wait} 端到端（DoD ②）", () => {
  it("unlocks the blocked send when the peer replies in-thread", async () => {
    const sender = makeAgent("mcp-wait-sender")
    const peer = makeAgent("mcp-wait-peer")
    const client = await connect(sender.id)
    try {
      const pending = callTool(client, "send", {
        to: peer.id,
        body: "ping",
        wait: { until: "message", timeoutMs: 5000 },
      })
      await waitUntil(() => inbox(db, peer.id).some((m) => m.body === "ping"))
      sendMessage(db, { from: peer.id, to: sender.id, body: "pong" })

      const result = await pending
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
      expect(parsed.reply?.timedOut).toBe(false)
      expect(parsed.reply?.messages.map((m) => m.body)).toEqual(["pong"])
      expect(parsed.readReceipts).toEqual([])
    } finally {
      await client.close()
    }
  })
})

describe("ask/respond_ask 端到端（DoD ⑤）", () => {
  /** 轮询 pending ask 单（工具调用挂起期间单据已同步落库）。 */
  async function pendingAskId(): Promise<string> {
    let found: string | undefined
    await waitUntil(() => {
      found = listApprovals(db, "pending").find((approval) => approval.kind === "ask")?.id
      return found !== undefined
    })
    if (found === undefined) throw new Error("no pending ask")
    return found
  }

  it("unlocks the waiting ask when the human answers via core respondAsk", async () => {
    const actor = makeAgent("mcp-ask-human-actor")
    const client = await connect(actor.id)
    try {
      const pending = callTool(client, "ask", {
        to: "human",
        question: "deploy?",
        options: ["yes", "no"],
        wait: { until: "message", timeoutMs: 5000 },
      })
      const askId = await pendingAskId()
      respondAsk(db, askId, ensureHuman(db).id, { choice: "yes" })

      const result = await pending
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.ask.parse(JSON.parse(textOf(result)))
      if (!("ask" in parsed)) throw new Error("expected DM ask output, got group asks[]")
      expect(parsed.ask.status).toBe("answered")
      expect(parsed.reply?.timedOut).toBe(false)
      expect(parsed.reply?.choice).toBe("yes")
    } finally {
      await client.close()
    }
  })

  it("unlocks the waiting ask when the target agent responds with free text", async () => {
    const asker = makeAgent("mcp-ask-agent-asker")
    const target = makeAgent("mcp-ask-agent-target")
    sendMessage(db, { from: asker.id, to: target.id, body: "seed-dm" })
    const clientA = await connect(asker.id)
    const clientB = await connect(target.id)
    try {
      const pending = callTool(clientA, "ask", {
        to: target.id,
        question: "which?",
        options: ["a", "b"],
        wait: { until: "message", timeoutMs: 5000 },
      })
      const askId = await pendingAskId()
      const answered = await callTool(clientB, "respond_ask", { ask_id: askId, text: "custom" })
      expect(toolFailed(answered)).toBe(false)
      const decided = MCP_TOOL_OUTPUTS.respond_ask.parse(JSON.parse(textOf(answered)))
      expect(decided.status).toBe("answered")
      expect(decided.result?.["text"]).toBe("custom")

      const result = await pending
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.ask.parse(JSON.parse(textOf(result)))
      if (!("ask" in parsed)) throw new Error("expected DM ask output, got group asks[]")
      expect(parsed.reply?.timedOut).toBe(false)
      expect(parsed.reply?.text).toBe("custom")
    } finally {
      await clientB.close()
      await clientA.close()
    }
  })
})

describe("ask/respond_ask 错误契约（DoD ⑤）", () => {
  it("maps conversation_required when the ask target shares no conversation", async () => {
    const actor = makeAgent("mcp-ask-noconv-actor")
    const stranger = makeAgent("mcp-ask-noconv-stranger")
    const client = await connect(actor.id)
    try {
      const result = await callTool(client, "ask", { to: stranger.id, question: "q", options: [] })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("conversation_required")
    } finally {
      await client.close()
    }
  })

  it("maps invalid_choice then ask_already_answered on a second answer", async () => {
    const asker = makeAgent("mcp-ask-err-asker")
    const target = makeAgent("mcp-ask-err-target")
    sendMessage(db, { from: asker.id, to: target.id, body: "seed-dm" })
    const seeded = ask(db, asker.id, { to: target.id, question: "pick?", options: ["a", "b"] })
    const client = await connect(target.id)
    try {
      const bad = await callTool(client, "respond_ask", { ask_id: seeded.ask.id, choice: "zzz" })
      expect(toolFailed(bad)).toBe(true)
      expect(textOf(bad)).toContain("invalid_choice")

      const ok = await callTool(client, "respond_ask", { ask_id: seeded.ask.id, choice: "a" })
      expect(toolFailed(ok)).toBe(false)

      const again = await callTool(client, "respond_ask", { ask_id: seeded.ask.id, choice: "b" })
      expect(toolFailed(again)).toBe(true)
      expect(textOf(again)).toContain("ask_already_answered")
    } finally {
      await client.close()
    }
  })
})

describe("错误契约（DoD ③）", () => {
  it("turns RecipientNotFound, use_shout_tool and missing identity into tool errors", async () => {
    const sender = makeAgent("mcp-err-sender")
    const client = await connect(sender.id)
    try {
      const missing = await callTool(client, "send", { to: "no-such-agent", body: "x" })
      expect(toolFailed(missing)).toBe(true)
      expect(textOf(missing)).toContain("RecipientNotFound")

      const broadcast = await callTool(client, "send", { to: "*", body: "x" })
      expect(toolFailed(broadcast)).toBe(true)
      expect(textOf(broadcast)).toContain("use_shout_tool")
    } finally {
      await client.close()
    }

    const anonymous = await connect()
    try {
      const result = await callTool(anonymous, "inbox", {})
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("identity_required")
    } finally {
      await anonymous.close()
    }
  })

  it("forbids a child agent from shouting", async () => {
    const root = makeAgent("mcp-forbid-root")
    const child = insertAgent(db, {
      name: "mcp-forbid-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: root.id,
    })
    const client = await connect(child.id)
    try {
      const result = await callTool(client, "shout", { body: "hi" })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("Forbidden")
    } finally {
      await client.close()
    }
  })

  it("rejects a request without the hub bearer token with 401", async () => {
    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "anon", version: "0" },
        },
      }),
    })
    expect(response.status).toBe(401)
  })
})

describe("register 首次与认领（DoD ④）", () => {
  it("registers a root, returns a join_token, then claims the same id back to online", async () => {
    const client = await connect()
    try {
      const first = MCP_TOOL_OUTPUTS.register.parse(
        JSON.parse(
          textOf(
            await callTool(client, "register", { name: "mcp-first-root", vendor: "opencode" }),
          ),
        ),
      )
      if (first.join_token === undefined) throw new Error("register did not return join_token")
      expect(applyAgentState(db, { agentId: first.agent.id, state: "offline" })).toEqual({ ok: true })
      expect(getAgent(db, first.agent.id)?.status).toBe("offline")

      const second = MCP_TOOL_OUTPUTS.register.parse(
        JSON.parse(
          textOf(
            await callTool(client, "register", {
              name: "mcp-first-root",
              vendor: "opencode",
              join_token: first.join_token,
            }),
          ),
        ),
      )
      expect(second.agent.id).toBe(first.agent.id)
      expect(getAgent(db, first.agent.id)?.status).toBe("online")
    } finally {
      await client.close()
    }
  })
  it("claims without a name and keeps the generated vendor-model-hex name (Claude SessionStart)", async () => {
    const client = await connect()
    try {
      const first = MCP_TOOL_OUTPUTS.register.parse(
        JSON.parse(
          textOf(await callTool(client, "register", { vendor: "claude-code", purpose: "coding-agent" })),
        ),
      )
      // 新建未提供 name → core 生成 `vendor-model-hex` 兜底名（MCP 层不再注入随机名）。
      expect(first.agent.name).toMatch(/^claude-code-unknown-[0-9a-f]{4}$/)
      if (first.join_token === undefined) throw new Error("register did not return join_token")

      const second = MCP_TOOL_OUTPUTS.register.parse(
        JSON.parse(
          textOf(
            await callTool(client, "register", {
              vendor: "claude-code",
              purpose: "coding-agent",
              join_token: first.join_token,
            }),
          ),
        ),
      )
      // 不带 name 的认领**不得**改名（Part 1 之前的认领路径语义）。
      expect(second.agent.id).toBe(first.agent.id)
      expect(second.agent.name).toBe(first.agent.name)

      const third = MCP_TOOL_OUTPUTS.register.parse(
        JSON.parse(
          textOf(
            await callTool(client, "register", {
              vendor: "claude-code",
              purpose: "coding-agent",
              join_token: first.join_token,
              name: "mcp-renamed",
            }),
          ),
        ),
      )
      // 带 name 的认领照常改名（既有语义）。
      expect(third.agent.name).toBe("mcp-renamed")
      expect(getAgent(db, first.agent.id)?.name).toBe("mcp-renamed")
    } finally {
      await client.close()
    }
  })
})

describe("出站身份按会话归属（M2：x-agentchat-session）", () => {
  /** 容器（实例节点）+ 其会话子节点，模拟 OpenCode 的层级。 */
  function containerWithSession(): { readonly box: Agent; readonly session: Agent } {
    const box = insertAgent(db, {
      name: `m2-container-${Math.random().toString(16).slice(2)}`,
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      roleTag: "container",
    })
    const session = insertAgent(db, {
      name: `m2-session-${Math.random().toString(16).slice(2)}`,
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: box.id,
      taskRef: `sess-${Math.random().toString(16).slice(2)}`,
    })
    return { box, session }
  }

  it("resolves a session header to the session node (ignoring x-agent-id=container)", async () => {
    const { box, session } = containerWithSession()
    const peer = makeAgent("m2-peer")
    // 两个身份头并存：会话头优先 —— 发送方必须是会话节点，绝非容器。
    const client = await connectHeaders({
      "x-agent-id": box.id,
      "x-agentchat-session": session.taskRef ?? "",
    })
    try {
      const result = await callTool(client, "send", { to: peer.id, body: "hi" })
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
      expect(parsed.message.fromAgentId).toBe(session.id)
      expect(parsed.message.fromAgentId).not.toBe(box.id)
    } finally {
      await client.close()
    }
  })

  it("omits identity (never falls back to the container) when the session header is unresolved", async () => {
    const { box } = containerWithSession()
    const client = await connectHeaders({
      "x-agent-id": box.id,
      "x-agentchat-session": "no-such-session",
    })
    try {
      const result = await callTool(client, "send", { to: box.id, body: "x" })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("identity_required")
    } finally {
      await client.close()
    }
  })

  it("keeps the legacy x-agent-id behavior unchanged when no session header is present", async () => {
    const sender = makeAgent("m2-legacy-sender")
    const peer = makeAgent("m2-legacy-peer")
    const client = await connect(sender.id)
    try {
      const result = await callTool(client, "send", { to: peer.id, body: "hi" })
      const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
      expect(parsed.message.fromAgentId).toBe(sender.id)
    } finally {
      await client.close()
    }
    // 无会话头 + 陈旧 x-agent-id ⇒ 仍 400 agent_not_found（既有行为）。
    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-agent-id": "no-such-agent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      }),
    })
    await response.text()
    expect(response.status).toBe(400)
  })

  /**
   * **真实桥时序**（评审 Important #2）：桥的 `ensureSession` 的 `initialize` **从不带**会话头，
   * 会话头只在随后的 `tools/call` 上（插件注入 → 桥剥离入参后转请求头）。故只有 `routes/mcp.ts`
   * 的**逐请求重解析**分支（`session.ctx.agentId`，`:131` 附近）能让 M2 生效 —— 删掉该分支，
   * 身份会停留在 initialize 时的容器、本用例即失败。
   */
  it("re-resolves identity on a later tools/call session header (real bridge timing; fails without per-request re-resolution)", async () => {
    const { box, session } = containerWithSession()
    const peer = makeAgent("m2-timing-peer")

    // ① initialize **不带**会话头 → 身份 = `x-agent-id`（容器）。真实桥的 ensureSession 即如此。
    const init = await rawPost(initializeMessage(), { "x-agent-id": box.id })
    expect(init.status).toBe(200)
    if (init.sessionId === null) throw new Error("initialize returned no mcp-session-id")
    const base = { "mcp-session-id": init.sessionId, "x-agent-id": box.id }
    await rawPost({ jsonrpc: "2.0", method: "notifications/initialized" }, base)

    // 固化敏感点：此刻身份是**容器、不是会话节点**（`status` 工具回带自身 id）。
    const before = await rawPost(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { text: "init" } } },
      base,
    )
    const beforeStatus = MCP_TOOL_OUTPUTS.status.parse(JSON.parse(textOf(rawResult(before.text))))
    expect(beforeStatus.id).toBe(box.id)
    expect(beforeStatus.id).not.toBe(session.id)

    // ② 同一 mcp-session-id 随后发 tools/call **带**会话头（复刻桥剥离入参后转的请求头）。
    const call = await rawPost(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send", arguments: { to: peer.id, body: "hi" } },
      },
      { ...base, "x-agentchat-session": session.taskRef ?? "" },
    )
    expect(call.status).toBe(200)
    const result = rawResult(call.text)
    expect(toolFailed(result)).toBe(false)
    // ③ 发送方 = **会话节点**（不是容器）：删掉逐请求重解析分支即回落容器身份而失败。
    const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
    expect(parsed.message.fromAgentId).toBe(session.id)
    expect(parsed.message.fromAgentId).not.toBe(box.id)
  })
})

describe("会话 TTL 淘汰（Important #2）", () => {
  it("evicts idle sessions after the TTL and rejects reuse of both with 404", async () => {
    await running.close()
    running = await start({
      port: 0,
      db,
      home,
      hubTokenPath: join(home, "hub_token"),
      sessionTtlMs: 80,
    })

    const first = await initializeSession()
    const second = await initializeSession()
    expect(first).not.toBe(second)

    await delay(150) // 两个会话均闲置超过 80ms

    // 首个探测触发惰性清扫：两台空闲会话被回收，旧 id 一律 404（map 大小归零）。
    expect(await probeSession(first)).toBe(404)
    expect(await probeSession(second)).toBe(404)
  })
})
