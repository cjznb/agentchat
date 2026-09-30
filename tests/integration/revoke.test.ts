/**
 * 撤回排队中消息（feat/revoke-queued）—— Hub 侧集成测试（尽力撤回语义）。
 *
 * - 仅发送方可撤（403 `not_sender`）；消息不存在 / 不属于该会话 → 404 `message_not_found`
 * - 幂等：已撤回再撤不落第二条 system 消息
 * - 仅取消该消息**未投递**的 job（pending/sending → cancelled）；accepted/read 不动
 * - `revoked_at` 落库；恰好一条 `kind='system'` 提醒；WS `message` 事件被发
 * - 四级回执枚举不变（`cancelled → queued`）
 * 每个用例独立临时 $AGENTCHAT_HOME；WS 用进程内环形缓冲断言（无需真连接）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
  RECEIPT_STAGES,
  messageHistorySchema,
  revokeMessageResultSchema,
} from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { registerRoot } from "../../server/core/agents"
import { ack, ensureHuman, sendMessage } from "../../server/core/messaging"
import { receiptState } from "../../server/core/publish"
import {
  maskRevokedForReader,
  MessageNotFoundError,
  NotRevocableError,
  NotSenderError,
  REVOKED_BODY_PLACEHOLDER,
  revokeMessage,
} from "../../server/core/revoke"
import { conversationMessages } from "../../server/core/ui-queries"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { sendView } from "../../server/mcp/context"
import { runConversation } from "../../server/mcp/read-tools"
import { runInbox } from "../../server/mcp/tools"
import { claimWakeBacklog } from "../../server/routes/internal"
import { insertAgent } from "../../server/store/agents"
import { getById, history } from "../../server/store/messages"
import { applyDeliveryResult, getWakeJob } from "../../server/store/wake"
import { claimWakeBacklogJob, requeueExpiredClaims } from "../../server/store/wake-claims"
import { currentWsSeq, framesSince, resetWsHub } from "../../server/ws"

const errorBodySchema = z.object({ ok: z.boolean(), error: z.string() })

let home = ""
let db: Db
let app: Hono
let humanId = ""
let rootId = ""
let dmId = ""
let sentId = ""
let sentSeq = 0

beforeEach(() => {
  resetWsHub()
  home = mkdtempSync(join(tmpdir(), "agentchat-revoke-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  app = createApp(db)
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "revoke-root", vendor: "opencode" }).agent
  const sent = sendMessage(db, { from: human.id, to: root.id, body: "撤回我这条：原始正文" })
  humanId = human.id
  rootId = root.id
  dmId = sent.message.conversationId
  sentId = sent.message.id
  sentSeq = sent.message.seq
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

/** 该会话内「撤回提醒」system 消息（meta.reason='revoke'）。 */
function revokeNotices() {
  return history(db, { conversationId: dmId }).filter(
    (message) => message.kind === "system" && message.meta?.["reason"] === "revoke",
  )
}

describe("core revokeMessage（尽力撤回）", () => {
  it("cancels the undelivered job, stamps revoked_at, lands one system reminder, and emits a message event", () => {
    expect(getWakeJob(db, sentSeq, rootId)?.state).toBe("pending")
    const before = currentWsSeq()

    const revokedAt = revokeMessage(db, {
      conversationId: dmId,
      messageId: sentId,
      actorId: humanId,
      now: 1_000,
    })

    expect(revokedAt).toBe(1_000)
    expect(getById(db, sentId)?.revokedAt).toBe(1_000)
    const job = getWakeJob(db, sentSeq, rootId)
    expect(job?.state).toBe("cancelled")
    expect(job?.detail).toBe("Revoked")

    const notices = revokeNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain("撤回")
    expect(notices[0]?.fromAgentId).toBe(humanId)
    // 提醒自身按普通消息投递：为收件方生成新的 job。
    expect(getWakeJob(db, notices[0]?.seq ?? 0, rootId)?.state).toBe("pending")

    const emitted = framesSince(before) as { readonly type: string }[]
    expect(emitted.some((frame) => frame.type === "message")).toBe(true)
  })

  it("leaves accepted/read recipients untouched (only pending/sending are cancelled)", () => {
    applyDeliveryResult(db, { agentId: rootId, messageSeq: sentSeq, result: "delivered", now: 5 })
    expect(receiptState(db, getById(db, sentId) ?? throwMissing(), rootId)).toBe("delivered")

    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 20 })

    expect(getWakeJob(db, sentSeq, rootId)?.state).toBe("accepted")
    expect(receiptState(db, getById(db, sentId) ?? throwMissing(), rootId)).toBe("delivered")
  })

  it("is idempotent: a second revoke returns the original timestamp and adds no second reminder", () => {
    expect(revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 1_000 })).toBe(1_000)
    expect(revokeNotices()).toHaveLength(1)

    expect(revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 2_000 })).toBe(1_000)
    expect(revokeNotices()).toHaveLength(1)
  })

  it("maps a cancelled job back to queued and keeps the four-stage receipt enum unchanged", () => {
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 1 })
    expect(receiptState(db, getById(db, sentId) ?? throwMissing(), rootId)).toBe("queued")
    expect(RECEIPT_STAGES).toEqual(["queued", "sending", "delivered", "read"])
  })

  it("throws message_not_found for an unknown id or a message from another conversation", () => {
    expect(() =>
      revokeMessage(db, { conversationId: dmId, messageId: "no-such-id", actorId: humanId, now: 1 }),
    ).toThrow(MessageNotFoundError)

    const otherRoot = registerRoot(db, home, { name: "revoke-root-2", vendor: "opencode" }).agent
    const other = sendMessage(db, { from: humanId, to: otherRoot.id, body: "另一会话" })
    expect(() =>
      revokeMessage(db, {
        conversationId: dmId,
        messageId: other.message.id,
        actorId: humanId,
        now: 1,
      }),
    ).toThrow(MessageNotFoundError)
  })

  it("throws not_sender when the actor is not the original sender", () => {
    const peer = sendMessage(db, { from: rootId, to: humanId, body: "root 发出" })
    expect(() =>
      revokeMessage(db, {
        conversationId: dmId,
        messageId: peer.message.id,
        actorId: humanId,
        now: 1,
      }),
    ).toThrow(NotSenderError)
  })
})

