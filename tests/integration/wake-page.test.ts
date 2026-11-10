/**
 * P2 回归（task-8）：`/internal/wake` 认领页饥饿 → 永久 `pending`。
 *
 * 缺陷：认领固定 `after=0, LIMIT 50` 取**最旧 50 条**，再在 JS 里 `continue` 跳过
 * 已投递/无 job/终态/自发/已撤回的行 —— 窗口永不前进。收件方累计可见消息 >50 后，
 * 新消息永远进不了这一页：探针 B 确定性复现「60 条 DM → 第 1 轮 50、第 2/3 轮恒 0，
 * 剩 10 条永久 pending」。
 *
 * 本文件锁死修复后的可推进性（每例都是改前必红的确定性场景）：
 * - 60 条 DM 连续 wake 直到取空（50 → 10 → 0），无永久 pending
 * - 窗口被 55 条**不可认领行**占满（已投递 / 已读 / 已撤回）时，后到的 5 条仍可认领
 * - system 豁免（无 job 行）不被窗口挤掉，且仍按原路径补建 `sending` 租约
 * - 单次响应规模仍由 `DEFAULT_INBOX_LIMIT` 封顶（120 条 → 50/50/20）
 * 全部走注入时钟（无 sleep）；HTTP 用例走真路由 + 真 `hub_token`。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearAdapters } from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { ack, receiptState, sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { claimWakeBacklog, ensureHubToken } from "../../server/routes/internal"
import { insertAgent, type Agent } from "../../server/store/agents"
import { markRevoked, send as storeSend, type Message } from "../../server/store/messages"
import { applyDeliveryResult, getWakeJob } from "../../server/store/wake"

let home = ""
let db: Db
let app: Hono
let token = ""
let sender: Agent
let node: Agent
const T0 = 1_700_000_000_000

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-wake-page-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  token = ensureHubToken(join(home, "hub_token"))
  // pull 占位（opencode 无推送适配器）：积压只能由 /internal/wake 认领。
  app = createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: ["opencode"] })
  sender = insertAgent(db, { name: "page-sender", kind: "runtime", status: "online", vendor: "opencode" })
  node = insertAgent(db, { name: "page-node", kind: "runtime", status: "online", vendor: "opencode" })
})

afterEach(() => {
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 发 `count` 条同会话 DM，返回按 seq 升序的消息。 */
function sendDms(count: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < count; i += 1) {
    messages.push(sendMessage(db, { from: sender.id, to: node.id, body: `dm-${i}` }).message)
  }
  return messages
}

/** 连续认领直到取空（上限轮数防死循环），返回每轮消息 id。 */
function drain(rounds = 10): string[][] {
  const pages: string[][] = []
  for (let i = 0; i < rounds; i += 1) {
    const backlog = claimWakeBacklog(db, { agentId: node.id, now: T0 + i * 1_000 })
    if (backlog.messages.length === 0) break
    pages.push(backlog.messages.map((message) => message.id))
  }
  return pages
}

function jobCounts(agentId: string): { pending: number; sending: number; accepted: number } {
  const row = db
    .prepare<[string], { pending: number; sending: number; accepted: number }>(
      `SELECT SUM(state = 'pending') AS pending,
              SUM(state = 'sending') AS sending,
              SUM(state = 'accepted') AS accepted
         FROM wake_jobs WHERE agent_id = ?`,
    )
    .get(agentId)
  return row ?? { pending: 0, sending: 0, accepted: 0 }
}

/** 全部经真路由取件一轮（HTTP 契约与纯函数零分叉）。 */
async function wakeHttp(): Promise<{ messages: { id: string }[]; receipts: { stage: string }[] }> {
  const response = await app.request("/internal/wake", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: node.id }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { messages: { id: string }[]; receipts: { stage: string }[] }
}

