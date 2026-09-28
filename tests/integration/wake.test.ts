/**
 * Task 6 —— 唤醒队列与 dispatcher 集成测试（brief DoD）：
 * - 向 busy 节点发送 → job `pending(busy)` 按退避重试、不早于 `500·2^n` ms（绝不中途注入）
 * - fake 适配器上报 idle → `inject` 收到正确消息 → job `accepted` →
 *   `POST /internal/result delivered` → 收件方回执 `delivered`
 * - offline 根重连 → `pending(offline)` 积压补投；offline 不过期（48h 后仍 pending）
 * - `retire` → job `cancelled` + 发送方收 system 消息「对方已离场」
 * - `refused` 连续 2 次 → 发送方通知，30min 窗口内同对合并为 1 条
 * - `POST /internal/state|wake|result`：Bearer 鉴权 401、状态白名单、子节点不置 offline、
 *   wake 过滤自发消息（T4 交接）、result 复核推翻 accepted
 * - housekeeping：`backupIfDue`（时钟注入）每日单文件备份；busy 24h 过期
 * - 资格：logical/human/发送者本人不生成 job；幂等重发仍单 job
 * - 修复回归（review）：轮内抛错不使 `tick()` reject 且下一轮照常；
 *   `refused` 落终态 job 上不复活状态、零 UPDATE
 * 时间断言全部用注入时钟（`dispatcher.tick(now)`），无长 sleep。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FakeAdapter } from "../../server/adapters/fake"
import { clearAdapters, registerAdapter } from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { registerRoot, retire } from "../../server/core/agents"
import { DISPATCHER_INTERVAL_MS, Dispatcher } from "../../server/core/dispatcher"
import { ensureHuman, inbox, receiptState, sendMessage, shout } from "../../server/core/messaging"
import type { Gated } from "../../server/core/permissions"
import { createApp } from "../../server/index"
import { applyAgentState, ensureHubToken } from "../../server/routes/internal"
import { getAgent, insertAgent, type Agent } from "../../server/store/agents"
import type { Message } from "../../server/store/messages"
import {
  backoffMs,
  applyDeliveryResult,
  DUE_JOBS_PER_TICK,
  dueWakeJobs,
  getWakeJob,
  type WakeJob,
} from "../../server/store/wake"

let home = ""
let db: Db
let fake: FakeAdapter
let dispatcher: Dispatcher
let token = ""
let app: ReturnType<typeof createApp>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-wake-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  fake = new FakeAdapter({
    onState: (nodeId, state) => {
      applyAgentState(db, { agentId: nodeId, state })
    },
  })
  registerAdapter(fake)
  dispatcher = new Dispatcher({ db, home })
  token = ensureHubToken(join(home, "hub_token"))
  app = createApp(db, { hubTokenPath: join(home, "hub_token") })
})

afterEach(() => {
  dispatcher.stop()
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string, parentId?: string): Agent {
  return insertAgent(db, {
    name,
    kind: "runtime",
    status: "online",
    vendor: "opencode",
    ...(parentId === undefined ? {} : { parentId }),
  })
}

/** 从闸门判别联合中取出即时执行结果（`"approved" in result` 正向判别）。 */
function approved<T>(result: Gated<T>): T {
  if (!("approved" in result)) throw new Error("expected an approved outcome")
  return result.approved
}

function expectJob(messageSeq: number, agentId: string): WakeJob {
  const job = getWakeJob(db, messageSeq, agentId)
  if (job === undefined) throw new Error(`wake job missing for message ${messageSeq}`)
  return job
}

async function post(path: string, body: unknown, withAuth = true): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: withAuth
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function systemNotices(agentId: string, needle: string): Message[] {
  return inbox(db, agentId).filter((m) => m.kind === "system" && m.body.includes(needle))
}

function jobCount(agentId: string): number {
  return (
    db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM wake_jobs WHERE agent_id = ?")
      .get(agentId)?.n ?? 0
  )
}