describe("POST /api/conversations/:id/messages/:messageId/revoke", () => {
  it("returns 403 not_sender, 404 message_not_found, then 200 with revokedAt and exposes revoked_at over REST", async () => {
    const peer = sendMessage(db, { from: rootId, to: humanId, body: "by root" })
    const forbidden = await post(`/api/conversations/${dmId}/messages/${peer.message.id}/revoke`, {})
    expect(forbidden.status).toBe(403)
    expect(errorBodySchema.parse(await forbidden.json()).error).toBe("not_sender")

    const missing = await post(`/api/conversations/${dmId}/messages/nope/revoke`, {})
    expect(missing.status).toBe(404)
    expect(errorBodySchema.parse(await missing.json()).error).toBe("message_not_found")

    const ok = await post(`/api/conversations/${dmId}/messages/${sentId}/revoke`, {})
    expect(ok.status).toBe(200)
    const body = revokeMessageResultSchema.parse(await ok.json())
    expect(body.ok).toBe(true)
    expect(body.revokedAt).toBeGreaterThan(0)

    const page = messageHistorySchema.parse(
      await (await app.request(`/api/conversations/${dmId}/messages`)).json(),
    )
    expect(page.messages.find((message) => message.id === sentId)?.revoked_at).toEqual(
      expect.any(Number),
    )
  })
})

describe("Critical: 撤回封死未投递收件方的投递路径", () => {
  it("offline recipient (materialized pending row at send): revoke cancels it; wake never delivers the original nor revives a deliverable job", () => {
    const offline = insertAgent(db, {
      name: "revoke-offline",
      kind: "runtime",
      status: "offline",
      vendor: "opencode",
    })
    const sent = sendMessage(db, { from: humanId, to: offline.id, body: "不应送达的原文" })
    // §14.4 资格更新：offline 的 T 收件方发送即有 pending 行（改前断言「无 job」）。
    expect(getWakeJob(db, sent.message.seq, offline.id)).toMatchObject({
      state: "pending",
      pendingReason: null,
    })
    expect(receiptState(db, getById(db, sent.message.id) ?? throwMissing(), offline.id)).toBe("queued")

    revokeMessage(db, {
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      actorId: humanId,
      now: 100,
    })

    const backlog = claimWakeBacklog(db, { agentId: offline.id, now: 200 })
    expect(backlog.messages.some((m) => m.id === sent.message.id)).toBe(false)
    expect(backlog.messages.map((m) => m.body)).not.toContain("不应送达的原文")
    // job 不得处于可投递态：撤回已取消 materialize 的行（cancelled，而非复活为 pending/sending）。
    expect(getWakeJob(db, sent.message.seq, offline.id)?.state).toBe("cancelled")
  })

  it("revoked sending lease is never requeued as deliverable", () => {
    claimWakeBacklog(db, { agentId: rootId, now: 10 }) // pending → sending
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 20 })
    expect(getWakeJob(db, sentSeq, rootId)?.state).toBe("cancelled")

    expect(requeueExpiredClaims(db, 20 + 10 ** 9)).not.toContain(sentSeq)
    const again = claimWakeBacklog(db, { agentId: rootId, now: 20 + 10 ** 9 })
    expect(again.messages.some((m) => m.id === sentId)).toBe(false)
    expect(again.receipts.every((receipt) => receipt.messageId !== sentId)).toBe(true)
  })
})

