/**
 * P5 容器语义 —— Hub 身份 **fail-closed**（MCP 面，`server/routes/mcp.ts`）：
 * - `x-agent-id` 命中 `role_tag='container'` → **视为无身份**：除 `register` 外全部工具报
 *   `identity_required`，从此不再产生任何容器署名的消息（毒化 DM 的入口）。
 * - `register` 不需要身份 → 容器头存在也照常可用（影响面必须写清，不能顺手把注册也拦了）。
 * - 逐调用 `x-agentchat-session` 通道**不受影响**：会话头命中即用会话节点身份（P1/P3 的
 *   修复方向就是让桥走这条通道，而非回落实例容器）。
 *
 * 真机面：真实监听 `POST /mcp`（未启 test-api），与 `mcp.test.ts` 同一套 MCP SDK 客户端形态。
 * 每个用例独立临时 $AGENTCHAT_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MCP_TOOL_OUTPUTS } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { insertAgent, type Agent } from "../../server/store/agents"

let home = ""
let db: Db
let running: RunningServer
let token = ""

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentchat-p5-mcp-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  token = ensureHubToken(join(home, "hub_token"))
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
})

afterEach(async () => {
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 分组容器（实例节点）：`kind=runtime` + `role_tag='container'`。 */
function makeContainer(name: string): Agent {
  return insertAgent(db, {
    name,
    kind: "runtime",
    status: "online",
    vendor: "opencode",
    roleTag: "container",
  })
}

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

/** 带任意请求头的 MCP 客户端（所有请求回带；用于身份头用例）。 */
async function connectHeaders(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
  })
  const client = new Client({ name: "p5-mcp-test", version: "0.0.0" })
  await client.connect(transport as Transport)
  return client
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
  return result.isError === true
}

/** 单表行数（断言"零写入"用）。 */
function countOf(table: "messages" | "conversations" | "participants"): number {
  const row = db.prepare<[], { readonly n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()
  return row?.n ?? -1
}

describe("P5 Hub 身份 fail-closed：x-agent-id=容器", () => {
  it("容器 x-agent-id 视为无身份：send 报 identity_required 且零消息/零会话写入", async () => {
    const box = makeContainer("p5-mcp-box")
    const peer = makeAgent("p5-mcp-peer")
    const client = await connectHeaders({ "x-agent-id": box.id })
    try {
      const result = await client.callTool({
        name: "send",
        arguments: { to: peer.id, body: "我代表所有人发言" },
      })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("identity_required")
      // 关键：连接期就没有身份 → 连"自动建 DM"这一步都不会发生（毒化会话入口被堵死）。
      expect(countOf("messages")).toBe(0)
      expect(countOf("conversations")).toBe(0)
    } finally {
      await client.close()
    }
  })

  it("容器 x-agent-id 下 shout 同样报 identity_required（不止 send 一条工具）", async () => {
    const box = makeContainer("p5-mcp-shout-box")
    const client = await connectHeaders({ "x-agent-id": box.id })
    try {
      const result = await client.callTool({ name: "shout", arguments: { body: "全员注意" } })
      expect(toolFailed(result)).toBe(true)
      expect(textOf(result)).toContain("identity_required")
      expect(countOf("conversations")).toBe(0)
    } finally {
      await client.close()
    }
  })

  it("register 不需要身份：带容器 x-agent-id 仍可注册（影响面仅限「需要身份」的工具）", async () => {
    const box = makeContainer("p5-mcp-reg-box")
    const client = await connectHeaders({ "x-agent-id": box.id })
    try {
      const result = await client.callTool({
        name: "register",
        arguments: { name: "p5-mcp-registered", kind: "runtime", vendor: "opencode", model: "test" },
      })
      expect(toolFailed(result)).toBe(false)
      expect(textOf(result)).toContain("p5-mcp-registered")
    } finally {
      await client.close()
    }
  })

  it("逐调用 x-agentchat-session 通道不受影响：会话头命中即用会话节点身份发送", async () => {
    const box = makeContainer("p5-mcp-sess-box")
    const session = insertAgent(db, {
      name: "p5-mcp-session",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: box.id,
      taskRef: "p5-sess-ref-1",
    })
    const peer = makeAgent("p5-mcp-sess-peer")
    const client = await connectHeaders({
      "x-agent-id": box.id,
      "x-agentchat-session": "p5-sess-ref-1",
    })
    try {
      const result = await client.callTool({ name: "send", arguments: { to: peer.id, body: "hi" } })
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
      expect(parsed.message.fromAgentId).toBe(session.id)
      expect(parsed.message.fromAgentId).not.toBe(box.id)
    } finally {
      await client.close()
    }
  })

  it("对照：非容器 x-agent-id 身份行为不变（send 正常，发送方=该节点）", async () => {
    const sender = makeAgent("p5-mcp-normal-sender")
    const peer = makeAgent("p5-mcp-normal-peer")
    const client = await connectHeaders({ "x-agent-id": sender.id })
    try {
      const result = await client.callTool({ name: "send", arguments: { to: peer.id, body: "hi" } })
      expect(toolFailed(result)).toBe(false)
      const parsed = MCP_TOOL_OUTPUTS.send.parse(JSON.parse(textOf(result)))
      expect(parsed.message.fromAgentId).toBe(sender.id)
    } finally {
      await client.close()
    }
  })

  it("容器心跳/状态上报（/internal/state）不受身份 fail-closed 与发送守卫影响", async () => {
    const box = makeContainer("p5-internal-box")
    const response = await fetch(`${running.url}/internal/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: box.id, state: "busy" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    // 状态真实落库（容器仍被当作可上报的实例节点，不因 P5 被冻结）。
    const row = db
      .prepare<[string], { readonly status: string }>("SELECT status FROM agents WHERE id = ?")
      .get(box.id)
    expect(row?.status).toBe("busy")
  })
})
