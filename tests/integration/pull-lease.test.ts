/**
 * Plan 4 修复波 Phase 1 —— pull 认领在途租约（缺陷 #1）：
 * - 认领 = `sending` + `CLAIM_TIMEOUT_MS` 租约，回执 `sending`，绝不提前 delivered
 * - 租约内不重复认领；租约过期（崩溃未回执）→ 回收 pending → 下次 wake 重投 → result 才 accepted/delivered
 * - dispatcher tick 经既有扫描点调用 `requeueExpiredClaims`（dispatcher 未跑时由 wake 自兜底）
 * - refused 从 sending 出发：未达 REFUSAL_LIMIT 回 pending 按退避；达限终态
 * 时间断言全部注入时钟（`claimWakeBacklog`/`tick(now)`），无 sleep。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearAdapters } from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { Dispatcher } from "../../server/core/dispatcher"
import { receiptState, sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { claimWakeBacklog, ensureHubToken } from "../../server/routes/internal"
import { insertAgent, type Agent } from "../../server/store/agents"
import {
  applyDeliveryResult,
  backoffMs,
  CLAIM_TIMEOUT_MS,
  getWakeJob,
  type WakeJob,
} from "../../server/store/wake"
import { requeueExpiredClaims } from "../../server/store/wake-claims"

let home = ""
let db: Db
let dispatcher: Dispatcher

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-pull-lease-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  // pull 占位：消息留给 /internal/wake，dispatcher 不注入。
  createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: ["opencode"] })
  ensureHubToken(join(home, "hub_token"))
  dispatcher = new Dispatcher({ db, home })
})

afterEach(() => {
  dispatcher.stop()
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

function expectJob(messageSeq: number, agentId: string): WakeJob {
  const job = getWakeJob(db, messageSeq, agentId)
  if (job === undefined) throw new Error(`wake job missing for message ${messageSeq}`)
  return job
}

describe("pull claim in-flight lease", () => {
  it("claims as sending with a 30s lease and never marks delivered before result arrives", () => {
    const sender = makeAgent("lease-sender")
    const node = makeAgent("lease-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "在途" })

    const t0 = Date.now()
    const backlog = claimWakeBacklog(db, { agentId: node.id, now: t0 })
    expect(backlog.messages.map((m) => m.id)).toEqual([message.id])
    expect(backlog.receipts).toEqual([{ messageId: message.id, stage: "sending" }])

    const job = expectJob(message.seq, node.id)
    expect(job).toMatchObject({ state: "sending", attempts: 1 })
    expect(job.retryAt).toBe(t0 + CLAIM_TIMEOUT_MS)
    expect(receiptState(db, message, node.id)).toBe("sending")
  })

  it("does not re-claim within the active lease and re-delivers after it expires (crash self-heal)", () => {
    const sender = makeAgent("heal-sender")
    const node = makeAgent("heal-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "崩溃自愈" })

    const t0 = Date.now()
    claimWakeBacklog(db, { agentId: node.id, now: t0 })
    expect(claimWakeBacklog(db, { agentId: node.id, now: t0 + 1_000 }).messages).toEqual([])

    // 崩溃未回执：租约过期 → 回收为 pending，下一次 wake 再次返回该消息
    expect(requeueExpiredClaims(db, t0 + CLAIM_TIMEOUT_MS)).toEqual([message.seq])
    expect(expectJob(message.seq, node.id).state).toBe("pending")
    const again = claimWakeBacklog(db, { agentId: node.id, now: t0 + CLAIM_TIMEOUT_MS })
    expect(again.messages.map((m) => m.id)).toEqual([message.id])
    expect(again.receipts).toEqual([{ messageId: message.id, stage: "sending" }])

    // 这次回执 delivered → accepted/delivered
    const applied = applyDeliveryResult(db, {
      agentId: node.id,
      messageSeq: message.seq,
      result: "delivered",
      now: t0 + CLAIM_TIMEOUT_MS + 1,
    })
    expect(applied.state).toBe("accepted")
    expect(expectJob(message.seq, node.id).state).toBe("accepted")
    expect(receiptState(db, message, node.id)).toBe("delivered")
  })

  it("re-claims an expired sending lease directly at wake time (dispatcher-not-running fallback)", () => {
    const sender = makeAgent("fallback-sender")
    const node = makeAgent("fallback-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "无调度兜底" })

    const t0 = Date.now()
    claimWakeBacklog(db, { agentId: node.id, now: t0 })
    // 不经 requeue：claimWakeBacklog 自身识别 sending + 租约过期并重认领
    const again = claimWakeBacklog(db, { agentId: node.id, now: t0 + CLAIM_TIMEOUT_MS })
    expect(again.messages.map((m) => m.id)).toEqual([message.id])
    expect(expectJob(message.seq, node.id)).toMatchObject({ state: "sending", attempts: 2 })
  })

  it("requeues expired claims on the dispatcher tick (recovery wired into the existing scan)", async () => {
    const sender = makeAgent("tick-sender")
    const node = makeAgent("tick-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "调度回收" })

    const t0 = Date.now()
    claimWakeBacklog(db, { agentId: node.id, now: t0 })
    expect(expectJob(message.seq, node.id).state).toBe("sending")

    await dispatcher.tick(t0 + CLAIM_TIMEOUT_MS + 1)
    expect(expectJob(message.seq, node.id).state).toBe("pending")
  })
})

describe("refusal from an in-flight sending claim", () => {
  it("returns to pending with backoff below REFUSAL_LIMIT, then becomes terminal refused at the limit", () => {
    const sender = makeAgent("refuse-lease-sender")
    const node = makeAgent("refuse-lease-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "从在途拒收" })

    const t0 = Date.now()
    claimWakeBacklog(db, { agentId: node.id, now: t0 })
    const first = applyDeliveryResult(db, {
      agentId: node.id,
      messageSeq: message.seq,
      result: "refused",
      now: t0 + 10,
    })
    expect(first.state).toBe("pending")
    const afterFirst = expectJob(message.seq, node.id)
    expect(afterFirst).toMatchObject({ state: "pending", attempts: 1 })
    expect(afterFirst.retryAt).toBe(t0 + 10 + backoffMs(1))

    // 再次认领（pending 可认领）→ sending；第 2 次拒收 → 终态 refused
    claimWakeBacklog(db, { agentId: node.id, now: t0 + 20 })
    const second = applyDeliveryResult(db, {
      agentId: node.id,
      messageSeq: message.seq,
      result: "refused",
      now: t0 + 30,
    })
    expect(second.state).toBe("refused")
    expect(expectJob(message.seq, node.id).state).toBe("refused")
    expect(receiptState(db, message, node.id)).toBe("queued")
  })
})
