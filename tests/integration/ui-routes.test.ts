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
import { notificationListSchema } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { registerRoot } from "../../server/core/agents"
import { ensureHuman, sendMessage, shout } from "../../server/core/messaging"
import { ask, respondAsk } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { insertAgent } from "../../server/store/agents"
import { getApproval } from "../../server/store/approvals"
import { getConversationByKey, isParticipant, SHOUT_KEY } from "../../server/store/conversations"
import { history } from "../../server/store/messages"

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

// ── Task 4：通知页数据面（spec §11.5/§17.3） ─────────────────────────

const errorBodySchema = z.object({ ok: z.boolean(), error: z.string() })
const readBodySchema = z.object({ ok: z.boolean(), read: z.boolean() })

describe("GET /api/notifications", () => {
  it("lists actionable asks with card deep-link fields and honours scope", async () => {
    const { ask: stored } = ask(db, rootId, {
      to: "human",
      question: "部署到哪个环境？",
      options: ["staging", "prod"],
    })
    const card = history(db, { conversationId: dmId }).find(
      (message) => message.meta?.["askId"] === stored.id,
    )
    expect(card).toBeDefined()

    const all = notificationListSchema.parse(
      await (await app.request("/api/notifications?scope=all")).json(),
    )
    const entry = all.find((item) => item.id === stored.id)
    expect(entry).toBeDefined()
    expect(entry).toMatchObject({
      kind: "ask",
      target: "human",
      action: "ask",
      status: "pending",
      cardMessageId: card?.id,
      conversationId: card?.conversationId,
    })

    // 缺省 scope = actionable；待处理 human 单在列。
    const actionable = notificationListSchema.parse(
      await (await app.request("/api/notifications")).json(),
    )
    expect(actionable.map((item) => item.id)).toContain(stored.id)
    expect(entry?.conversationId).toBe(dmId)

    // 未知 scope → 400。
    expect((await app.request("/api/notifications?scope=nope")).status).toBe(400)
  })
})

describe("GET /api/approvals（仅审批，Task 4 修正）", () => {
  it("lists action approvals and excludes asks", async () => {
    const outcome = shout(db, rootId, "全员注意")
    if (!("approval" in outcome)) throw new Error("expected a pending action approval")
    const { ask: stored } = ask(db, rootId, { to: "human", question: "?", options: ["a"] })

    const list = z
      .array(z.object({ id: z.string(), kind: z.string() }))
      .parse(await (await app.request("/api/approvals")).json())

    expect(list.some((approval) => approval.id === outcome.approval.id)).toBe(true)
    expect(list.some((approval) => approval.id === stored.id)).toBe(false)
    expect(list.every((approval) => approval.kind === "action")).toBe(true)
  })
})

describe("POST /api/asks/:id/respond", () => {
  it("answers as human, posts the reply into the card conversation, and maps stable errors", async () => {
    const { ask: stored } = ask(db, rootId, {
      to: "human",
      question: "选哪个",
      options: ["a", "b"],
    })

    const res = await post(`/api/asks/${stored.id}/respond`, { choice: "a" })
    expect(res.status).toBe(200)
    const body = z
      .object({ ok: z.boolean(), ask: z.object({ id: z.string(), status: z.string() }) })
      .parse(await res.json())
    expect(body.ok).toBe(true)
    expect(body.ask.status).toBe("answered")
    expect(getApproval(db, stored.id)?.status).toBe("answered")

    // 卡所在会话新增一条 human 答复消息。
    const answers = history(db, { conversationId: dmId }).filter(
      (message) => message.fromAgentId === humanId && message.meta?.["askId"] === stored.id,
    )
    expect(answers).toHaveLength(1)
    expect(answers[0]?.body).toContain("a")

    // 重复 → 409 语义错误。
    const duplicate = await post(`/api/asks/${stored.id}/respond`, { choice: "b" })
    expect(duplicate.status).toBe(409)
    expect(errorBodySchema.parse(await duplicate.json()).error).toBe("ask_already_answered")

    // 非法 choice → 400。
    const { ask: second } = ask(db, rootId, { to: "human", question: "?", options: ["x"] })
    const invalid = await post(`/api/asks/${second.id}/respond`, { choice: "z" })
    expect(invalid.status).toBe(400)
    expect(errorBodySchema.parse(await invalid.json()).error).toBe("invalid_choice")

    // 未知单 / 非法 body → 404 / 400。
    expect((await post("/api/asks/nope/respond", { choice: "a" })).status).toBe(404)
    expect((await post(`/api/asks/${second.id}/respond`, {})).status).toBe(400)
  })
})

