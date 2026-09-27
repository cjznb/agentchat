/**
 * Task 5 —— ask 跨层集成（spec §17）四场景端到端：
 * ① 人答全链路：MCP `ask{to:'human',wait}` 挂起 → REST `POST /api/asks/:id/respond` 解锁
 *    （`reply.timedOut=false` + `reply.choice`）；通知页 `scope=all` 可见已决单，
 *    `cardMessageId`/`conversationId` 指向卡消息，卡所在会话含 human 答复消息。
 * ② agent 答：MCP `ask{to:B,wait}` → B 经 MCP `respond_ask` 答复 → A 解锁拿到 B 的文本。
 * ③ 代答：MCP `ask{to:B}`（B 为 agent）→ 人经 REST 答复 → B 的 inbox 收到答复消息（`meta.askId`）。
 * ④ 过期：MCP `ask` 后注入时钟推进 >24h → `dispatcher.tick(now)` 触发 sweep →
 *    单据 `expired` + 发起方收「批示已过期」system 回执。
 *
 * 既有模式：临时 `$AGENTCHAT_HOME` + `loadConfig` + 真实监听 `start({port:0})`；注入时钟，无长 sleep。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MCP_TOOL_OUTPUTS, notificationListSchema } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { Dispatcher } from "../../server/core/dispatcher"
import { inbox, sendMessage } from "../../server/core/messaging"
import { APPROVAL_TTL_MS, ensureHuman } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { insertAgent, type Agent } from "../../server/store/agents"
import { getApproval, listApprovals } from "../../server/store/approvals"
import { history } from "../../server/store/messages"

let home = ""
let db: Db
let running: RunningServer
let token = ""
const clients: Client[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentchat-ask-flow-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  token = ensureHubToken(join(home, "hub_token"))
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

async function connect(agentId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "x-agent-id": agentId } },
  })
  const client = new Client({ name: "ask-flow-test", version: "0.0.0" })
  // SDK 1.30 的 `Transport.sessionId` 可选性与 exactOptionalPropertyTypes 不兼容 → 单点收窄。
  await client.connect(transport as Transport)
  clients.push(client)
  return client
}

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

/** 解析 MCP `ask` 出参（`{ask, reply?}`）；调用失败即抛。 */
function parseAsk(result: unknown) {
  if (toolFailed(result)) throw new Error(`ask failed: ${textOf(result)}`)
  return MCP_TOOL_OUTPUTS.ask.parse(JSON.parse(textOf(result)))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询 pending ask 单（工具调用经网络挂起时，单据已在服务端同步落库）。 */
async function pendingAskId(): Promise<string> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const row = listApprovals(db, "pending").find((approval) => approval.kind === "ask")
    if (row !== undefined) return row.id
    await delay(10)
  }
  throw new Error("no pending ask in time")
}

async function rest(path: string, body: unknown): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function notifications(scope: "actionable" | "all") {
  const response = await fetch(`${running.url}/api/notifications?scope=${scope}`)
  return notificationListSchema.parse(await response.json())
}

describe("场景① 人答全链路（MCP ask{wait} → REST respond）", () => {
  it("unlocks the ask, exposes the decided card under scope=all, and posts the reply into its conversation", async () => {
    const root = makeAgent("flow-human-root")
    const client = await connect(root.id)

    const pending = client.callTool({
      name: "ask",
      arguments: {
        to: "human",
        question: "部署到哪个环境？",
        options: ["staging", "prod"],
        wait: { until: "message", timeoutMs: 5000 },
      },
    })
    const askId = await pendingAskId()

    // Task 1（Plan 2 复审 L12-1）：答复前先记下深链锚点，答复后必须仍指向同一张卡消息
    // —— 证明「最早一条」口径在已答复路径（答复消息也带 meta.askId）依然成立。
    const cardBefore = (await notifications("all")).find((item) => item.id === askId)?.cardMessageId
    expect(cardBefore).toEqual(expect.any(String))

    const responded = await rest(`/api/asks/${askId}/respond`, { choice: "staging" })
    expect(responded.status).toBe(200)

    const settled = parseAsk(await pending)
    expect(settled.reply?.timedOut).toBe(false)
    expect(settled.reply?.choice).toBe("staging")
    expect(settled.ask.status).toBe("answered")

    const entry = (await notifications("all")).find((item) => item.id === askId)
    expect(entry).toMatchObject({ kind: "ask", target: "human", status: "answered" })
    expect(entry?.cardMessageId).toBe(cardBefore)
    expect(entry?.conversationId).toEqual(expect.any(String))

    const conversation = history(db, { conversationId: entry?.conversationId ?? "" })
    const card = conversation.find((message) => message.id === entry?.cardMessageId)
    expect(card?.meta?.["askId"]).toBe(askId)

    const human = ensureHuman(db)
    const replies = conversation.filter(
      (message) => message.meta?.["askId"] === askId && message.fromAgentId === human.id,
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]?.body).toContain("staging")
  })
})

