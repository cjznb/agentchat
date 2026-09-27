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
import {
  agentCardSchema,
  conversationListSchema,
  conversationReadResultSchema,
  ensureDmResultSchema,
  groupCreateResultSchema,
  groupListSchema,
  messageHistorySchema,
  notificationListSchema,
  notificationReadResultSchema,
  sendMessageResultSchema,
  type ChatMessage,
} from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { registerLogical, registerRoot, retire } from "../../server/core/agents"
import {
  ack,
  createGroup,
  ensureHuman,
  receiptState,
  recipientsOf,
  sendMessage,
  shout,
} from "../../server/core/messaging"
import { ask, respondAsk } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { insertAgent } from "../../server/store/agents"
import { getApproval } from "../../server/store/approvals"
import { getConversation, getConversationByKey, isParticipant, SHOUT_KEY } from "../../server/store/conversations"
import { getById, history, send } from "../../server/store/messages"

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

// F8：出参一律用 **shared/contracts** 的单一 schema 源解析（不再在测试内复制宽松 schema），
// 并对计划外新增字段（群 kind/members/createdAt、通知 requesterAgentId）做**取值断言**。

describe("GET /api/conversations", () => {
  it("aggregates human unread + last preview and per-root double-aggregate unread", async () => {
    const res = await app.request("/api/conversations")
    expect(res.status).toBe(200)
    const body = conversationListSchema.parse(await res.json())

    const dm = body.conversations.find((conversation) => conversation.id === dmId)
    expect(dm?.lastMessage?.body).toBe("pong")
    expect(dm?.unread).toBe(1) // human 未读 = root 发来的 pong（hello 为 human 自发）
    expect(dm?.createdAt).toBeGreaterThan(0) // 会话创建时间随列表返回（Plan 3 T7）
    expect(body.unreadByRoot[rootId]).toBe(1) // root 未读 = human 发来的 hello
  })
})

describe("POST /api/conversations/:id/messages", () => {
  it("lets the human speak in an existing conversation", async () => {
    const res = await post(`/api/conversations/${dmId}/messages`, { body: "yo" })
    expect(res.status).toBe(200)
    const json = sendMessageResultSchema.parse(await res.json())
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
    // F8：用 shared `groupCreateResultSchema` 解析完整响应并断言实际值。
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")
    expect(createdJson.group.kind).toBe("group")
    expect(createdJson.group.createdBy).toBe(humanId)
    expect(createdJson.group.createdAt).toBeGreaterThan(0)

    // F8：`GET /api/groups` 新增 `kind`/`members`/`createdAt` 用 shared schema 解析并取值断言。
    const list = groupListSchema.parse(await (await app.request("/api/groups")).json())
    const listed = list.groups.find((group) => group.id === createdJson.group.id)
    expect(listed?.kind).toBe("group")
    expect(listed?.createdAt).toBeGreaterThan(0)
    expect(listed?.members).toContain(rootId)

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

    // 成员集合经 shared schema 解析后如实反映新增成员（kind/members 非仅 parse 通过）。
    const afterAdd = groupListSchema.parse(await (await app.request("/api/groups")).json())
    const updated = afterAdd.groups.find((group) => group.id === createdJson.group.id)
    expect(new Set(updated?.members)).toEqual(new Set([humanId, rootId, child.id]))
  })
})