describe("busy queue and backoff", () => {
  it("locks the exact constraint values (interval 2000, backoff 500·2^n capped at 30000)", () => {
    expect(DISPATCHER_INTERVAL_MS).toBe(2000)
    expect(backoffMs(0)).toBe(500)
    expect(backoffMs(1)).toBe(1000)
    expect(backoffMs(6)).toBe(30_000) // min(30000, 500·2^6=32000)
    expect(backoffMs(100)).toBe(30_000)
  })

  it("keeps a busy recipient's job pending with backoff not earlier than 500·2^n and never injects mid-turn", async () => {
    const sender = makeAgent("busy-sender")
    const busy = makeAgent("busy-node")
    expect(applyAgentState(db, { agentId: busy.id, state: "busy" })).toEqual({ ok: true })

    const sentAt = Date.now()
    const { message } = sendMessage(db, { from: sender.id, to: busy.id, body: "排队投递" })

    const initial = expectJob(message.seq, busy.id)
    expect(initial).toMatchObject({ state: "pending", pendingReason: "busy", attempts: 0 })
    expect(initial.retryAt).toBeGreaterThanOrEqual(sentAt + 500 * 2 ** 0)

    const t1 = sentAt + 5000
    await dispatcher.tick(t1)
    const first = expectJob(message.seq, busy.id)
    expect(first).toMatchObject({ state: "pending", pendingReason: "busy", attempts: 1 })
    expect(first.retryAt).toBeGreaterThanOrEqual(t1 + 500 * 2 ** 1)
    expect(fake.injections).toHaveLength(0)

    const t2 = t1 + 5000
    await dispatcher.tick(t2)
    const second = expectJob(message.seq, busy.id)
    expect(second).toMatchObject({ state: "pending", pendingReason: "busy", attempts: 2 })
    expect(second.retryAt).toBeGreaterThanOrEqual(t2 + 500 * 2 ** 2)
    expect(fake.injections).toHaveLength(0)
  })

  it("expires a job that stayed busy for the whole 24h window and notifies the sender", async () => {
    const sender = makeAgent("expire-sender")
    const node = makeAgent("expire-node")
    applyAgentState(db, { agentId: node.id, state: "busy" })
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "漫长等待" })

    await dispatcher.tick(Date.now() + 86_400_000 + 1000)

    expect(expectJob(message.seq, node.id).state).toBe("expired")
    expect(receiptState(db, message, node.id)).toBe("queued") // 失败态不新增阶段
    const notices = systemNotices(sender.id, "投递失败")
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain("24 小时")
  })
})

describe("idle handoff chain (DoD)", () => {
  it("goes idle → inject receives the message → accepted → /internal/result delivered → receipt delivered", async () => {
    const sender = makeAgent("chain-sender")
    const node = makeAgent("chain-node")
    applyAgentState(db, { agentId: node.id, state: "busy" })
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "醒醒" })

    fake.reportState(node.id, "idle") // 假适配器上报 idle → hub 侧 busy→online
    expect(getAgent(db, node.id)?.status).toBe("online")

    await dispatcher.tick(Date.now())
    expect(fake.injections).toHaveLength(1)
    expect(fake.injections[0]?.nodeId).toBe(node.id)
    expect(fake.injections[0]?.msgs.map((m) => m.body)).toEqual(["醒醒"])
    expect(expectJob(message.seq, node.id).state).toBe("accepted")
    expect(receiptState(db, message, node.id)).toBe("delivered") // accepted 派生 delivered

    const res = await post("/internal/result", {
      agentId: node.id,
      items: [{ messageId: message.id, result: "delivered" }],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, applied: 1 })
    expect(receiptState(db, message, node.id)).toBe("delivered")
    expect(expectJob(message.seq, node.id).state).toBe("accepted")
  })
})

