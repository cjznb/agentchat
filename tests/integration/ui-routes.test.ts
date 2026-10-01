/**
 * Task 9 —— UI REST 集成测试（brief DoD）：
 * - `GET /api/conversations`：双层聚合未读（human 位点 + 每根 `unreadFor`）+ 最后一条预览 + 时间倒序
 * - `POST /api/conversations/:id/messages`：human 发言；未知会话 404；非法 body 400
 * - `GET/POST /api/groups` + `POST /api/groups/:id/members`：human 走既有 gate 即时执行
 * - `POST /api/shout`：写入喊话广播会话
 * - `GET /api/agents/:id`：资料卡（roster 节点 + 参与会话入口）；未知 404
 * Task 5：`GET /api/roster?conversation=` 只返回该群成员（human 豁免）+ 拉人后
 * `kind:"system"` 入群通知（含成员名单、0 wake job）
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
  rosterTreeSchema,
  sendMessageResultSchema,
  wsAgentPayloadSchema,
  wsEventSchema,
  type ChatMessage,
} from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { memberCards, registerLogical, registerRoot, retire } from "../../server/core/agents"
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
import { getAgent, insertAgent } from "../../server/store/agents"
import { getApproval } from "../../server/store/approvals"
import { getConversation, getConversationByKey, isParticipant, SHOUT_KEY } from "../../server/store/conversations"
import { getById, history, send } from "../../server/store/messages"
import { getWakeJob } from "../../server/store/wake"
import { vi } from "vitest"
import { currentWsSeq, framesSince, resetWsHub } from "../../server/ws"

// M2（解散 meta）观测缝：冻结的 WS 四事件封套不载 meta（publish.ts emit 字段固定）、
// 解散消息行随级联删除 → 在 postSystem 写入 seam 捕获载荷；包装 call-through，
// 真实写入+广播行为不变（仅记录）。
const postSystemCapture = vi.hoisted(() => ({
  calls: [] as { meta?: unknown; idempotencyKey?: string }[],
}))
vi.mock("../../server/core/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/core/permissions")>()
  return {
    ...actual,
    postSystem: (
      db: Parameters<typeof actual.postSystem>[0],
      post: Parameters<typeof actual.postSystem>[1],
    ) => {
      postSystemCapture.calls.push(post)
      return actual.postSystem(db, post)
    },
  }
})

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

async function patch(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "PATCH",
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

  // Task 3：human 群发的结构化 mentions 透传（schema → sendMessage → T/回显/meta）。
  it("passes structured mentions through for a group send (echo + meta + wake target)", async () => {
    const created = await post("/api/groups", { name: "t3-ui-mentions", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")

    const res = await post(`/api/conversations/${createdJson.group.id}/messages`, {
      body: "跟进一下",
      mentions: ["ui-root"],
    })
    expect(res.status).toBe(200)
    const raw: unknown = await res.json()
    expect(raw).toMatchObject({
      ok: true,
      mentions: {
        matched: [{ id: rootId, name: "ui-root" }],
        unmatched: [],
        scope: "explicit",
      },
    })
    const json = sendMessageResultSchema.parse(raw)
    expect(json.message.meta).toEqual({ mentions: [rootId], mentionScope: "explicit" })
    expect(getWakeJob(db, json.message.seq, rootId)).toBeDefined() // 被提及者 = 唤醒目标
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

// ── Task 5：`GET /api/roster?conversation=` 按会话过滤 + 入群 system 通知 ────

describe("GET /api/roster?conversation=", () => {
  it("returns only that group's members, each with id and name (human super-observer view)", async () => {
    const created = await post("/api/groups", { name: "t5-filter", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")
    const outsider = insertAgent(db, {
      name: "t5-outsider",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })

    const res = await app.request(`/api/roster?conversation=${createdJson.group.id}`)

    expect(res.status).toBe(200)
    const nodes = rosterTreeSchema.parse(await res.json())
    // 只含该群成员（human owner + root），非成员子节点不出现。
    expect(new Set(nodes.map((node) => node.id))).toEqual(new Set([humanId, rootId]))
    expect(nodes.map((node) => node.id)).not.toContain(outsider.id)
    for (const node of nodes) {
      expect(typeof node.id).toBe("string")
      expect(node.name.length).toBeGreaterThan(0)
    }
  })

  it("keeps the no-parameter behaviour and returns an empty array for unknown/shout conversations", async () => {
    // 不带参数：完整森林，行为与现状一致（既有用例不改即绿）。
    const full = rosterTreeSchema.parse(await (await app.request("/api/roster")).json())
    expect(full.map((node) => node.id)).toEqual(expect.arrayContaining([humanId, rootId]))

    // 未知会话 id → 200 空数组（成员集为空；非成员 agent 在 MCP 侧先被闸门拒绝）。
    const unknown = await app.request("/api/roster?conversation=does-not-exist")
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual([])

    // shout 广播会话（无 participants 行）→ 空数组（选「返回空」，见 task-5 报告）。
    shout(db, humanId, "t5 shout")
    const shoutId = getConversationByKey(db, SHOUT_KEY)?.id ?? ""
    const shoutRes = await app.request(`/api/roster?conversation=${shoutId}`)
    expect(shoutRes.status).toBe(200)
    expect(await shoutRes.json()).toEqual([])
  })
})

describe("POST /api/groups/:id/members（入群 system 通知，Task 5）", () => {
  it("posts a kind:'system' join notice with the member roster and zero wake jobs", async () => {
    const created = await post("/api/groups", { name: "t5-notice", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")
    const newcomer = insertAgent(db, {
      name: "t5-newcomer",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })

    const added = await post(`/api/groups/${createdJson.group.id}/members`, {
      agentId: newcomer.id,
    })
    expect(added.status).toBe(200)

    const notice = history(db, { conversationId: createdJson.group.id }).find(
      (m) => m.kind === "system" && m.body.startsWith("你被拉入群「t5-notice」。成员："),
    )
    if (notice === undefined) throw new Error("expected the join system message in the group")
    // 名单 = 全体成员 <名>(<id前8>)，新成员在列。
    expect(notice.body).toContain(`用户(${humanId.slice(0, 8)})`)
    expect(notice.body).toContain(`ui-root(${rootId.slice(0, 8)})`)
    expect(notice.body).toContain(`t5-newcomer(${newcomer.id.slice(0, 8)})`)
    // kind:"system" 豁免回归锁：入群通知 0 wake job（对每一名成员）。
    for (const agentId of [humanId, rootId, newcomer.id]) {
      expect(getWakeJob(db, notice.seq, agentId)).toBeUndefined()
    }
  })
})

// ── 批次2轮D F2：群成员移除 + 解散群聊（human UI 专属，不进 MCP 工具面） ──

describe("POST /api/groups/:id/members/remove（移除成员）", () => {
  it("removes the member and posts a kind:'system' notice to the remaining roster with zero wake", async () => {
    const created = await post("/api/groups", { name: "t-d-remove", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")
    const child = insertAgent(db, {
      name: "t-d-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    await post(`/api/groups/${createdJson.group.id}/members`, { agentId: child.id })

    const res = await post(`/api/groups/${createdJson.group.id}/members/remove`, {
      agentId: child.id,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(isParticipant(db, createdJson.group.id, child.id)).toBe(false)

    // 余下成员（human + root）即为群成员全集。
    const after = groupListSchema.parse(await (await app.request("/api/groups")).json())
    const listed = after.groups.find((group) => group.id === createdJson.group.id)
    expect(new Set(listed?.members)).toEqual(new Set([humanId, rootId]))

    // 通知形状：kind=system + 移出语义正文 + 余下成员在会话历史可见 + 0 wake job。
    const notice = history(db, { conversationId: createdJson.group.id }).find(
      (m) => m.kind === "system" && m.body.startsWith("「t-d-child」已移出群「t-d-remove」"),
    )
    if (notice === undefined) throw new Error("expected the removal system notice in the group")
    // M2：meta.action 取值锁定（冻结设计点名 group_remove + 目标 agentId）。
    expect(notice.meta).toMatchObject({ action: "group_remove", agentId: child.id })
    expect(notice.body).toContain(`用户(${humanId.slice(0, 8)})`)
    expect(notice.body).toContain(`ui-root(${rootId.slice(0, 8)})`)
    for (const agentId of [humanId, rootId, child.id]) {
      expect(getWakeJob(db, notice.seq, agentId)).toBeUndefined()
    }
  })

  it("rejects last-member 409 / not-in-group 404 / non-group 400 / unknown 404 / bad body 400", async () => {
    // 删到 0：仅剩 human 一人的群 → 409 稳定码。
    const soloCreated = groupCreateResultSchema.parse(
      await (await post("/api/groups", { name: "t-d-solo" })).json(),
    )
    if (!("group" in soloCreated)) throw new Error("human group creation must execute immediately")
    const last = await post(`/api/groups/${soloCreated.group.id}/members/remove`, {
      agentId: humanId,
    })
    expect(last.status).toBe(409)
    expect(await last.json()).toEqual({ ok: false, error: "cannot_remove_last_member" })

    const created = groupCreateResultSchema.parse(
      await (await post("/api/groups", { name: "t-d-guard", memberIds: [rootId] })).json(),
    )
    if (!("group" in created)) throw new Error("human group creation must execute immediately")
    const outsider = insertAgent(db, {
      name: "t-d-outsider",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    const notIn = await post(`/api/groups/${created.group.id}/members/remove`, {
      agentId: outsider.id,
    })
    expect(notIn.status).toBe(404)
    expect(await notIn.json()).toEqual({ ok: false, error: "not_in_group" })

    const nonGroup = await post(`/api/groups/${dmId}/members/remove`, { agentId: rootId })
    expect(nonGroup.status).toBe(400)
    expect(await nonGroup.json()).toEqual({ ok: false, error: "not_group" })

    const unknown = await post("/api/groups/does-not-exist/members/remove", { agentId: rootId })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ ok: false, error: "conversation_not_found" })

    const bad = await post(`/api/groups/${created.group.id}/members/remove`, {})
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: "invalid_body" })
  })
})

describe("POST /api/groups/:id/dissolve（解散群聊）", () => {
  it("broadcasts a kind:'system' dissolve notice in the message envelope, then deletes rows", async () => {
    const created = groupCreateResultSchema.parse(
      await (await post("/api/groups", { name: "t-d-gone", memberIds: [rootId] })).json(),
    )
    if (!("group" in created)) throw new Error("human group creation must execute immediately")
    // 群内先落一条普通消息（消息行按外键现实随解散级联处置）。
    const sent = await post(`/api/conversations/${created.group.id}/messages`, {
      body: "解散前的话",
    })
    expect(sent.status).toBe(200)

    const before = currentWsSeq()
    const res = await post(`/api/groups/${created.group.id}/dissolve`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // 广播复用既有 message 封套（type=message + kind=system + 「群已解散」语义）。
    // 注：冻结四事件封套不载 meta（publish.ts emit 字段固定）→ meta.action 在 postSystem seam 锁定（见下）。
    const frames = framesSince(before).map((frame) => JSON.stringify(frame))
    expect(
      frames.some(
        (frame) =>
          frame.includes('"type":"message"') &&
          frame.includes('"kind":"system"') &&
          frame.includes("已解散"),
      ),
    ).toBe(true)

    // M2：meta.action 取值锁定（group_dissolve + 会话 id；经 postSystem seam 捕获，call-through 真实执行）。
    const captured = postSystemCapture.calls.find(
      (post) => post.idempotencyKey === `group-dissolve:${created.group.id}`,
    )
    expect(captured?.meta).toMatchObject({
      action: "group_dissolve",
      agentId: created.group.id,
    })

    // 落地：participants + conversation 删除；消息行随级联删除；列表不再含该群。
    expect(getConversation(db, created.group.id)).toBeUndefined()
    expect(isParticipant(db, created.group.id, humanId)).toBe(false)
    expect(isParticipant(db, created.group.id, rootId)).toBe(false)
    expect(history(db, { conversationId: created.group.id })).toEqual([])
    const list = groupListSchema.parse(await (await app.request("/api/groups")).json())
    expect(list.groups.some((group) => group.id === created.group.id)).toBe(false)
  })

  it("rejects a non-group conversation (400) and an unknown conversation (404)", async () => {
    const nonGroup = await post(`/api/groups/${dmId}/dissolve`, {})
    expect(nonGroup.status).toBe(400)
    expect(await nonGroup.json()).toEqual({ ok: false, error: "not_group" })
    const unknown = await post("/api/groups/does-not-exist/dissolve", {})
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ ok: false, error: "conversation_not_found" })
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

// ── Task 6：PATCH /api/agents/:id 改名（展示名优先级 + 409 name_taken + agent 事件广播） ──

describe("PATCH /api/agents/:id（Task 6 改名）", () => {
  it("200 返回新展示名，custom_name 落库、系统 name 不动，并广播一条既有 agent 事件", async () => {
    resetWsHub()
    const before = currentWsSeq()

    const res = await patch(`/api/agents/${rootId}`, { name: "  改名后的根  " })

    expect(res.status).toBe(200)
    const body = z.object({ ok: z.boolean(), name: z.string() }).parse(await res.json())
    expect(body).toEqual({ ok: true, name: "改名后的根" }) // trim 生效
    const stored = getAgent(db, rootId)
    expect(stored?.customName).toBe("改名后的根")
    expect(stored?.name).toBe("ui-root") // 系统名不动（register/标题同步只写 name 的对偶面）

    // 广播既有 `agent` 事件（四事件之一，无新增事件类型）。
    expect(currentWsSeq()).toBe(before + 1)
    const events = framesSince(before)
    expect(events).toHaveLength(1)
    const event = wsEventSchema.parse(events[0])
    expect(event.type).toBe("agent")
    const payload = wsAgentPayloadSchema.parse(event.payload)
    expect(payload.tree.find((node) => node.id === rootId)?.name).toBe("改名后的根")
  })

  it("400 invalid_body：空串 / 纯空白 / 超 64 字 / 控制字符 / 缺 name / 非 JSON 体", async () => {
    const badPayloads: readonly unknown[] = [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(65) },
      { name: "a\u0007b" },
      { name: "a\nb" },
      {},
      { name: 42 },
    ]
    for (const payload of badPayloads) {
      const res = await patch(`/api/agents/${rootId}`, payload)
      expect(res.status).toBe(400)
      expect(errorBodySchema.parse(await res.json()).error).toBe("invalid_body")
    }
    const raw = await app.request(`/api/agents/${rootId}`, { method: "PATCH", body: "not-json" })
    expect(raw.status).toBe(400)
  })

  it("404 agent_not_found：未知 id", async () => {
    const res = await patch("/api/agents/no-such-agent", { name: "x" })
    expect(res.status).toBe(404)
    expect(errorBodySchema.parse(await res.json()).error).toBe("agent_not_found")
  })

  it("409 name_taken：与他人展示名冲突（裸名与 custom_name 两种口径）", async () => {
    const other = insertAgent(db, {
      name: "t6-other",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })

    // 冲突目标是他人裸名（custom_name NULL → 展示名 = name）。
    const rawConflict = await patch(`/api/agents/${rootId}`, { name: "t6-other" })
    expect(rawConflict.status).toBe(409)
    expect(errorBodySchema.parse(await rawConflict.json()).error).toBe("name_taken")

    // 冲突目标是他人 custom_name。
    const renamed = await patch(`/api/agents/${other.id}`, { name: "t6-独占展示名" })
    expect(renamed.status).toBe(200)
    const customConflict = await patch(`/api/agents/${rootId}`, { name: "t6-独占展示名" })
    expect(customConflict.status).toBe(409)
    expect(errorBodySchema.parse(await customConflict.json()).error).toBe("name_taken")
  })
})

// ── Task 6 回归点：roster / 入群通知 / send 提及回显全部切展示名 ──────────────

describe("Task 6 展示名回归（roster / joinNotice / send 回显）", () => {
  it("回归①：改名后 roster（rosterTree / conversationRoster / member_cards 三输出）用展示名", async () => {
    const res = await patch(`/api/agents/${rootId}`, { name: "展示名R" })
    expect(res.status).toBe(200)

    const tree = rosterTreeSchema.parse(await (await app.request("/api/roster")).json())
    expect(tree.find((node) => node.id === rootId)?.name).toBe("展示名R")

    const created = await post("/api/groups", { name: "t6-display-group", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")

    const filtered = rosterTreeSchema.parse(
      await (await app.request(`/api/roster?conversation=${createdJson.group.id}`)).json(),
    )
    expect(filtered.find((node) => node.id === rootId)?.name).toBe("展示名R")
    expect(memberCards(db, createdJson.group.id).find((card) => card.id === rootId)?.name).toBe(
      "展示名R",
    )
  })

  it("回归②：入群通知成员名单用展示名（joinNotice 独立取名点）", async () => {
    expect((await patch(`/api/agents/${rootId}`, { name: "展示名N" })).status).toBe(200)
    const created = await post("/api/groups", { name: "t6-notice-display", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")
    const newcomer = insertAgent(db, {
      name: "t6-newcomer-display",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })

    const added = await post(`/api/groups/${createdJson.group.id}/members`, {
      agentId: newcomer.id,
    })
    expect(added.status).toBe(200)

    const notice = history(db, { conversationId: createdJson.group.id }).find(
      (m) => m.kind === "system" && m.body.startsWith("你被拉入群「t6-notice-display」。成员："),
    )
    if (notice === undefined) throw new Error("expected the join system message in the group")
    expect(notice.body).toContain(`展示名N(${rootId.slice(0, 8)})`)
    expect(notice.body).not.toContain(`ui-root(${rootId.slice(0, 8)})`)
  })

  it("回归③：send 提及回显与唤醒集合用展示名（routeWake 取名点）", async () => {
    expect((await patch(`/api/agents/${rootId}`, { name: "展示名M" })).status).toBe(200)
    const created = await post("/api/groups", { name: "t6-echo-display", memberIds: [rootId] })
    const createdJson = groupCreateResultSchema.parse(await created.json())
    if (!("group" in createdJson)) throw new Error("human group creation must execute immediately")

    const res = await post(`/api/conversations/${createdJson.group.id}/messages`, {
      body: "@展示名M 跟进",
      mentions: ["展示名M"],
    })
    expect(res.status).toBe(200)
    const raw: unknown = await res.json()
    expect(raw).toMatchObject({
      ok: true,
      mentions: { matched: [{ id: rootId, name: "展示名M" }], unmatched: [], scope: "explicit" },
    })
    const json = sendMessageResultSchema.parse(raw)
    expect(json.message.meta).toEqual({ mentions: [rootId], mentionScope: "explicit" })
    expect(getWakeJob(db, json.message.seq, rootId)).toBeDefined()
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

  it("§14.2 P2 红证：被@群聊回执仅被@者，聚合 stage 不被无任务成员拖死", async () => {
    const child = insertAgent(db, {
      name: "p2-child",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      parentId: rootId,
    })
    const group = createGroup(db, {
      name: "p2-group",
      createdBy: humanId,
      memberIds: [rootId, child.id],
    })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")
    const gid = group.approved.id

    // 仅 @root（结构化 id 前 8 位）→ T = {root}；child 无任务。
    const sent = sendMessage(db, {
      from: humanId,
      to: gid,
      body: "处理一下",
      mentions: [rootId.slice(0, 8)],
    })
    // 改前 = 全员 {root, child}（child 恒 queued）→ 必红。
    expect(sent.receipts).toEqual([{ agentId: rootId, stage: "queued" }])

    // 有任务者推进到 accepted（派生 delivered）→ 聚合必须跟随推进。
    db.prepare<[string, number, string], void>(
      "UPDATE wake_jobs SET state = ? WHERE message_id = ? AND agent_id = ?",
    ).run("accepted", sent.message.seq, rootId)
    const page = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${gid}/messages`)).json(),
    )
    const own = page.messages.find((message) => message.id === sent.message.id)
    // 改前：无任务 child 恒 queued → 聚合取最落后 = queued（气泡永卡「排队中」）。
    expect(stageMap(own)).toEqual({ [rootId]: "delivered" })
    expect(own?.receiptStage).toBe("delivered")
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
