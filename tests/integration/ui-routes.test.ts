/**
 * Task 9 —— UI REST 集成测试（brief DoD）：
 * - `GET /api/conversations`：双层聚合未读（human 位点 + 每根 `unreadFor`）+ 最后一条预览 + 时间倒序
 * - `POST /api/conversations/:id/messages`：human 发言；未知会话 404；非法 body 400
 * - `GET/POST /api/groups` + `POST /api/groups/:id/members`：human 走既有 gate 即时执行
 * - `POST /api/shout`：写入喊话广播会话
 * - `GET /api/agents/:id`：资料卡（roster 节点 + 参与会话入口）；未知 404
 * 每个用例独立临时 $AGENTCHAT_HOME，`createApp(db)` 直连路由（无需监听）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { loadConfig } from "../../server/config"
import { registerRoot } from "../../server/core/agents"
import { ensureHuman, sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { insertAgent } from "../../server/store/agents"
import { getConversationByKey, isParticipant, SHOUT_KEY } from "../../server/store/conversations"

let home = ""
let db: Db
let app: Hono
let humanId = ""
let rootId = ""
let dmId = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-ui-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  app = createApp(db)
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "ui-root", vendor: "opencode" }).agent
  const first = sendMessage(db, { from: human.id, to: root.id, body: "hello" })
  sendMessage(db, { from: root.id, to: human.id, body: "pong" })
  humanId = human.id
  rootId = root.id
  dmId = first.message.conversationId
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const previewSchema = z.object({
  id: z.string(),
  seq: z.number(),
  from: z.string(),
  body: z.string(),
  createdAt: z.number(),
})
const conversationSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  key: z.string(),
  lastMessage: previewSchema.nullable(),
  unread: z.number(),
})
const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  unreadByRoot: z.record(z.string(), z.number()),
})
const messageResultSchema = z.object({
  ok: z.boolean(),
  message: z.object({
    id: z.string(),
    body: z.string(),
    fromAgentId: z.string(),
    conversationId: z.string(),
  }),
  receipts: z.array(z.object({ agentId: z.string(), stage: z.string() })),
})
const groupListSchema = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string().nullable(), key: z.string() })),
})
const agentCardSchema = z.object({
  node: z.object({ id: z.string(), name: z.string() }),
  conversations: z.array(z.object({ id: z.string(), kind: z.string() })),
})

describe("GET /api/conversations", () => {
  it("aggregates human unread + last preview and per-root double-aggregate unread", async () => {
    const res = await app.request("/api/conversations")
    expect(res.status).toBe(200)
    const body = conversationListSchema.parse(await res.json())

    const dm = body.conversations.find((conversation) => conversation.id === dmId)
    expect(dm?.lastMessage?.body).toBe("pong")
    expect(dm?.unread).toBe(1) // human 未读 = root 发来的 pong（hello 为 human 自发）
    expect(body.unreadByRoot[rootId]).toBe(1) // root 未读 = human 发来的 hello
  })
})

describe("POST /api/conversations/:id/messages", () => {
  it("lets the human speak in an existing conversation", async () => {
    const res = await post(`/api/conversations/${dmId}/messages`, { body: "yo" })
    expect(res.status).toBe(200)
    const json = messageResultSchema.parse(await res.json())
    expect(json.ok).toBe(true)
    expect(json.message.body).toBe("yo")
    expect(json.message.fromAgentId).toBe(humanId)
    expect(json.message.conversationId).toBe(dmId)
  })

  it("returns 404 for an unknown conversation and 400 for an invalid body", async () => {
    expect((await post("/api/conversations/does-not-exist/messages", { body: "x" })).status).toBe(404)
    expect((await post(`/api/conversations/${dmId}/messages`, {})).status).toBe(400)
  })
})

describe("GET/POST /api/groups", () => {
  it("creates a group (human immediate) and adds a member through the gate", async () => {
    const created = await post("/api/groups", { name: "g1", memberIds: [rootId] })
    expect(created.status).toBe(200)
    const createdJson = z
      .object({ ok: z.boolean(), group: z.object({ id: z.string(), kind: z.string(), name: z.string() }) })
      .parse(await created.json())
    expect(createdJson.group.kind).toBe("group")

    const list = groupListSchema.parse(await (await app.request("/api/groups")).json())
    expect(list.groups.some((group) => group.id === createdJson.group.id)).toBe(true)

    const child = insertAgent(db, {
      name: "ui-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    const added = await post(`/api/groups/${createdJson.group.id}/members`, { agentId: child.id })
    expect(added.status).toBe(200)
    expect(isParticipant(db, createdJson.group.id, child.id)).toBe(true)
  })
})

describe("POST /api/shout", () => {
  it("broadcasts a human shout into the shout conversation", async () => {
    const res = await post("/api/shout", { body: "everyone" })
    expect(res.status).toBe(200)
    const json = messageResultSchema.parse(await res.json())
    expect(json.message.body).toBe("everyone")
    expect(getConversationByKey(db, SHOUT_KEY)).toBeDefined()
  })
})

describe("GET /api/agents/:id", () => {
  it("returns the roster node and the conversations the agent participates in", async () => {
    const res = await app.request(`/api/agents/${rootId}`)
    expect(res.status).toBe(200)
    const card = agentCardSchema.parse(await res.json())
    expect(card.node.id).toBe(rootId)
    expect(card.conversations.some((conversation) => conversation.id === dmId)).toBe(true)
  })

  it("returns 404 for an unknown agent", async () => {
    expect((await app.request("/api/agents/nope")).status).toBe(404)
  })
})