describe("POST /api/shout", () => {
  it("broadcasts a human shout into the shout conversation", async () => {
    const res = await post("/api/shout", { body: "everyone" })
    expect(res.status).toBe(200)
    const json = sendMessageResultSchema.parse(await res.json())
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
    // F8：`requesterAgentId` 取真实发起方（不再仅靠 schema parse 通过）。
    expect(entry?.requesterAgentId).toBe(rootId)
    expect(entry?.createdAt).toBeGreaterThan(0)

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
    expect(notificationReadResultSchema.parse(await first.json()).read).toBe(true)
    const readAt = getApproval(db, stored.id)?.readAt
    expect(readAt).toEqual(expect.any(Number))

    // 幂等：第二次不再置位，`read_at` 不变。
    const second = await post(`/api/notifications/${stored.id}/read`, {})
    expect(notificationReadResultSchema.parse(await second.json()).read).toBe(false)
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

// ── Task 1：human 会话读位点（POST /api/conversations/:id/read） ─────

describe("POST /api/conversations/:id/read", () => {
  it("advances the human cursor to the latest seq, is idempotent, and leaves other conversations untouched", async () => {
    // 第二会话自带未读（child → human），用于验证「其他会话不受影响」。
    const child = insertAgent(db, {
      name: "ui-read-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })
    const secondDm = sendMessage(db, { from: child.id, to: humanId, body: "ping" }).message
      .conversationId

    const before = conversationListSchema.parse(
      await (await app.request("/api/conversations")).json(),
    )
    expect(before.conversations.find((c) => c.id === dmId)?.unread).toBe(1)
    expect(before.conversations.find((c) => c.id === secondDm)?.unread).toBe(1)

    const res = await post(`/api/conversations/${dmId}/read`, {})
    expect(res.status).toBe(200)
    const body = conversationReadResultSchema.parse(await res.json())
    expect(body.ok).toBe(true)
    expect(body.lastReadSeq).toBeGreaterThan(0)

    const after = conversationListSchema.parse(
      await (await app.request("/api/conversations")).json(),
    )
    expect(after.conversations.find((c) => c.id === dmId)?.unread).toBe(0)
    expect(after.conversations.find((c) => c.id === secondDm)?.unread).toBe(1)

    // 幂等：重复调用仍 200、值不变，其他会话仍不受影响。
    const again = await post(`/api/conversations/${dmId}/read`, {})
    expect(again.status).toBe(200)
    expect(conversationReadResultSchema.parse(await again.json()).lastReadSeq).toBe(body.lastReadSeq)
    const afterAgain = conversationListSchema.parse(
      await (await app.request("/api/conversations")).json(),
    )
    expect(afterAgain.conversations.find((c) => c.id === dmId)?.unread).toBe(0)
    expect(afterAgain.conversations.find((c) => c.id === secondDm)?.unread).toBe(1)
  })

  it("returns 404 conversation_not_found for an unknown conversation", async () => {
    const res = await post("/api/conversations/does-not-exist/read", {})
    expect(res.status).toBe(404)
    expect(errorBodySchema.parse(await res.json()).error).toBe("conversation_not_found")
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

// ── Plan 3 T3：会话历史分页路由（GET /api/conversations/:id/messages） ──

describe("GET /api/conversations/:id/messages（Plan 3 T3）", () => {
  it("returns the latest page ascending, pages backwards with before, and honours limit", async () => {
    const third = sendMessage(db, { from: humanId, to: rootId, body: "third" })

    const latest = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages`)).json(),
    )
    expect(latest.messages.map((message) => message.body)).toEqual(["hello", "pong", "third"])
    expect(latest.messages.map((message) => message.fromAgentId)).toEqual([humanId, rootId, humanId])

    const earlier = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages?before=${third.message.seq}`)).json(),
    )
    expect(earlier.messages.map((message) => message.body)).toEqual(["hello", "pong"])

    const limited = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages?limit=1`)).json(),
    )
    expect(limited.messages.map((message) => message.body)).toEqual(["third"])
  })

  it("maps an unknown conversation to 404 and invalid before/limit to 400", async () => {
    expect((await app.request("/api/conversations/nope/messages")).status).toBe(404)
    expect((await app.request(`/api/conversations/${dmId}/messages?before=-1`)).status).toBe(400)
    expect((await app.request(`/api/conversations/${dmId}/messages?before=abc`)).status).toBe(400)
    expect((await app.request(`/api/conversations/${dmId}/messages?limit=0`)).status).toBe(400)
    expect((await app.request(`/api/conversations/${dmId}/messages?limit=201`)).status).toBe(400)
    expect((await app.request(`/api/conversations/${dmId}/messages?limit=abc`)).status).toBe(400)
  })
})

// ── Plan 3 T5 决议 1：自有消息四级回执进 REST（复用 receiptState，无新状态机） ──

/** 取某条消息的收据映射 `{agentId: stage}`（缺字段 → undefined，便于断言「不带」）。 */
function stageMap(message: ChatMessage | undefined) {
  if (message?.receipts === undefined) return undefined
  return Object.fromEntries(message.receipts.map((r) => [r.agentId, r.stage]))
}

describe("GET /api/conversations/:id/messages（回执字段）", () => {
  it("decorates an own message: queued receipts, then read after core ack; peer message stays bare", async () => {
    const sent = sendMessage(db, { from: humanId, to: rootId, body: "receipts?" })
    const ownId = sent.message.id

    const before = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages`)).json(),
    )
    const own = before.messages.find((message) => message.id === ownId)
    expect(own?.fromAgentId).toBe(humanId)
    expect(own?.receipts).toEqual([{ agentId: rootId, stage: "queued" }])
    expect(own?.receiptStage).toBe("queued")

    // 非己方消息（root 的 pong）不回执。
    const peer = before.messages.find((message) => message.fromAgentId === rootId)
    expect(peer?.receipts).toBeUndefined()
    expect(peer?.receiptStage).toBeUndefined()

    // core ack → 聚合（与逐条）回执 → read。
    expect(ack(db, rootId, [ownId])).toBe(1)
    const after = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages`)).json(),
    )
    const ownAfter = after.messages.find((message) => message.id === ownId)
    expect(ownAfter?.receipts).toEqual([{ agentId: rootId, stage: "read" }])
    expect(ownAfter?.receiptStage).toBe("read")
  })

  it("keeps per-recipient stages independent; aggregate takes the laggard in a group", async () => {
    const child = insertAgent(db, {
      name: "t5-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    const group = createGroup(db, {
      name: "t5-group",
      createdBy: humanId,
      memberIds: [rootId, child.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")
    const gid = group.approved.id

    const sent = sendMessage(db, { from: humanId, to: gid, body: "hi group" })
    // 仅子节点 ack：子 read、根仍 queued；聚合取最落后 → queued。
    expect(ack(db, child.id, [sent.message.id])).toBe(1)

    const page = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${gid}/messages`)).json(),
    )
    const own = page.messages.find((message) => message.id === sent.message.id)
    expect(stageMap(own)).toEqual({ [rootId]: "queued", [child.id]: "read" })
    expect(own?.receiptStage).toBe("queued")
  })

  it("never decorates system messages", async () => {
    const system = send(db, {
      conversationId: dmId,
      fromAgentId: humanId,
      body: "X 加入群聊",
      kind: "system",
    })
    const page = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages`)).json(),
    )
    const found = page.messages.find((message) => message.id === system.id)
    expect(found?.kind).toBe("system")
    expect(found?.receipts).toBeUndefined()
    expect(found?.receiptStage).toBeUndefined()
  })

  it("batch derivation equals per-message receiptState for a multi-recipient shout (I3)", async () => {
    const child = insertAgent(db, {
      name: "t5-shout-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    const outcome = shout(db, humanId, "shout-all")
    if (!("approved" in outcome)) throw new Error("human shout must execute immediately")
    const sent = outcome.approved.message
    // 仅 child ack → child read、root queued；聚合取最落后 → queued。
    expect(ack(db, child.id, [sent.id])).toBe(1)

    const page = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${sent.conversationId}/messages`)).json(),
    )
    const own = page.messages.find((message) => message.id === sent.id)
    const stored = getById(db, sent.id)
    const conversation = getConversation(db, sent.conversationId)
    if (stored === undefined || conversation === undefined) {
      throw new Error("shout message/conversation missing")
    }
    // 批量路径（路由出参）必须与逐条 `receiptState` 逐字一致。
    const direct = Object.fromEntries(
      recipientsOf(db, conversation, stored.fromAgentId).map((agentId) => [
        agentId,
        receiptState(db, stored, agentId),
      ]),
    )
    expect(stageMap(own)).toEqual(direct)
    expect(direct[child.id]).toBe("read")
    expect(direct[rootId]).toBe("queued")
    expect(own?.receiptStage).toBe("queued")
  })
})

