/**
 * Task 1 —— Hub 适配器接缝集成测试（brief DoD）：
 * - **pull 模式**：`AGENTCHAT_ADAPTERS` 配置的厂商注册为 pull 占位；向在线 runtime 发送 →
 *   job `pending`，dispatcher tick 不注入、不产生 refused（消息留给 `/internal/wake` 认领）
 * - 该节点 `POST /internal/wake` → 取件 + job `accepted` + 回执 `delivered`
 * - **push（fake）零回归**：默认 `mode` 为 push，inject 收到消息 → job accepted
 * - `AGENTCHAT_ADAPTERS` 解析：空/未设/含空白/重复项
 * 时间断言用注入时钟（`dispatcher.tick(now)`），无 sleep。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FakeAdapter } from "../../server/adapters/fake"
import { adapterFor, clearAdapters, registerAdapter } from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { Dispatcher } from "../../server/core/dispatcher"
import { inbox, receiptState, sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { applyAgentState, ensureHubToken } from "../../server/routes/internal"
import { insertAgent, type Agent } from "../../server/store/agents"
import type { Message } from "../../server/store/messages"
import { getWakeJob, type WakeJob } from "../../server/store/wake"

let home = ""
let db: Db
let dispatcher: Dispatcher
let token = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-adapters-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  dispatcher = new Dispatcher({ db, home })
  token = ensureHubToken(join(home, "hub_token"))
})

afterEach(() => {
  dispatcher.stop()
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string, vendor = "opencode"): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor })
}

function expectJob(messageSeq: number, agentId: string): WakeJob {
  const job = getWakeJob(db, messageSeq, agentId)
  if (job === undefined) throw new Error(`wake job missing for message ${messageSeq}`)
  return job
}

type App = ReturnType<typeof createApp>

async function post(app: App, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function systemNotices(agentId: string, needle: string): Message[] {
  return inbox(db, agentId).filter((m) => m.kind === "system" && m.body.includes(needle))
}

describe("AGENTCHAT_ADAPTERS parsing", () => {
  it("defaults to [] when unset or blank", () => {
    expect(loadConfig({}).adapters).toEqual([])
    expect(loadConfig({ AGENTCHAT_ADAPTERS: "" }).adapters).toEqual([])
    expect(loadConfig({ AGENTCHAT_ADAPTERS: "   " }).adapters).toEqual([])
  })

  it("trims entries, drops blanks, dedupes and preserves first-seen order", () => {
    expect(loadConfig({ AGENTCHAT_ADAPTERS: " opencode , claude-code ,opencode,, " }).adapters).toEqual([
      "opencode",
      "claude-code",
    ])
  })
})

describe("pull adapter seam", () => {
  it("registers configured vendors as pull placeholders, keeping the job pending without refusing", async () => {
    createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: ["opencode", "claude-code"] })
    expect(adapterFor("opencode")?.mode).toBe("pull")
    expect(adapterFor("claude-code")?.mode).toBe("pull")

    const sender = makeAgent("pull-sender")
    const node = makeAgent("pull-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "拉取积压" })
    expect(expectJob(message.seq, node.id)).toMatchObject({ state: "pending", attempts: 0 })

    await dispatcher.tick(Date.now() + 1000)

    // pull 目标不被注入：job 仍 pending、attempts 未增、无失败通知、回执停在 queued
    expect(expectJob(message.seq, node.id)).toMatchObject({ state: "pending", attempts: 0 })
    expect(systemNotices(sender.id, "投递失败")).toHaveLength(0)
    expect(receiptState(db, message, node.id)).toBe("queued")
  })

  it("hands the backlog to /internal/wake: job accepted and receipt delivered", async () => {
    const app = createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: ["opencode"] })
    const sender = makeAgent("wake-sender")
    const node = makeAgent("wake-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "自取消息" })

    await dispatcher.tick(Date.now() + 1000)
    expect(expectJob(message.seq, node.id).state).toBe("pending")

    const res = await post(app, "/internal/wake", { agentId: node.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      messages: [expect.objectContaining({ id: message.id })],
      receipts: [{ messageId: message.id, stage: "delivered" }],
    })
    expect(expectJob(message.seq, node.id).state).toBe("accepted")
    expect(receiptState(db, message, node.id)).toBe("delivered")
  })
})

describe("push adapter zero regression", () => {
  it("injects through a registered push fake (no mode) and accepts the job", async () => {
    const fake = new FakeAdapter({
      onState: (nodeId, state) => {
        applyAgentState(db, { agentId: nodeId, state })
      },
    })
    registerAdapter(fake) // 无 mode → 默认 push
    createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: [] }) // 不注册任何 pull 占位

    const sender = makeAgent("push-sender")
    const node = makeAgent("push-node")
    const { message } = sendMessage(db, { from: sender.id, to: node.id, body: "推送消息" })

    await dispatcher.tick(Date.now() + 1000)

    expect(fake.injections).toHaveLength(1)
    expect(fake.injections[0]?.nodeId).toBe(node.id)
    expect(fake.injections[0]?.msgs.map((m) => m.body)).toEqual(["推送消息"])
    expect(expectJob(message.seq, node.id).state).toBe("accepted")
    expect(receiptState(db, message, node.id)).toBe("delivered")
  })
})