describe("Important: kind 守卫（仅 text 可撤回，堵死通知自增链）", () => {
  it("rejects revoking the system reminder it just created", () => {
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 1_000 })
    const notice = revokeNotices()[0]
    if (notice === undefined) throw new Error("notice missing")
    expect(() =>
      revokeMessage(db, { conversationId: dmId, messageId: notice.id, actorId: humanId, now: 2_000 }),
    ).toThrow(NotRevocableError)
    expect(revokeNotices()).toHaveLength(1)
  })

  it("route returns 422 not_revocable for a system message", async () => {
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 1_000 })
    const notice = revokeNotices()[0]
    if (notice === undefined) throw new Error("notice missing")
    const res = await post(`/api/conversations/${dmId}/messages/${notice.id}/revoke`, {})
    expect(res.status).toBe(422)
    expect(errorBodySchema.parse(await res.json()).error).toBe("not_revocable")
  })
})

describe("Important: 未投递读者正文遮蔽（读路径单点）", () => {
  it("undelivered reader reads the placeholder while the sender reads the original", () => {
    const offline = insertAgent(db, {
      name: "mask-offline",
      kind: "runtime",
      status: "offline",
      vendor: "opencode",
    })
    const sent = sendMessage(db, { from: humanId, to: offline.id, body: "遮蔽原文" })
    revokeMessage(db, {
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      actorId: humanId,
      now: 100,
    })
    const stored = getById(db, sent.message.id) ?? throwMissing()
    const masked = maskRevokedForReader(db, stored, offline.id)
    expect(masked.body).toBe(REVOKED_BODY_PLACEHOLDER)
    expect(masked.revokedAt).toBe(100)
    expect(maskRevokedForReader(db, stored, humanId).body).toBe("遮蔽原文")
  })

  it("delivered reader reads the original body", () => {
    applyDeliveryResult(db, { agentId: rootId, messageSeq: sentSeq, result: "delivered", now: 5 })
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 20 })
    const stored = getById(db, sentId) ?? throwMissing()
    expect(maskRevokedForReader(db, stored, rootId).body).toBe("撤回我这条：原始正文")
  })

  it("MCP inbox + conversation mask for an undelivered reader", () => {
    const offline = insertAgent(db, {
      name: "mask-mcp",
      kind: "runtime",
      status: "offline",
      vendor: "opencode",
    })
    const sent = sendMessage(db, { from: humanId, to: offline.id, body: "MCP 原文" })
    revokeMessage(db, {
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      actorId: humanId,
      now: 100,
    })
    const ctx = { db, home, agentId: offline.id }
    const inboxOut = runInbox(ctx, {}) as { messages: { id: string; body: string }[] }
    expect(inboxOut.messages.find((m) => m.id === sent.message.id)?.body).toBe(
      REVOKED_BODY_PLACEHOLDER,
    )
    const convOut = runConversation(ctx, { id: sent.message.conversationId }) as {
      messages: { id: string; body: string }[]
    }
    expect(convOut.messages.find((m) => m.id === sent.message.id)?.body).toBe(
      REVOKED_BODY_PLACEHOLDER,
    )
  })

  it("UI conversation read masks for an undelivered (human) reader", () => {
    const fromRoot = sendMessage(db, { from: rootId, to: humanId, body: "root 原文" })
    revokeMessage(db, {
      conversationId: dmId,
      messageId: fromRoot.message.id,
      actorId: rootId,
      now: 100,
    })
    const masked = conversationMessages(db, dmId, humanId).find(
      (m) => m.id === fromRoot.message.id,
    )
    expect(masked?.body).toBe(REVOKED_BODY_PLACEHOLDER)
    expect(masked?.revoked_at).toBe(100)
    // 发送者不受影响（读路径对发送者原样）。
    const stored = getById(db, fromRoot.message.id) ?? throwMissing()
    expect(maskRevokedForReader(db, stored, rootId).body).toBe("root 原文")
  })
})