describe("offline root reconnect", () => {
  it("queues pending(offline), never expires it, redelivers on reconnect and pulls the rest via /internal/wake", async () => {
    const sender = makeAgent("reconnect-sender")
    const { agent: root, joinToken } = registerRoot(db, home, {
      name: "reconnect-root",
      vendor: "opencode",
    })
    const backlog = sendMessage(db, { from: sender.id, to: root.id, body: "积压一" }).message

    expect(applyAgentState(db, { agentId: root.id, state: "offline" })).toEqual({ ok: true })
    const t1 = Date.now() + 5000
    await dispatcher.tick(t1)
    expect(expectJob(backlog.seq, root.id)).toMatchObject({
      state: "pending",
      pendingReason: "offline",
      attempts: 1,
    })

    // 离线期间发送：offline 收件方不生成 job（纯收件箱，待重连拉取）
    const whileOffline = sendMessage(db, { from: sender.id, to: root.id, body: "积压二" }).message
    expect(getWakeJob(db, whileOffline.seq, root.id)).toBeUndefined()

    // offline 不过期：48h 后仍是 pending(offline)
    await dispatcher.tick(t1 + 48 * 3_600_000)
    expect(expectJob(backlog.seq, root.id)).toMatchObject({
      state: "pending",
      pendingReason: "offline",
    })

    // 根重连（join_token 认领）→ pending(offline) 积压立即到期补投
    const again = registerRoot(db, home, { joinToken, name: "reconnect-root", vendor: "opencode" })
    expect(again.agent.id).toBe(root.id)
    expect(again.agent.status).toBe("online")
    await dispatcher.tick(Date.now())
    expect(fake.injections).toHaveLength(1)
    expect(fake.injections[0]?.msgs.map((m) => m.body)).toEqual(["积压一"])
    expect(expectJob(backlog.seq, root.id).state).toBe("accepted")

    // 适配器 SessionStart 拉取积压：已投递的不重复认领，无 job 的补建 sending 租约
    const res = await post("/internal/wake", { agentId: root.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      messages: [expect.objectContaining({ id: whileOffline.id })],
      receipts: [{ messageId: whileOffline.id, stage: "sending" }],
    })
    expect(expectJob(whileOffline.seq, root.id).state).toBe("sending")
    expect(receiptState(db, whileOffline, root.id)).toBe("sending")
  })
})

describe("retire cancellation", () => {
  it("cancels undelivered jobs and sends the sender a system message saying the peer left", () => {
    const sender = makeAgent("retire-sender")
    const target = makeAgent("retire-target")
    const { message } = sendMessage(db, { from: sender.id, to: target.id, body: "在吗" })
    expect(expectJob(message.seq, target.id).state).toBe("pending")

    retire(db, target.id)

    expect(expectJob(message.seq, target.id).state).toBe("cancelled")
    const cancelled = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM wake_jobs WHERE agent_id = ? AND state = 'cancelled'",
      )
      .get(target.id)
    expect(cancelled?.n).toBe(1)

    const notices = systemNotices(sender.id, "对方已离场")
    expect(notices).toHaveLength(1)
    expect(notices[0]?.kind).toBe("system")
    expect(notices[0]?.fromAgentId).toBe(target.id)
    expect(receiptState(db, message, target.id)).toBe("queued") // cancelled 不新增阶段
  })
})

describe("refused twice and merged notice", () => {
  it("notifies the sender after 2 consecutive refusals and merges same-pair notices within 30min into one", async () => {
    const sender = makeAgent("refuse-sender")
    const node = makeAgent("refuse-node")
    fake.setOutcome("refused")
    const first = sendMessage(db, { from: sender.id, to: node.id, body: "拒收一" }).message
    const second = sendMessage(db, { from: sender.id, to: node.id, body: "拒收二" }).message

    const t1 = Date.now() + 1000
    await dispatcher.tick(t1)
    // 第 1 次拒收 → 回 pending 按退避重投，尚不通知
    expect(expectJob(first.seq, node.id)).toMatchObject({ state: "pending", attempts: 1 })
    expect(expectJob(second.seq, node.id)).toMatchObject({ state: "pending", attempts: 1 })
    expect(JSON.parse(expectJob(first.seq, node.id).detail)).toEqual({ refusals: 1 })
    expect(systemNotices(sender.id, "投递失败")).toHaveLength(0)

    const t2 = t1 + 5000
    await dispatcher.tick(t2)
    // 连续第 2 次拒收 → 终态 refused；同轮两次通知按 30min 同对幂等键合并为 1 条
    expect(expectJob(first.seq, node.id).state).toBe("refused")
    expect(expectJob(second.seq, node.id).state).toBe("refused")
    const notices = systemNotices(sender.id, "投递失败")
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain("2 次")
  })
})