describe("场景② agent 答复（MCP ask{wait} → respond_ask）", () => {
  it("unlocks the asking agent with the target agent's free-text answer", async () => {
    const asker = makeAgent("flow-agent-asker")
    const target = makeAgent("flow-agent-target")
    sendMessage(db, { from: asker.id, to: target.id, body: "seed-dm" })
    const clientA = await connect(asker.id)
    const clientB = await connect(target.id)

    const pending = clientA.callTool({
      name: "ask",
      arguments: {
        to: target.id,
        question: "走哪个分支？",
        options: ["x", "y"],
        wait: { until: "message", timeoutMs: 5000 },
      },
    })
    const askId = await pendingAskId()

    const answered = await clientB.callTool({
      name: "respond_ask",
      arguments: { ask_id: askId, text: "走 y 分支（自定义）" },
    })
    if (toolFailed(answered)) throw new Error(`respond_ask failed: ${textOf(answered)}`)

    const settled = parseAsk(await pending)
    expect(settled.reply?.timedOut).toBe(false)
    expect(settled.reply?.text).toBe("走 y 分支（自定义）")
    expect(getApproval(db, askId)?.status).toBe("answered")
  })
})

describe("场景③ 代答（agent 目标 → 人经 REST 答复）", () => {
  it("delivers the human's proxy answer into the target agent's inbox", async () => {
    const asker = makeAgent("flow-proxy-asker")
    const target = makeAgent("flow-proxy-target")
    sendMessage(db, { from: asker.id, to: target.id, body: "seed-dm" })
    const client = await connect(asker.id)

    const created = parseAsk(
      await client.callTool({
        name: "ask",
        arguments: { to: target.id, question: "批准吗？", options: ["yes", "no"] },
      }),
    )
    const human = ensureHuman(db)

    const responded = await rest(`/api/asks/${created.ask.id}/respond`, { choice: "yes" })
    expect(responded.status).toBe(200)
    expect(getApproval(db, created.ask.id)?.status).toBe("answered")

    const delivered = inbox(db, target.id).filter(
      (message) => message.meta?.["askId"] === created.ask.id && message.fromAgentId === human.id,
    )
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.body).toContain("yes")
  })
})

describe("场景④ 过期（注入时钟 + dispatcher sweep）", () => {
  it("expires the pending ask after the 24h TTL and receipts the initiator via dispatcher.tick", async () => {
    const root = makeAgent("flow-expiry-root")
    const human = ensureHuman(db)
    const client = await connect(root.id)

    const created = parseAsk(
      await client.callTool({
        name: "ask",
        arguments: { to: "human", question: "还在吗？", options: ["在", "不在"] },
      }),
    )

    // 未满 24h：清扫不动它（注入时钟，不 sleep）。
    await new Dispatcher({ db, home }).tick(Date.now() + APPROVAL_TTL_MS - 60_000)
    expect(getApproval(db, created.ask.id)?.status).toBe("pending")

    // 满 24h：dispatcher 每轮顺带调用 `sweepExpired`。
    await new Dispatcher({ db, home }).tick(Date.now() + APPROVAL_TTL_MS + 1)
    expect(getApproval(db, created.ask.id)?.status).toBe("expired")

    const receipt = inbox(db, root.id).find(
      (message) =>
        message.meta?.["askId"] === created.ask.id &&
        message.fromAgentId === human.id &&
        message.body.includes("批示已过期"),
    )
    expect(receipt).toBeDefined()
  })
})
