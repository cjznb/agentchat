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
import { ensureHuman, sendMessage } from "../../server/core/messaging"
import { receiptState } from "../../server/core/publish"
import { MessageNotFoundError, NotSenderError, revokeMessage } from "../../server/core/revoke"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { getById, history } from "../../server/store/messages"
import { applyDeliveryResult, getWakeJob } from "../../server/store/wake"
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

/** 断言辅助：取回消息失败即抛（避免 noUncheckedIndexedAccess 下的 undefined 噪音）。 */
function throwMissing(): never {
  throw new Error("message disappeared")
}