describe("internal endpoints", () => {
  it("rejects missing bearer tokens with 401 and enforces the state whitelist", async () => {
    const root = makeAgent("state-root")
    const child = makeAgent("state-child", root.id)

    const anonymous = await post("/internal/state", { agentId: root.id, state: "busy" }, false)
    expect(anonymous.status).toBe(401)

    const busyRes = await post("/internal/state", { agentId: root.id, state: "busy" })
    expect(busyRes.status).toBe(200)
    expect(await busyRes.json()).toEqual({ ok: true })
    expect(getAgent(db, root.id)?.status).toBe("busy")

    // 裁决契约：子节点永不置 offline
    const childOffline = await post("/internal/state", { agentId: child.id, state: "offline" })
    expect(childOffline.status).toBe(409)
    expect(await childOffline.json()).toEqual({ ok: false, error: "child_never_offline" })
    expect(getAgent(db, child.id)?.status).toBe("online")

    // 白名单外迁移：offline → online 必须走 join_token 身份认领
    expect(await (await post("/internal/state", { agentId: root.id, state: "offline" })).json()).toEqual({ ok: true })
    const rejected = await post("/internal/state", { agentId: root.id, state: "online" })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ ok: false, error: "transition_rejected" })
    expect(getAgent(db, root.id)?.status).toBe("offline")
  })

  it("excludes self-authored messages from the wake backlog (T4 handoff: inbox contains own messages)", async () => {
    const node = makeAgent("self-node")
    const other = makeAgent("self-other")
    shout(db, node.id, "自言自语") // 自己的喊话也进自己 inbox
    const foreign = sendMessage(db, { from: other.id, to: node.id, body: "外来消息" }).message

    const res = await post("/internal/wake", { agentId: node.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      messages: [expect.objectContaining({ id: foreign.id })],
      receipts: [{ messageId: foreign.id, stage: "sending" }],
    })
  })

  it("lets /internal/result revoke an in-flight (sending) claimed job back to pending on refusal", async () => {
    const sender = makeAgent("revoke-sender")
    const node = makeAgent("revoke-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "待复核" })

    const wakeRes = await post("/internal/wake", { agentId: node.id })
    expect(wakeRes.status).toBe(200)
    expect(receiptState(db, message, node.id)).toBe("sending") // 认领 → sending 在途租约

    const res = await post("/internal/result", {
      agentId: node.id,
      items: [{ messageId: message.id, result: "refused" }],
    })
    expect(await res.json()).toEqual({ ok: true, applied: 1 })
    expect(expectJob(message.seq, node.id)).toMatchObject({ state: "pending" }) // 第 1 次拒收回退
    expect(receiptState(db, message, node.id)).toBe("queued")
  })
})

describe("wake job eligibility", () => {
  it("never creates jobs for logical nodes, the human, or the sender themselves", () => {
    const sender = makeAgent("elig-sender")
    const peer = makeAgent("elig-peer")
    const board = insertAgent(db, {
      name: "elig-board",
      kind: "logical",
      status: "offline",
      vendor: "—",
    })
    const human = ensureHuman(db)

    const dm = sendMessage(db, { from: sender.id, to: board.id, body: "留言" }).message
    expect(getWakeJob(db, dm.seq, board.id)).toBeUndefined()

    const shouted = approved(shout(db, sender.id, "全员注意")).message
    expect(getWakeJob(db, shouted.seq, peer.id)).toBeDefined() // runtime+online+适配器 → 有 job
    expect(getWakeJob(db, shouted.seq, board.id)).toBeUndefined()
    expect(getWakeJob(db, shouted.seq, human.id)).toBeUndefined()
    expect(getWakeJob(db, shouted.seq, sender.id)).toBeUndefined() // 发送者本人
  })

  it("keeps exactly one job for an idempotent re-send", () => {
    const sender = makeAgent("idem-sender")
    const node = makeAgent("idem-node")
    sendMessage(db, { from: sender.id, to: node.id, body: "首版", idempotencyKey: "k-1" })
    sendMessage(db, { from: sender.id, to: node.id, body: "改了", idempotencyKey: "k-1" })

    expect(jobCount(node.id)).toBe(1)
  })
})

