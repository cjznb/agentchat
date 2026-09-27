/**
 * Task 8 —— MCP 端点集成测试（brief DoD）：真实 MCP SDK 客户端连 `POST /mcp`（Bearer）。
 * ① `tools/list` 恰为锁定十名 + 金样例过 `MCP_TOOL_INPUTS`
 * ② `send{wait}` 端到端：对方 core 回信 → 调用方在 wait 内解锁拿到 reply
 * ③ 错误契约：未知收件人 RecipientNotFound / 子 shout Forbidden / `to:'*'` use_shout_tool
 *    / 缺身份 identity_required / 无 Bearer 401
 * ④ `register` 首次 → join_token → 离线后再认领同 id 回 online
 * 每个用例独立临时 $AGENTCHAT_HOME，真实监听 `start({port:0})`。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { MCP_TOOLS, MCP_TOOL_INPUTS, type McpToolName } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { inbox, sendMessage } from "../../server/core/messaging"
import { start, type RunningServer } from "../../server/index"
import { applyAgentState, ensureHubToken } from "../../server/routes/internal"
import { getAgent, insertAgent, type Agent } from "../../server/store/agents"

const agentSchema = z.object({ id: z.string(), name: z.string() })
const receiptSchema = z.object({ agentId: z.string(), stage: z.string() })
const messageSchema = z.object({ body: z.string() })
const registerOutput = z.object({
  agent: agentSchema,
  unread: z.number(),
  join_token: z.string().optional(),
})
const sendOutput = z.object({
  message: messageSchema,
  receipts: z.array(receiptSchema),
  readReceipts: z.array(receiptSchema),
  reply: z.object({ timedOut: z.boolean(), messages: z.array(messageSchema) }).optional(),
})

const GOLDEN_INPUTS: Record<McpToolName, unknown> = {
  register: { name: "golden-root", kind: "runtime", vendor: "opencode", model: "test" },
  send: { to: "someone", body: "hi", wait: { until: "either", timeoutMs: 1000 } },
  inbox: { conversation: "c", after: 0, ack: true, timeout: 1000 },
  ack: { message_ids: ["abcdef"] },
  roster: { filter: "root", online_only: true },
  conversation: { id: "conv", before: 10, limit: 5 },
  group: { op: "create", name: "g", member_ids: [] },
  shout: { body: "hello" },
  status: { text: "busy" },
  message_status: { ids: ["abcdef"] },
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

function callTool(client: Client, name: McpToolName, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
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

describe("tools/list 与金样例（DoD ①）", () => {
  it("exposes exactly the ten locked tools and every golden input parses", async () => {
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOLS])
      for (const name of MCP_TOOLS) {
        expect(MCP_TOOL_INPUTS[name].safeParse(GOLDEN_INPUTS[name]).success).toBe(true)
      }
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
      const parsed = sendOutput.parse(JSON.parse(textOf(result)))
      expect(parsed.reply?.timedOut).toBe(false)
      expect(parsed.reply?.messages.map((m) => m.body)).toEqual(["pong"])
      expect(parsed.readReceipts).toEqual([])
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
      const first = registerOutput.parse(
        JSON.parse(
          textOf(
            await callTool(client, "register", { name: "mcp-first-root", vendor: "opencode" }),
          ),
        ),
      )
      if (first.join_token === undefined) throw new Error("register did not return join_token")
      expect(applyAgentState(db, { agentId: first.agent.id, state: "offline" })).toEqual({ ok: true })
      expect(getAgent(db, first.agent.id)?.status).toBe("offline")

      const second = registerOutput.parse(
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
})