describe("POST /api/notifications/:id/read", () => {
  it("sets read_at idempotently without changing actionable membership", async () => {
    const { ask: stored } = ask(db, rootId, { to: "human", question: "?", options: ["a"] })
    expect(getApproval(db, stored.id)?.readAt).toBeUndefined()

    const first = await post(`/api/notifications/${stored.id}/read`, {})
    expect(first.status).toBe(200)
    expect(readBodySchema.parse(await first.json()).read).toBe(true)
    const readAt = getApproval(db, stored.id)?.readAt
    expect(readAt).toEqual(expect.any(Number))

    // 幂等：第二次不再置位，`read_at` 不变。
    const second = await post(`/api/notifications/${stored.id}/read`, {})
    expect(readBodySchema.parse(await second.json()).read).toBe(false)
    expect(getApproval(db, stored.id)?.readAt).toBe(readAt)

    // 已读不改变 actionable 归属：列表仍含该单，且带 readAt。
    const actionable = notificationListSchema.parse(
      await (await app.request("/api/notifications?scope=actionable")).json(),
    )
    const entry = actionable.find((item) => item.id === stored.id)
    expect(entry).toBeDefined()
    expect(entry?.readAt).toBe(readAt)

    // 未知单 → 404。
    expect((await post("/api/notifications/nope/read", {})).status).toBe(404)
  })
})

// ── Fix 1：ask 守卫（审批端点先拒，绝不 decide 改写 ask） ─────────────

describe("POST /api/approvals/:id（ask 守卫，Fix 1）", () => {
  it("rejects an ask id before decide: 404 ask_not_found, status stays pending and still answerable", async () => {
    const { ask: stored } = ask(db, rootId, { to: "human", question: "选哪个", options: ["a", "b"] })

    const res = await post(`/api/approvals/${stored.id}`, { decision: "approve" })
    expect(res.status).toBe(404)
    expect(errorBodySchema.parse(await res.json()).error).toBe("ask_not_found")
    // 关键：守卫在任何状态写入之前生效 —— 该 ask 未被 decide 改写，仍为 pending。
    expect(getApproval(db, stored.id)?.status).toBe("pending")

    // 仍可经 ask 通道答复（respondAsk 未被 AskForbiddenError 锁死）。
    const answered = respondAsk(db, stored.id, humanId, { choice: "a" })
    expect(answered.status).toBe("answered")
    expect(getApproval(db, stored.id)?.status).toBe("answered")
  })

  it("still decides an action approval through the existing path (no regression)", async () => {
    const outcome = shout(db, rootId, "全员注意")
    if (!("approval" in outcome)) throw new Error("expected a pending action approval")

    const res = await post(`/api/approvals/${outcome.approval.id}`, { decision: "reject" })
    expect(res.status).toBe(200)
    const body = z
      .object({
        ok: z.boolean(),
        approval: z.object({ id: z.string(), kind: z.string(), status: z.string() }),
      })
      .parse(await res.json())
    expect(body.ok).toBe(true)
    expect(body.approval.kind).toBe("action")
    expect(body.approval.status).toBe("rejected")
    expect(getApproval(db, outcome.approval.id)?.status).toBe("rejected")

    // 单不存在仍为 404 `approval_not_found`（既有契约不回归）。
    const missing = await post("/api/approvals/nope", { decision: "approve" })
    expect(missing.status).toBe(404)
    expect(errorBodySchema.parse(await missing.json()).error).toBe("approval_not_found")
  })
})