describe("housekeeping", () => {
  it("writes the daily single-file backup on a dispatcher round, once per 24h (clock injected)", async () => {
    const now = Date.now()
    await dispatcher.tick(now)
    const backups = (): string[] =>
      readdirSync(join(home, "backups")).filter((n) => n.startsWith("agentchat-daily-"))
    expect(backups()).toHaveLength(1)
    expect(backups()[0]).toMatch(/^agentchat-daily-\d{4}-\d{2}-\d{2}\.db$/)

    await dispatcher.tick(now + 60_000) // 24h 内重复触发 → 不重备份
    expect(backups()).toHaveLength(1)
  })

  it("runs an immediate round on start() and stops cleanly", () => {
    dispatcher.start()
    // start() 的首轮同步执行到 backupIfDue → 备份文件当场存在
    expect(
      readdirSync(join(home, "backups")).filter((n) => n.startsWith("agentchat-daily-")),
    ).toHaveLength(1)
    dispatcher.stop()
  })
})

describe("no-adapter job creation (Plan 5 修复 2)", () => {
  it("creates a wake job for an online runtime recipient even with no registered adapter", () => {
    const sender = makeAgent("noad-sender")
    const peer = makeAgent("noad-peer")
    clearAdapters()

    const { message } = sendMessage(db, { from: sender.id, to: peer.id, body: "无适配器也要建 job" })

    // 去掉适配器门禁后，回执阶段从此真实：有 job（pending）→ queued，而非「无 job 也 queued」。
    expect(expectJob(message.seq, peer.id)).toMatchObject({ state: "pending", attempts: 0 })
    expect(receiptState(db, message, peer.id)).toBe("queued")
  })

  it("defers a job for an unknown vendor without injecting or throwing", async () => {
    const sender = makeAgent("unknown-sender")
    const peer = makeAgent("unknown-peer")
    clearAdapters()
    const { message } = sendMessage(db, { from: sender.id, to: peer.id, body: "未知厂商" })

    await expect(dispatcher.tick(Date.now() + 1000)).resolves.toBeUndefined()
    expect(fake.injections).toHaveLength(0)
    const job = expectJob(message.seq, peer.id)
    expect(job.state).toBe("pending")
    expect(job.attempts).toBeGreaterThan(0) // 退避重投（而非抛错/误注入）
    expect(receiptState(db, message, peer.id)).toBe("queued")
  })

  it("lets the pull path claim the send-time job and accept it on result delivered", async () => {
    const sender = makeAgent("claim-sender")
    const peer = makeAgent("claim-peer")
    clearAdapters()
    const { message } = sendMessage(db, { from: sender.id, to: peer.id, body: "发送即建 job" })

    const wakeRes = await post("/internal/wake", { agentId: peer.id })
    expect(wakeRes.status).toBe(200)
    expect(await wakeRes.json()).toMatchObject({
      messages: [expect.objectContaining({ id: message.id })],
      receipts: [{ messageId: message.id, stage: "sending" }],
    })
    expect(expectJob(message.seq, peer.id).state).toBe("sending")

    const result = await post("/internal/result", {
      agentId: peer.id,
      items: [{ messageId: message.id, result: "delivered" }],
    })
    expect(await result.json()).toEqual({ ok: true, applied: 1 })
    expect(receiptState(db, message, peer.id)).toBe("delivered")
  })
})