describe("P2：认领页可推进（不再永久 pending）", () => {
  it("60 条 DM 连续 wake 直到取空：50 → 10 → 0，无永久 pending（改前第 2/3 轮恒 0）", () => {
    const messages = sendDms(60)

    const pages = drain()
    expect(pages.map((page) => page.length)).toEqual([50, 10])
    expect(new Set(pages.flat()).size).toBe(60)
    expect(new Set(pages.flat())).toEqual(new Set(messages.map((message) => message.id)))

    // 取空后不得残留 pending（租约在途 = sending，由 /internal/result 或租约过期推进）。
    expect(jobCounts(node.id)).toEqual({ pending: 0, sending: 60, accepted: 0 })
    // 租约仍有效时再取件不得重投；租约过期后由崩溃自愈路径重投（既有语义，见 pull-lease）。
    expect(claimWakeBacklog(db, { agentId: node.id, now: T0 + 500 }).messages).toEqual([])
  })

  it("回执 stage 恒为 sending：认领只置在途租约，绝不提前 accepted/delivered", () => {
    sendDms(3)
    const backlog = claimWakeBacklog(db, { agentId: node.id, now: T0 })
    expect(backlog.receipts.map((receipt) => receipt.stage)).toEqual([
      "sending",
      "sending",
      "sending",
    ])
    expect(backlog.receipts.map((receipt) => receipt.messageId)).toEqual(
      backlog.messages.map((message) => message.id),
    )
    expect(jobCounts(node.id)).toEqual({ pending: 0, sending: 3, accepted: 0 })
  })

  it("窗口被 55 条已投递行占满时，后到的 5 条仍可认领（改前恒 0）", () => {
    const delivered = sendDms(55)
    for (const message of delivered) {
      expect(
        applyDeliveryResult(db, {
          agentId: node.id,
          messageSeq: message.seq,
          result: "delivered",
          now: T0,
        }).state,
      ).toBe("accepted")
    }
    const fresh = sendDms(5)

    const pages = drain()
    expect(pages).toEqual([fresh.map((message) => message.id)])
    expect(jobCounts(node.id)).toEqual({ pending: 0, sending: 5, accepted: 55 })
  })

  it("窗口被 55 条已读行占满时（ack 但无 result），后到的 5 条仍可认领（改前恒 0）", () => {
    const read = sendDms(55)
    ack(db, node.id, read.map((message) => message.id))
    const fresh = sendDms(5)

    const pages = drain()
    expect(pages).toEqual([fresh.map((message) => message.id)])
    // 已读位点不驱动 job：55 行仍在 pending，只是不再占据认领窗口。
    expect(jobCounts(node.id)).toEqual({ pending: 55, sending: 5, accepted: 0 })
  })

  it("窗口被 55 条已撤回行占满时，后到的 5 条仍可认领；撤回原文绝不复投（改前恒 0）", () => {
    const revoked = sendDms(55)
    for (const message of revoked) markRevoked(db, { id: message.id, now: T0 })
    const fresh = sendDms(5)

    const pages = drain()
    expect(pages).toEqual([fresh.map((message) => message.id)])
    const claimedIds = new Set(pages.flat())
    for (const message of revoked) expect(claimedIds.has(message.id)).toBe(false)
  })

  it("system 豁免：窗口被 55 条已投递 DM 占满，无 job 的 system 通知仍被投递并补建 sending 租约", () => {
    const delivered = sendDms(55)
    for (const message of delivered) {
      applyDeliveryResult(db, {
        agentId: node.id,
        messageSeq: message.seq,
        result: "delivered",
        now: T0,
      })
    }
    const first = delivered[0]
    if (first === undefined) throw new Error("DM 未入库")
    const notice = storeSend(db, {
      conversationId: first.conversationId,
      fromAgentId: sender.id,
      kind: "system",
      body: "你被拉入群「page 群」。成员：page-node",
    })
    expect(getWakeJob(db, notice.seq, node.id)).toBeUndefined() // system 不建行

    const backlog = claimWakeBacklog(db, { agentId: node.id, now: T0 })
    expect(backlog.messages.map((message) => message.id)).toEqual([notice.id])
    expect(getWakeJob(db, notice.seq, node.id)?.state).toBe("sending") // 原路径：认领补建租约
  })

  it("单次响应规模仍受 limit 约束：120 条待认领 → 50 / 50 / 20", () => {
    sendDms(120)
    const pages = drain()
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20])
    expect(new Set(pages.flat()).size).toBe(120)
    expect(jobCounts(node.id)).toEqual({ pending: 0, sending: 120, accepted: 0 })
  })

  it("HTTP 路径同样可推进：无票 401，带票连续取件 50 → 10", async () => {
    const messages = sendDms(60)
    const denied = await app.request("/internal/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: node.id }),
    })
    expect(denied.status).toBe(401)

    const first = await wakeHttp()
    expect(first.messages.map((message) => message.id)).toEqual(
      messages.slice(0, 50).map((message) => message.id),
    )
    expect(first.receipts.every((receipt) => receipt.stage === "sending")).toBe(true)

    const second = await wakeHttp()
    expect(second.messages.map((message) => message.id)).toEqual(
      messages.slice(50).map((message) => message.id),
    )
    expect((await wakeHttp()).messages).toEqual([])
    const last = messages[59]
    if (last === undefined) throw new Error("第 60 条 DM 未入库")
    expect(receiptState(db, last, node.id)).toBe("sending")
  })
})