// ── Plan 3 T6：确保 DM（POST /api/conversations） ─────────────────────

describe("POST /api/conversations（Plan 3 T6 确保 DM）", () => {
  it("ensures the human↔node DM idempotently and parses via the contract schema", async () => {
    // beforeEach 已存在 human↔root 的 DM（hello）：ensure 应取回同一条（不新建）。
    const first = await post("/api/conversations", { to: rootId })
    expect(first.status).toBe(200)
    const body = ensureDmResultSchema.parse(await first.json())
    expect(body.conversation.kind).toBe("dm")
    expect(body.conversation.id).toBe(dmId)
    expect(isParticipant(db, body.conversation.id, humanId)).toBe(true)
    expect(isParticipant(db, body.conversation.id, rootId)).toBe(true)

    // 幂等复用：第二次返回同一 conversationId。
    const second = await post("/api/conversations", { to: rootId })
    expect(second.status).toBe(200)
    expect(ensureDmResultSchema.parse(await second.json()).conversation.id).toBe(body.conversation.id)
  })

  it("creates a DM for a logical node target (allowed; 逻辑节点收件箱常开)", async () => {
    const logical = registerLogical(db, { name: "dm-board" })
    const res = await post("/api/conversations", { to: logical.id })
    expect(res.status).toBe(200)
    const body = ensureDmResultSchema.parse(await res.json())
    expect(body.conversation.kind).toBe("dm")
    expect(isParticipant(db, body.conversation.id, logical.id)).toBe(true)
    expect(isParticipant(db, body.conversation.id, humanId)).toBe(true)
  })

  it("returns 409 recipient_retired for a retired target (F3②)", async () => {
    const target = registerRoot(db, home, { name: "retired-root", vendor: "opencode" }).agent
    retire(db, target.id)
    const res = await post("/api/conversations", { to: target.id })
    expect(res.status).toBe(409)
    expect(errorBodySchema.parse(await res.json()).error).toBe("recipient_retired")
  })

  it("returns 404 recipient_not_found for an unknown target", async () => {
    const res = await post("/api/conversations", { to: "no-such-agent" })
    expect(res.status).toBe(404)
    expect(errorBodySchema.parse(await res.json()).error).toBe("recipient_not_found")
  })

  it("returns 400 invalid_recipient when the target is the human itself", async () => {
    const res = await post("/api/conversations", { to: humanId })
    expect(res.status).toBe(400)
    expect(errorBodySchema.parse(await res.json()).error).toBe("invalid_recipient")
  })

  it("returns 400 invalid_body for missing/empty/non-string to and a non-JSON body", async () => {
    const payloads: readonly unknown[] = [{}, { to: "" }, { to: 123 }, { to: null }]
    for (const payload of payloads) {
      const res = await post("/api/conversations", payload)
      expect(res.status).toBe(400)
      expect(errorBodySchema.parse(await res.json()).error).toBe("invalid_body")
    }
    // 无 body / 非 JSON：`c.req.json().catch(() => undefined)` → invalid_body。
    const raw = await app.request("/api/conversations", { method: "POST" })
    expect(raw.status).toBe(400)
    expect(errorBodySchema.parse(await raw.json()).error).toBe("invalid_body")
  })
})
