/**
 * Task 8 —— MCP 端点集成测试（brief DoD）：真实 MCP SDK 客户端连 `POST /mcp`（Bearer）。
 * ① `tools/list` 恰为锁定工具名 + 金样例过 `MCP_TOOL_INPUTS`
 * ② `send{wait}` 端到端：对方 core 回信 → 调用方在 wait 内解锁拿到 reply
 * ③ 错误契约：未知收件人 RecipientNotFound / 子 shout Forbidden / `to:'*'` use_shout_tool
 *    / 缺身份 identity_required / 无 Bearer 401
 * ④ `register` 首次 → join_token → 离线后再认领同 id 回 online
 * ⑤ Task 3：`ask`/`respond_ask` 端到端（human 与 agent 两答复路径）+ 错误码
 *    conversation_required / invalid_choice / ask_already_answered
 * ⑥ Task 4：群 ask 出参 `asks[]` 判别 + mentions_required / mention_not_found /
 *    mention_not_participant 三错误码
 * ⑦ Task 5：`roster{conversation}` 只返回群成员（非成员 not_participant、shout 空）+
 *    `group op:list` 增 `member_cards`（`members` 形状不变）+ `group op:add` 入群
 *    `kind:"system"` 通知（含名单、0 wake job）
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
import { createGroup, inbox, sendMessage } from "../../server/core/messaging"
import { ask, ensureHuman, respondAsk } from "../../server/core/permissions"
import { start, type RunningServer } from "../../server/index"
import { applyAgentState, ensureHubToken } from "../../server/routes/internal"
import { getAgent, insertAgent, renameAgent, type Agent } from "../../server/store/agents"
import { listApprovals } from "../../server/store/approvals"
import { ensureShoutConversation } from "../../server/store/conversations"

/** 全部工具金样例（运行时注入真实 peer id、可答复 ask id 与成员会话 id；键集合即「接线错误」检测基准）。 */
function goldenInputs(
  peerId: string,
  answerableAskId: string,
  rosterConversationId: string,
): Record<McpToolName, Record<string, unknown>> {
  return {
    register: { name: "golden-root", kind: "runtime", vendor: "opencode", model: "test" },
    send: { to: peerId, body: "hi" },
    inbox: { conversation: "c", after: 0, ack: true },
    ack: { message_ids: ["abcdef"] },
    roster: { filter: "golden", online_only: true, conversation: rosterConversationId },
    conversation: { id: "conv", before: 10, limit: 5 },
    group: { op: "create", name: "golden-group", member_ids: [] },
    shout: { body: "hello" },
    status: { text: "busy" },
    message_status: { ids: ["abcdef"] },
    ask: { to: "human", question: "golden ask?", options: ["yes", "no"], allow_custom: true },
    respond_ask: { ask_id: answerableAskId, choice: "yes" },
    whoami: {},
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

describe("tools/list 与全部工具金样例端到端（DoD ①，Important #1）", () => {
  it("advertises the contract schemas and executes every tool with its golden input", async () => {
    const actor = makeAgent("mcp-golden-actor")
    const peer = makeAgent("mcp-golden-peer")
    // 预置一条可答复 ask（peer → actor：actor 为 target），令 respond_ask 金样例有落点。
    sendMessage(db, { from: peer.id, to: actor.id, body: "seed-dm" })
    const seeded = ask(db, peer.id, { to: actor.id, question: "seeded?", options: ["yes", "no"] })
    // 预置一个 actor 所在的群，令 `roster{conversation}` 金样例过成员闸门（Task 5）。
    const human = ensureHuman(db)
    const rosterGroup = createGroup(db, {
      name: "golden-roster-group",
      createdBy: human.id,
      memberIds: [actor.id],
    })
    if (!("approved" in rosterGroup)) throw new Error("human group creation must execute immediately")
    const golden = goldenInputs(peer.id, seeded.ask.id, rosterGroup.approved.id)
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
      // 契约回归锁（修复轮 E）：tools/list 逐工具必须广告非空 properties，
      // 且 group 必须露出 op 枚举与三分支全部字段（拍平平铺 schema，
      // 禁止 discriminatedUnion 空壳：`{"type":"object","properties":{}}`）。
      for (const name of MCP_TOOLS) {
        const properties = byName.get(name)?.inputSchema.properties ?? {}
        expect({ name, keys: Object.keys(properties) }).toEqual({
          name,
          keys: expect.arrayContaining(Object.keys(golden[name])),
        })
        // 无参工具（金样例为空对象，如 `whoami`）合法地广告 `properties: {}`；
        // 该锁只用于揪「有参工具被拍平成空壳 schema」的接线错误。
        if (Object.keys(golden[name]).length > 0) {
          expect({ name, propertyCount: Object.keys(properties).length > 0 }).toEqual({
            name,
            propertyCount: true,
          })
        }
      }
      const groupProps = byName.get("group")?.inputSchema.properties ?? {}
      expect(groupProps["op"]).toMatchObject({ enum: ["create", "add", "list"] })
      expect(Object.keys(groupProps)).toEqual(
        expect.arrayContaining(["op", "name", "member_ids", "group", "member"]),
      )

      // 反寒暄规则进工具描述（spec §15.5 落点 ②）：send / shout 描述须含规则关键词。
      for (const name of ["send", "shout"] as const) {
        const description = byName.get(name)?.description ?? ""
        expect({ name, keyword: description.includes("信息增量") }).toEqual({ name, keyword: true })
        expect(description).toContain("禁纯回执")
      }

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

describe("send mentions 回显（Task 3，spec §3.2 宽容回显）", () => {
  it("group send echoes matched/unmatched/scope; an unmatched @错字 does not block the send", async () => {
    const human = ensureHuman(db)
    const actor = makeAgent("mcp-mentions-actor")
    const peer = makeAgent("mcp-mentions-peer")
    const group = createGroup(db, {
      name: "mcp-mentions-group",
      createdBy: human.id,
      memberIds: [actor.id, peer.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")
    const client = await connect(actor.id)
    try {
      const hit = await callTool(client, "send", {
        to: group.approved.id,
        body: `@${peer.name} 请评估`,
      })
      expect(toolFailed(hit)).toBe(false)
      expect(MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(hit))).mentions).toEqual({
        matched: [{ id: peer.id, name: peer.name }],
        unmatched: [],
        scope: "explicit",
      })

      const typo = await callTool(client, "send", {
        to: group.approved.id,
        body: "@拼错的名字 在吗",
      })
      expect(toolFailed(typo)).toBe(false) // 宽容：未命中不阻断发送（spec §3.2）
      const echo = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(typo))).mentions
      expect(echo?.matched).toEqual([])
      expect(echo?.unmatched).toEqual(["拼错的名字"])
      expect(echo?.scope).toBe("explicit")
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

describe("群 ask 出参与错误码（Task 4，spec §3.2/§3.3）", () => {
  /** human 建群（即时执行）：成员 = actor + peer，发起方 actor 经 MCP 发起群 ask。 */
  function seedGroup(actor: Agent, peer: Agent, name: string) {
    const group = createGroup(db, {
      name,
      createdBy: ensureHuman(db).id,
      memberIds: [actor.id, peer.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")
    return group.approved
  }

  it("returns asks[] for a group ask without wait (group discriminant, no reply)", async () => {
    const actor = makeAgent("mcp-gask-actor")
    const peer = makeAgent("mcp-gask-peer")
    const group = seedGroup(actor, peer, "mcp-gask-group")
    const client = await connect(actor.id)
    try {
      const result = await callTool(client, "ask", {
        to: group.id,
        question: "哪个方案？",
        options: ["x", "y"],
        mentions: [peer.name],
      })
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.ask.parse(JSON.parse(textOf(result)))
      if (!("asks" in parsed)) throw new Error("expected group asks[] output, got DM single ask")
      expect(parsed).not.toHaveProperty("reply")
      expect(parsed.asks).toHaveLength(1)
      expect(parsed.asks[0]).toMatchObject({ kind: "ask", status: "pending", target: peer.id })
    } finally {
      await client.close()
    }
  })

  it("maps mentions_required, mention_not_found (with the list) and mention_not_participant", async () => {
    const actor = makeAgent("mcp-gask-err-actor")
    const peer = makeAgent("mcp-gask-err-peer")
    const outsider = makeAgent("mcp-gask-err-outsider")
    const group = seedGroup(actor, peer, "mcp-gask-err-group")
    const client = await connect(actor.id)
    try {
      const noMentions = await callTool(client, "ask", {
        to: group.id,
        question: "q",
        options: [],
      })
      expect(toolFailed(noMentions)).toBe(true)
      expect(textOf(noMentions)).toContain("mentions_required")

      const typo = await callTool(client, "ask", {
        to: group.id,
        question: "q",
        options: [],
        mentions: ["不存在的人"],
      })
      expect(toolFailed(typo)).toBe(true)
      expect(textOf(typo)).toContain("mention_not_found")
      expect(textOf(typo)).toContain("不存在的人")

      const notMember = await callTool(client, "ask", {
        to: group.id,
        question: "q",
        options: [],
        mentions: [outsider.name],
      })
      expect(toolFailed(notMember)).toBe(true)
      expect(textOf(notMember)).toContain("mention_not_participant")

      // 三个错误都在建卡前抛出：无孤儿单据。
      expect(listApprovals(db)).toHaveLength(0)
    } finally {
      await client.close()
    }
  })
})

// ── Task 5：roster{conversation} 过滤 + 成员闸门 + 群成员卡片 + 入群通知 ─────

describe("roster{conversation} 过滤与成员闸门（Task 5，spec §4.4）", () => {
  it("returns only group members to a member and rejects an outsider with not_participant", async () => {
    const human = ensureHuman(db)
    const member = makeAgent("mcp-t5-member")
    const outsider = makeAgent("mcp-t5-outsider")
    const group = createGroup(db, {
      name: "t5-roster-group",
      createdBy: human.id,
      memberIds: [member.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")

    const memberClient = await connect(member.id)
    try {
      const result = await callTool(memberClient, "roster", { conversation: group.approved.id })
      expect(toolFailed(result)).toBe(false)
      const nodes = MCP_TOOL_OUTPUTS.roster.parse(JSON.parse(textOf(result)))
      expect(new Set(nodes.map((node) => node.id))).toEqual(new Set([human.id, member.id]))
      for (const node of nodes) expect(node.name.length).toBeGreaterThan(0)
    } finally {
      await memberClient.close()
    }

    // 非成员 agent 枚举他群成员名单 = 越权读 → not_participant（评审点名的 membership gate）。
    const outsiderClient = await connect(outsider.id)
    try {
      const denied = await callTool(outsiderClient, "roster", { conversation: group.approved.id })
      expect(toolFailed(denied)).toBe(true)
      expect(textOf(denied)).toContain("[not_participant]")
    } finally {
      await outsiderClient.close()
    }
  })

  it("treats the shout conversation as an empty member set (parameter not accepted)", async () => {
    const human = ensureHuman(db)
    const outsider = makeAgent("mcp-t5-shout-outsider")
    const shoutConversation = ensureShoutConversation(db, human.id)

    const client = await connect(outsider.id)
    try {
      const result = await callTool(client, "roster", { conversation: shoutConversation.id })
      expect(toolFailed(result)).toBe(false)
      expect(MCP_TOOL_OUTPUTS.roster.parse(JSON.parse(textOf(result)))).toEqual([])
    } finally {
      await client.close()
    }
  })
})

describe("group op:list 成员卡片（Task 5，member_cards additive）", () => {
  it("keeps members as an id array and adds member_cards {id,name,status}", async () => {
    const human = ensureHuman(db)
    const first = makeAgent("mcp-t5-list-a")
    const second = makeAgent("mcp-t5-list-b")
    const outsider = makeAgent("mcp-t5-list-outsider")
    const group = createGroup(db, {
      name: "t5-list-group",
      createdBy: human.id,
      memberIds: [first.id, second.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")

    const client = await connect(first.id)
    try {
      const result = await callTool(client, "group", { op: "list" })
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.group.parse(JSON.parse(textOf(result)))
      if (!("groups" in parsed)) throw new Error("expected the groups list output")
      const listed = parsed.groups.find((entry) => entry.id === group.approved.id)
      if (listed === undefined) throw new Error("expected the created group in the list")

      // `members` 形状不变：id 数组。
      expect(new Set(listed.members)).toEqual(new Set([human.id, first.id, second.id]))
      expect(listed.members).not.toContain(outsider.id)
      // `member_cards` additive：每卡 id + name + status，与成员集一一对应。
      expect(listed.member_cards).toHaveLength(3)
      expect(new Set(listed.member_cards?.map((card) => card.id))).toEqual(
        new Set(listed.members),
      )
      for (const card of listed.member_cards ?? []) {
        expect(card.name.length).toBeGreaterThan(0)
      }
    } finally {
      await client.close()
    }
  })
})

describe("group op:add 入群 system 通知（Task 5）", () => {
  it("delivers a kind:'system' join notice with the member roster and creates zero wake jobs", async () => {
    const human = ensureHuman(db)
    const actor = makeAgent("mcp-t5-add-actor")
    const newcomer = makeAgent("mcp-t5-newcomer")
    const group = createGroup(db, {
      name: "t5-add-group",
      createdBy: human.id,
      memberIds: [actor.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")

    const client = await connect(actor.id)
    try {
      const result = await callTool(client, "group", {
        op: "add",
        group: group.approved.id,
        member: newcomer.id,
      })
      expect(toolFailed(result)).toBe(false)
      expect(JSON.parse(textOf(result))).toEqual({ ok: true })
    } finally {
      await client.close()
    }

    // 新成员收件箱收到入群通知（body 为 brief 逐字格式，名单含全体成员 名字(id前8)）。
    const notice = inbox(db, newcomer.id).find(
      (m) => m.kind === "system" && m.body.startsWith("你被拉入群「t5-add-group」。成员："),
    )
    if (notice === undefined) throw new Error("expected the join system message in the newcomer inbox")
    expect(notice.conversationId).toBe(group.approved.id)
    expect(notice.body).toContain(`用户(${human.id.slice(0, 8)})`)
    expect(notice.body).toContain(`mcp-t5-add-actor(${actor.id.slice(0, 8)})`)
    expect(notice.body).toContain(`mcp-t5-newcomer(${newcomer.id.slice(0, 8)})`)

    // kind:"system" 豁免回归锁：该入群通知 0 wake job（全库计数）。
    const wakeRows = db
      .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM wake_jobs WHERE message_id = ?")
      .get(notice.seq)
    expect(wakeRows?.n).toBe(0)
  })
})

describe("错误契约（DoD ③）", () => {
  it("rejects self-send with stable [self_send] code (BUG-SELF-SEND)", async () => {
    const self = makeAgent("self-sender")
    const client = await connect(self.id)
    const result = await callTool(client, "send", { to: self.id, body: "to myself" })
    expect(textOf(result)).toContain("[self_send]")
  })

  it("maps a previously unmapped domain error to a stable [agent_not_found] (mapping audit)", async () => {
    const agent = makeAgent("vanish-sender")
    const client = await connect(agent.id)
    db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id)
    const result = await callTool(client, "send", { to: "any-peer", body: "hi" })
    expect(textOf(result)).toContain("[agent_not_found]")
  })

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

// ── Task 6：name_taken 映射覆盖展示名唯一索引（adopt 稳定别名重试的输入契约） ────

describe("register 撞名 → name_taken（展示名索引口径）", () => {
  it("maps both a duplicate raw name and a display-name collision to [name_taken]", async () => {
    const client = await connect()
    try {
      // 裸名重复：两行 custom_name 均为 NULL → 唯一索引与 agents.name 同时命中。
      expect(toolFailed(await callTool(client, "register", { name: "t6-dup", vendor: "opencode" }))).toBe(false)
      const dupRaw = await callTool(client, "register", { name: "t6-dup", vendor: "opencode" })
      expect(toolFailed(dupRaw)).toBe(true)
      expect(textOf(dupRaw)).toContain("[name_taken]")

      // 展示名冲突：他人改名占用 t6-taken 后，裸名未撞、只撞展示名索引 → 同样 name_taken。
      const holder = insertAgent(db, {
        name: "t6-holder-raw",
        kind: "runtime",
        status: "online",
        vendor: "opencode",
      })
      renameAgent(db, holder.id, "t6-taken")
      const displayClash = await callTool(client, "register", { name: "t6-taken", vendor: "opencode" })
      expect(toolFailed(displayClash)).toBe(true)
      expect(textOf(displayClash)).toContain("[name_taken]")
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
   *
   * P5（task-11）更新：`x-agent-id` 命中容器时**视为无身份**（fail-closed），故 ① 处不再
   * "以容器身份"回带自身 id，而是工具报 `identity_required` —— 身份**只能**由 ② 的逐调用
   * 会话头赋予。这使本用例的敏感点更硬：删掉逐请求重解析分支即永久无身份。
   */
  it("re-resolves identity on a later tools/call session header (real bridge timing; fails without per-request re-resolution)", async () => {
    const { box, session } = containerWithSession()
    const peer = makeAgent("m2-timing-peer")

    // ① initialize **不带**会话头 → P5 fail-closed：`x-agent-id` 是容器 ⇒ 视为无身份。
    const init = await rawPost(initializeMessage(), { "x-agent-id": box.id })
    expect(init.status).toBe(200)
    if (init.sessionId === null) throw new Error("initialize returned no mcp-session-id")
    const base = { "mcp-session-id": init.sessionId, "x-agent-id": box.id }
    await rawPost({ jsonrpc: "2.0", method: "notifications/initialized" }, base)

    // 固化敏感点：此刻**没有**身份（容器不被当作身份），工具报 identity_required。
    const before = await rawPost(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { text: "init" } } },
      base,
    )
    const beforeResult = rawResult(before.text)
    expect(toolFailed(beforeResult)).toBe(true)
    expect(textOf(beforeResult)).toContain("identity_required")

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

/**
 * P4 工具可发现性：DSH 只消费 (a) tool description (b) 参数 JSON Schema 的 description
 * (c) server `instructions`，tool `title` 与 annotation hint 会被丢弃 —— 故这三处必须有内容。
 */
describe("P4 工具可发现性（instructions／description／is_member／错误下一步）", () => {
  /** tools/list 广告的某工具入参 properties（unknown 入参 + 运行时收窄，避开 SDK 类型并集）。 */
  function propertiesOf(tools: Awaited<ReturnType<Client["listTools"]>>["tools"], name: string) {
    const schema: unknown = tools.find((tool) => tool.name === name)?.inputSchema
    if (typeof schema !== "object" || schema === null) return {}
    const properties: unknown = (schema as { properties?: unknown }).properties
    return typeof properties === "object" && properties !== null
      ? (properties as Record<string, unknown>)
      : {}
  }

  /** 字段级 description 是否非空（用于断言"参数语义确实广告出去了"）。 */
  function describedIn(properties: Record<string, unknown>, field: string): boolean {
    const property: unknown = properties[field]
    if (typeof property !== "object" || property === null) return false
    const description: unknown = (property as { description?: unknown }).description
    return typeof description === "string" && description.length > 0
  }

  it("injects a ≤8KB guide via instructions and advertises six-line descriptions on all tools", async () => {
    const actor = makeAgent("p4-discover-actor")
    const client = await connect(actor.id)
    try {
      // ① instructions：DSH 唯一会注入系统提示的全局说明通道（tool title/annotations 会被丢弃）。
      const guide = client.getInstructions() ?? ""
      expect(guide.length).toBeGreaterThan(200)
      expect(Buffer.byteLength(guide, "utf8")).toBeLessThanOrEqual(8192)
      for (const keyword of ["register", "inbox", "send", "shout", "message_status", "容器", "R1", "R2", "identity_required"]) {
        expect({ keyword, present: guide.includes(keyword) }).toEqual({ keyword, present: true })
      }

      // ② 12 条 description：每条 ≤6 行，且都含「何时」（何时用/何时不用）与「常见错误」。
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(MCP_TOOLS.length)
      for (const tool of tools) {
        const description = tool.description ?? ""
        expect({
          name: tool.name,
          hasWhen: description.includes("何时"),
          hasCommonError: description.includes("常见错误"),
          withinSixLines: description.split("\n").length <= 6,
        }).toEqual({ name: tool.name, hasWhen: true, hasCommonError: true, withinSixLines: true })
      }
      // 反寒暄关键词（spec §15.5）：golden 用例已锁，这里按工具名再锁一次防文本重排漂移。
      for (const name of ["send", "shout"] as const) {
        const description = tools.find((tool) => tool.name === name)?.description ?? ""
        expect(description).toContain("信息增量")
        expect(description).toContain("禁纯回执")
      }

      // ③ 关键参数 description 必须随 tools/list 一起广告（agent 只能从这里读参数语义）。
      const sendProps = propertiesOf(tools, "send")
      const groupProps = propertiesOf(tools, "group")
      const registerProps = propertiesOf(tools, "register")
      const askProps = propertiesOf(tools, "ask")
      const required: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
        [sendProps, "to"],
        [sendProps, "mentions"],
        [sendProps, "idempotencyKey"],
        [groupProps, "op"],
        [groupProps, "name"],
        [groupProps, "member_ids"],
        [groupProps, "group"],
        [groupProps, "member"],
        [registerProps, "task_ref"],
        [registerProps, "parent_ref"],
        [askProps, "allow_custom"],
      ]
      for (const [properties, field] of required) {
        expect({ field, described: describedIn(properties, field) }).toEqual({ field, described: true })
      }
      // 嵌套的 wait 三个子字段（until/timeoutMs/scope）也要有 description。
      const wait: unknown = sendProps["wait"]
      const waitProperties =
        typeof wait === "object" && wait !== null
          ? (() => {
              const nested: unknown = (wait as { properties?: unknown }).properties
              return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : {}
            })()
          : {}
      for (const field of ["until", "timeoutMs", "scope"]) {
        expect({ field, described: describedIn(waitProperties, field) }).toEqual({ field, described: true })
      }

      // ④ register 出参 additive 带 guide（原生工具面不消费 instructions 时的兜底说明书）。
      const registration = await callTool(client, "register", {
        name: "p4-guide-node",
        kind: "runtime",
        vendor: "opencode",
      })
      expect(toolFailed(registration)).toBe(false)
      const registered = MCP_TOOL_OUTPUTS.register.parse(JSON.parse(textOf(registration)))
      expect(typeof registered.guide).toBe("string")
      expect(registered.guide ?? "").toContain("register")
    } finally {
      await client.close()
    }
  })

  it("marks group{op:list} entries with is_member so an outsider can see why sending fails", async () => {
    const human = ensureHuman(db)
    const member = makeAgent("p4-member")
    const outsider = makeAgent("p4-outsider")
    const group = createGroup(db, { name: "p4-group", createdBy: human.id, memberIds: [member.id] })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")

    const memberClient = await connect(member.id)
    const outsiderClient = await connect(outsider.id)
    try {
      const readList = async (client: Client, groupId: string): Promise<boolean | undefined> => {
        const result = await callTool(client, "group", { op: "list" })
        expect(toolFailed(result)).toBe(false)
        const parsed = MCP_TOOL_OUTPUTS.group.parse(JSON.parse(textOf(result)))
        if (!("groups" in parsed)) throw new Error("expected the group list output")
        return parsed.groups.find((entry) => entry.id === groupId)?.is_member
      }
      expect(await readList(memberClient, group.approved.id)).toBe(true)
      expect(await readList(outsiderClient, group.approved.id)).toBe(false)
    } finally {
      await memberClient.close()
      await outsiderClient.close()
    }
  })

  it("keeps the stable error code at line end while appending a next-step hint", async () => {
    const client = await connect() // 不带 x-agent-id / x-agentchat-session：任何需要身份的工具都报缺身份。
    try {
      const result = await callTool(client, "send", { to: "someone", body: "hi" })
      expect(toolFailed(result)).toBe(true)
      const text = textOf(result)
      expect(text).toContain("identity_required")
      expect(text).toContain("下一步")
      // 桥用 `/\[([a-z_]+)\]\s*$/` 解析错误码 —— 尾注只能加在 code **之前**（code 必须留在行尾）。
      expect(/\[([a-z_]+)\]\s*$/.exec(text)?.[1]).toBe("identity_required")
    } finally {
      await client.close()
    }
  })
})

/** P6 消息紧急度（urgency）：MCP 入参广告 + 落 `meta.urgency` + `message_status` 体现 + 非法值被拒。 */
describe("P6 紧急度（urgency）端到端", () => {
  it("advertises urgency on send/shout/ask, persists only low/urgent, and shows it in message_status", async () => {
    const actor = makeAgent("p6-mcp-actor")
    const peer = makeAgent("p6-mcp-peer")
    const client = await connect(actor.id)
    try {
      // ① schema 广告：三个可带紧急度的工具都能在 tools/list 看到 urgency（DSH 只从这里读参数语义）。
      const { tools } = await client.listTools()
      for (const name of ["send", "shout", "ask"] as const) {
        const properties = (tools.find((tool) => tool.name === name)?.inputSchema.properties ??
          {}) as Record<string, unknown>
        expect({ name, advertised: "urgency" in properties }).toEqual({ name, advertised: true })
      }

      // ② 落库：urgent/low 写 meta.urgency；缺省与显式 normal 都不写。
      const readRaw = (result: unknown): { message: { id: string; meta?: Record<string, unknown> } } =>
        JSON.parse(textOf(result)) as { message: { id: string; meta?: Record<string, unknown> } }
      const urgent = readRaw(await callTool(client, "send", { to: peer.id, body: "紧急", urgency: "urgent" }))
      expect(urgent.message.meta?.["urgency"]).toBe("urgent")
      const low = readRaw(await callTool(client, "send", { to: peer.id, body: "不急", urgency: "low" }))
      expect(low.message.meta?.["urgency"]).toBe("low")
      const normal = readRaw(await callTool(client, "send", { to: peer.id, body: "普通" }))
      expect(normal.message.meta?.["urgency"]).toBeUndefined()
      const explicit = readRaw(
        await callTool(client, "send", { to: peer.id, body: "显式普通", urgency: "normal" }),
      )
      expect(explicit.message.meta?.["urgency"]).toBeUndefined()

      // ③ message_status 体现紧急度（缺省归一为 normal），供矩阵断言与排障区分三档。
      const status = await callTool(client, "message_status", {
        ids: [urgent.message.id, low.message.id, normal.message.id],
      })
      expect(toolFailed(status)).toBe(false)
      const entries = MCP_TOOL_OUTPUTS.message_status.parse(JSON.parse(textOf(status)))
      const byId = new Map(entries.map((entry) => [entry.id, entry.urgency]))
      expect(byId.get(urgent.message.id)).toBe("urgent")
      expect(byId.get(low.message.id)).toBe("low")
      expect(byId.get(normal.message.id)).toBe("normal")

      // ④ 非法档位是**入参错误**，不是静默归一。
      const bogus = await callTool(client, "send", { to: peer.id, body: "x", urgency: "bogus" })
      expect(toolFailed(bogus)).toBe(true)
      expect(textOf(bogus)).toContain("Input validation error")
    } finally {
      await client.close()
    }
  })
})

describe("whoami：agent 能查到自己的展示名（真机反馈「不知道自己昵称」）", () => {
  it("返回机器名与展示名（= custom_name ?? name）；改名后展示名变、机器名不变；unread 与未读一致", async () => {
    const actor = makeAgent("whoami-actor")
    const peer = makeAgent("whoami-peer")
    const client = await connect(actor.id)
    try {
      // ① 未改名：展示名 == 机器名
      const first = await callTool(client, "whoami", {})
      expect(toolFailed(first)).toBe(false)
      const card1 = MCP_TOOL_OUTPUTS.whoami.parse(JSON.parse(textOf(first)))
      expect(card1.agent_id).toBe(actor.id)
      expect(card1.name).toBe("whoami-actor")
      expect(card1.display_name).toBe("whoami-actor")
      expect(card1.unread).toBe(0)

      // ② 人类在 UI 改名（等价 PATCH /api/agents/:id → store.renameAgent）：展示名变、机器名不变
      renameAgent(db, actor.id, "人类给我起的昵称")
      const second = await callTool(client, "whoami", {})
      const card2 = MCP_TOOL_OUTPUTS.whoami.parse(JSON.parse(textOf(second)))
      expect(card2.display_name).toBe("人类给我起的昵称")
      expect(card2.name).toBe("whoami-actor")

      // ③ unread 与收件箱口径一致
      sendMessage(db, { from: peer.id, to: actor.id, body: "给你一条" })
      const third = await callTool(client, "whoami", {})
      const card3 = MCP_TOOL_OUTPUTS.whoami.parse(JSON.parse(textOf(third)))
      expect(card3.unread).toBe(1)
    } finally {
      await client.close()
    }
  })

  it("没有身份时 whoami 报 identity_required（不会泄漏他人信息）", async () => {
    const anonymous = await connect()
    try {
      const result = await callTool(anonymous, "whoami", {})
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("identity_required")
    } finally {
      await anonymous.close()
    }
  })
})

describe("inbox 默认排除自发（自激环路防护；测试员A 提议）", () => {
  it("自发文本不在 inbox；include_self:true 复原旧行为；他人消息照常可见", async () => {
    const actor = makeAgent("inbox-self-actor")
    const peer = makeAgent("inbox-self-peer")
    const human = ensureHuman(db)
    const group = createGroup(db, { name: "inbox-self-group", createdBy: human.id, memberIds: [actor.id, peer.id] })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")
    const client = await connect(actor.id)
    try {
      // ① 自己在群里发一条：默认 inbox 不含它（否则"轮询 inbox→逐条回复"会自激）
      const mine = await callTool(client, "send", { to: group.approved.id, body: "我自己的群消息" })
      expect(toolFailed(mine)).toBe(false)
      const myId = JSON.parse(textOf(mine)).message.id
      const box = await callTool(client, "inbox", {})
      expect(toolFailed(box)).toBe(false)
      expect(JSON.parse(textOf(box)).messages.map((m: { id: string }) => m.id)).not.toContain(myId)

      // ② 逃生口：include_self:true 找回旧行为
      const withSelf = await callTool(client, "inbox", { include_self: true })
      expect(JSON.parse(textOf(withSelf)).messages.map((m: { id: string }) => m.id)).toContain(myId)

      // ③ 他人发来的消息照常在页内（排除自发的边界只针对自己）
      const inbound = sendMessage(db, { from: peer.id, to: group.approved.id, body: "别人的群消息" })
      const box2 = await callTool(client, "inbox", {})
      expect(JSON.parse(textOf(box2)).messages.map((m: { id: string }) => m.id)).toContain(inbound.message.id)
    } finally {
      await client.close()
    }
  })
})