describe("修复 A: MCP send/shout 的 wait 回复未遮蔽（reader = 调用方）", () => {
  it("undelivered waiter reads the placeholder in reply.messages (revoke cancelled its job)", async () => {
    const bot = insertAgent(db, {
      name: "wait-bot-undelivered",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })
    const pending = sendMessage(db, {
      from: rootId,
      to: bot.id,
      body: "等待回信",
      wait: { until: "message", timeoutMs: 5_000 },
    })
    const incoming = sendMessage(db, { from: bot.id, to: rootId, body: "会被撤回的回复" })
    revokeMessage(db, {
      conversationId: incoming.message.conversationId,
      messageId: incoming.message.id,
      actorId: bot.id,
      now: 500,
    })

    const view = sendView(db, await pending, rootId)
    const reply = view["reply"] as { messages: readonly { id: string; body: string }[] }
    expect(reply.messages.find((m) => m.id === incoming.message.id)?.body).toBe(
      REVOKED_BODY_PLACEHOLDER,
    )
  })

  it("delivered waiter reads the original body in reply.messages", async () => {
    const bot = insertAgent(db, {
      name: "wait-bot-delivered",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })
    const pending = sendMessage(db, {
      from: rootId,
      to: bot.id,
      body: "等待已投递",
      wait: { until: "message", timeoutMs: 5_000 },
    })
    const incoming = sendMessage(db, { from: bot.id, to: rootId, body: "已投递的回复" })
    applyDeliveryResult(db, {
      agentId: rootId,
      messageSeq: incoming.message.seq,
      result: "delivered",
      now: 5,
    })
    revokeMessage(db, {
      conversationId: incoming.message.conversationId,
      messageId: incoming.message.id,
      actorId: bot.id,
      now: 500,
    })

    const view = sendView(db, await pending, rootId)
    const reply = view["reply"] as { messages: readonly { id: string; body: string }[] }
    expect(reply.messages.find((m) => m.id === incoming.message.id)?.body).toBe("已投递的回复")
  })

  it("the revoked message author reads the original through sendView (sender exemption)", () => {
    const bot = insertAgent(db, {
      name: "wait-bot-author",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })
    const sent = sendMessage(db, { from: bot.id, to: rootId, body: "作者原文" })
    revokeMessage(db, {
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      actorId: bot.id,
      now: 7,
    })
    const stored = getById(db, sent.message.id) ?? throwMissing()
    const view = sendView(
      db,
      { message: stored, receipts: [], reply: { timedOut: false, messages: [stored], receipts: [] } },
      bot.id,
    )
    const reply = view["reply"] as { messages: readonly { body: string }[] }
    expect(reply.messages[0]?.body).toBe("作者原文")
  })
})

describe("修复 B: 遮蔽口径收紧（仅已投递/已读保留原文）", () => {
  it("expired recipient (busy 24h, never delivered) is masked", () => {
    db.prepare<[number, string], void>(
      "UPDATE wake_jobs SET state = 'expired', pending_reason = NULL WHERE message_id = ? AND agent_id = ?",
    ).run(sentSeq, rootId)
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 100 })
    const stored = getById(db, sentId) ?? throwMissing()
    expect(maskRevokedForReader(db, stored, rootId).body).toBe(REVOKED_BODY_PLACEHOLDER)
  })

  it("refused recipient (never delivered) is masked", () => {
    applyDeliveryResult(db, { agentId: rootId, messageSeq: sentSeq, result: "refused", now: 1 })
    applyDeliveryResult(db, { agentId: rootId, messageSeq: sentSeq, result: "refused", now: 2 })
    expect(getWakeJob(db, sentSeq, rootId)?.state).toBe("refused")
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 100 })
    const stored = getById(db, sentId) ?? throwMissing()
    expect(maskRevokedForReader(db, stored, rootId).body).toBe(REVOKED_BODY_PLACEHOLDER)
  })

  it("an already-acked reader keeps the original even though the job was cancelled", () => {
    ack(db, rootId, [sentId])
    revokeMessage(db, { conversationId: dmId, messageId: sentId, actorId: humanId, now: 100 })
    expect(getWakeJob(db, sentSeq, rootId)?.state).toBe("cancelled")
    const stored = getById(db, sentId) ?? throwMissing()
    expect(maskRevokedForReader(db, stored, rootId).body).toBe("撤回我这条：原始正文")
  })
})

describe("修复 C: claimWakeBacklogJob 自身撤回守卫（纵深防御）", () => {
  it("refuses to rebuild a wake job for a revoked message", () => {
    const offline = insertAgent(db, {
      name: "defense-offline",
      kind: "runtime",
      status: "offline",
      vendor: "opencode",
    })
    const sent = sendMessage(db, { from: humanId, to: offline.id, body: "纵深防御原文" })
    revokeMessage(db, {
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      actorId: humanId,
      now: 100,
    })
    // §14.4 资格更新：offline 收件方发送即有 pending 行，撤回将其取消（改前断言「无 job」）。
    expect(getWakeJob(db, sent.message.seq, offline.id)?.state).toBe("cancelled")

    const claimed = claimWakeBacklogJob(db, {
      messageSeq: sent.message.seq,
      agentId: offline.id,
      now: 200,
    })
    expect(claimed).toBeUndefined()
    // 纵深防御：不复活——cancelled 行保持 cancelled。
    expect(getWakeJob(db, sent.message.seq, offline.id)?.state).toBe("cancelled")
  })
})

/** 断言辅助：取回消息失败即抛（避免 noUncheckedIndexedAccess 下的 undefined 噪音）。 */
function throwMissing(): never {
  throw new Error("message disappeared")
}