describe("dueWakeJobs per-tick limit (Plan 5 跟进)", () => {
  it("caps a single call at the limit (id order preserved) and drains every due job across calls", () => {
    expect(DUE_JOBS_PER_TICK).toBe(200)
    const sender = makeAgent("limit-sender")
    const peer = makeAgent("limit-peer")
    for (let i = 0; i < 5; i += 1) sendMessage(db, { from: sender.id, to: peer.id, body: `m${i}` })
    const now = Date.now() + 10_000

    // 少量（< 默认上限）行为不变：全部返回、按 id 升序。
    const all = dueWakeJobs(db, now)
    expect(all.map((job) => job.id)).toEqual([...all.map((job) => job.id)].sort((a, b) => a - b))
    expect(all).toHaveLength(5)

    // 一次调用只取 limit 条。
    const first = dueWakeJobs(db, now, 2)
    expect(first).toHaveLength(2)
    expect(first[0]!.id).toBeLessThan(first[1]!.id)

    // 逐批「处理」（把已取 job 推到未来）→ 多次调用可把全部到期 job 处理完，不漏投。
    const handled: number[] = []
    let batch = dueWakeJobs(db, now, 2)
    while (batch.length > 0) {
      for (const job of batch) {
        handled.push(job.id)
        db.prepare<[number, number], void>("UPDATE wake_jobs SET retry_at = ? WHERE id = ?").run(
          now + 999_999,
          job.id,
        )
      }
      batch = dueWakeJobs(db, now, 2)
    }
    expect(handled).toHaveLength(5)
    expect(handled).toEqual([...handled].sort((a, b) => a - b))
  })
})

describe("review fixes: round error isolation and terminal guard", () => {
  it("keeps tick() from rejecting when a round step throws, then runs the next round normally", async () => {
    const brokenHome = mkdtempSync(join(tmpdir(), "agentchat-dispatch-"))
    writeFileSync(join(brokenHome, "backups"), "occupied") // backups 落在普通文件上 → mkdirSync 抛出
    const errors: unknown[] = []
    const broken = new Dispatcher({ db, home: brokenHome, onError: (error) => errors.push(error) })
    try {
      await expect(broken.tick(Date.now())).resolves.toBeUndefined() // 不 reject
      expect(errors).toHaveLength(1)

      rmSync(join(brokenHome, "backups"), { force: true }) // 故障排除
      await broken.tick(Date.now() + 1000) // 下一轮照常执行
      expect(
        readdirSync(join(brokenHome, "backups")).filter((n) => n.startsWith("agentchat-daily-")),
      ).toHaveLength(1)
      expect(errors).toHaveLength(1) // 后续轮次无新增错误
    } finally {
      broken.stop()
      rmSync(brokenHome, { recursive: true, force: true })
    }
  })

  it("keeps terminal jobs terminal when applyDeliveryResult receives refused (no UPDATE)", () => {
    const sender = makeAgent("guard-sender")
    const node = makeAgent("guard-node")
    const cancelled = sendMessage(db, { from: sender.id, to: node.id, body: "已取消" }).message
    const expired = sendMessage(db, { from: sender.id, to: node.id, body: "已过期" }).message
    // 模拟 review 竞态：认领 await 注入期间 retire 合法取消 / busy 过期落终态
    db.prepare<[string, string, number, string], void>(
      "UPDATE wake_jobs SET state = ?, detail = ? WHERE message_id = ? AND agent_id = ?",
    ).run("cancelled", "Recipient retired", cancelled.seq, node.id)
    db.prepare<[string, string, number, string], void>(
      "UPDATE wake_jobs SET state = ?, detail = ? WHERE message_id = ? AND agent_id = ?",
    ).run("expired", "Recipient stayed busy for the whole 24h retry window", expired.seq, node.id)
    const beforeCancelled = expectJob(cancelled.seq, node.id)
    const beforeExpired = expectJob(expired.seq, node.id)

    const now = Date.now()
    expect(
      applyDeliveryResult(db, {
        agentId: node.id,
        messageSeq: cancelled.seq,
        result: "refused",
        now,
      }),
    ).toMatchObject({ state: "cancelled", stateChanged: false })
    expect(
      applyDeliveryResult(db, { agentId: node.id, messageSeq: expired.seq, result: "refused", now }),
    ).toMatchObject({ state: "expired", stateChanged: false })

    // 全字段逐一相等 = 未发生任何 UPDATE（终态未被复活为 pending）
    expect(expectJob(cancelled.seq, node.id)).toEqual(beforeCancelled)
    expect(expectJob(expired.seq, node.id)).toEqual(beforeExpired)
  })
})
