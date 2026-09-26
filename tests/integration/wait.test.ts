/**
 * Task 5 —— 阻塞等待矩阵测试（brief DoD）：
 * - 3 模式（received/message/either）× {消息先到、回执先到、超时} 共 9 例
 * - 回执事件不误触发 message 模式；消息事件不误触发 received 模式（内容证明 + 竞速断言）
 * - 超时 `timedOut=true` 且带回等待期间已收部分（非空手）
 * - 两个并发等待者（不同 conversation）互不串扰
 * - 默认参数 `timeoutMs=285000`、`until="either"`（常量断言 + `wait:{}` 行为）
 * - `inbox` 带 `wait` 委托同一机制（决议 6）
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { ack, inbox, sendMessage } from "../../server/core/messaging"
import { DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_WAIT_UNTIL } from "../../server/core/wait"
import { insertAgent, type Agent } from "../../server/store/agents"
import type { Message } from "../../server/store/messages"

let home = ""
let db: Db

function makeAgent(name: string): Agent {
  return insertAgent(db, {
    name,
    kind: "runtime",
    status: "online",
    vendor: "opencode",
    model: "test-model",
  })
}

/** 收件箱首条消息（send 的入库与 wait 挂起同步发生，测试借此取回已发消息 id）。 */
function onlyInboxMessage(agentId: string): Message {
  const first = inbox(db, agentId)[0]
  if (first === undefined) throw new Error(`inbox of ${agentId} is empty`)
  return first
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 断言等待者此刻仍未解锁：错误解锁走同步通知（微任务）必然先返回，50ms 竞速足够。 */
async function expectStillPending(wait: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    wait.then(() => "resolved" as const),
    delay(50).then(() => "pending" as const),
  ])
  expect(outcome).toBe("pending")
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-wait-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

describe("wait 矩阵：received（回执模式）", () => {
  it("消息先到：不误解锁，ack 后解锁并带回消息与回执", async () => {
    const a = makeAgent("rx-msg-a")
    const b = makeAgent("rx-msg-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "请确认",
      wait: { until: "received", timeoutMs: 3000 },
    })
    const sent = onlyInboxMessage(b.id)

    sendMessage(db, { from: b.id, to: a.id, body: "先回你" }) // message 事件：不应解锁
    await expectStillPending(pending)

    ack(db, b.id, [sent.id]) // receipt 事件：解锁
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["先回你"])
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }])
  })

  it("回执先到：对方 ack 即解锁，messages=[]、receipts 非空", async () => {
    const a = makeAgent("rx-ack-a")
    const b = makeAgent("rx-ack-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "看这里",
      wait: { until: "received", timeoutMs: 3000 },
    })
    const sent = onlyInboxMessage(b.id)

    ack(db, b.id, [sent.id])
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages).toEqual([])
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }])
  })

  it("超时：timedOut=true 且带回等待期间已收的消息（非空手）", async () => {
    const a = makeAgent("rx-to-a")
    const b = makeAgent("rx-to-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "在吗",
      wait: { until: "received", timeoutMs: 150 },
    })
    onlyInboxMessage(b.id)

    sendMessage(db, { from: b.id, to: a.id, body: "回了但没 ack" })
    const { reply } = await pending
    expect(reply.timedOut).toBe(true)
    expect(reply.messages.map((m) => m.body)).toEqual(["回了但没 ack"])
    expect(reply.receipts).toEqual([])
  })
})

describe("wait 矩阵：message（消息模式）", () => {
  it("消息先到：新消息即解锁，timedOut=false", async () => {
    const a = makeAgent("ms-msg-a")
    const b = makeAgent("ms-msg-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "有结果吗",
      wait: { until: "message", timeoutMs: 3000 },
    })
    onlyInboxMessage(b.id)

    sendMessage(db, { from: b.id, to: a.id, body: "结果来了" })
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["结果来了"])
    expect(reply.receipts).toEqual([])
  })

  it("回执先到：ack 不误触发，随后新消息才解锁", async () => {
    const a = makeAgent("ms-ack-a")
    const b = makeAgent("ms-ack-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "等回信",
      wait: { until: "message", timeoutMs: 3000 },
    })
    const sent = onlyInboxMessage(b.id)

    ack(db, b.id, [sent.id]) // receipt 事件：不应解锁 message 模式
    await expectStillPending(pending)

    sendMessage(db, { from: b.id, to: a.id, body: "回信本体" })
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["回信本体"])
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }]) // 已收部分一并带回
  })

  it("超时：timedOut=true 且带回等待期间变化的回执（非空手）", async () => {
    const a = makeAgent("ms-to-a")
    const b = makeAgent("ms-to-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "催一下",
      wait: { until: "message", timeoutMs: 150 },
    })
    const sent = onlyInboxMessage(b.id)

    ack(db, b.id, [sent.id]) // 回执变化但 message 模式不解锁
    const { reply } = await pending
    expect(reply.timedOut).toBe(true)
    expect(reply.messages).toEqual([])
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }])
  })
})

describe("wait 矩阵：either（先到先解锁）", () => {
  it("消息先到：新消息立即解锁", async () => {
    const a = makeAgent("ei-msg-a")
    const b = makeAgent("ei-msg-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "问一句",
      wait: { until: "either", timeoutMs: 3000 },
    })
    onlyInboxMessage(b.id)

    sendMessage(db, { from: b.id, to: a.id, body: "先到的消息" })
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["先到的消息"])
    expect(reply.receipts).toEqual([])
  })

  it("回执先到：ack 立即解锁", async () => {
    const a = makeAgent("ei-ack-a")
    const b = makeAgent("ei-ack-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "求回执",
      wait: { until: "either", timeoutMs: 3000 },
    })
    const sent = onlyInboxMessage(b.id)

    ack(db, b.id, [sent.id])
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages).toEqual([])
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }])
  })

  it("超时：无任何事件，timedOut=true 且两通道皆空", async () => {
    const a = makeAgent("ei-to-a")
    const b = makeAgent("ei-to-b")
    const pending = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "石沉大海",
      wait: { timeoutMs: 150 },
    })
    onlyInboxMessage(b.id)

    const { reply } = await pending
    expect(reply.timedOut).toBe(true)
    expect(reply.messages).toEqual([])
    expect(reply.receipts).toEqual([])
  })
})

describe("并发等待者隔离（决议 3）", () => {
  it("不同 conversation 的两个等待者互不串扰", async () => {
    const a = makeAgent("iso-a")
    const b = makeAgent("iso-b")
    const c = makeAgent("iso-c")
    const d = makeAgent("iso-d")

    const pending1 = sendMessage(db, {
      from: a.id,
      to: b.id,
      body: "conv1 发",
      wait: { until: "message", timeoutMs: 5000 },
    })
    const pending2 = sendMessage(db, {
      from: c.id,
      to: d.id,
      body: "conv2 发",
      wait: { until: "message", timeoutMs: 5000 },
    })

    // conv1 事件只应解锁等待者 1
    sendMessage(db, { from: b.id, to: a.id, body: "conv1 回" })
    const first = await pending1
    expect(first.reply.messages.map((m) => m.body)).toEqual(["conv1 回"])
    await expectStillPending(pending2)

    // conv2 事件才解锁等待者 2
    sendMessage(db, { from: d.id, to: c.id, body: "conv2 回" })
    const second = await pending2
    expect(second.reply.messages.map((m) => m.body)).toEqual(["conv2 回"])
    expect(second.reply.timedOut).toBe(false)
  })
})

describe("wait 默认参数（DoD）", () => {
  it("exports timeoutMs=285000 and until=either", () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(285000)
    expect(DEFAULT_WAIT_UNTIL).toBe("either")
  })

  it("wait: {} 解锁于任一事件（缺省 until=either）", async () => {
    const a = makeAgent("df-a")
    const b = makeAgent("df-b")
    const pending = sendMessage(db, { from: a.id, to: b.id, body: "默认", wait: {} })
    const sent = onlyInboxMessage(b.id)

    ack(db, b.id, [sent.id])
    const { reply } = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.receipts).toEqual([{ agentId: b.id, stage: "read" }])
  })
})

describe("inbox 带 wait（决议 6：委托同一机制）", () => {
  it("挂起至新消息到达后返回该消息", async () => {
    const a = makeAgent("iw-a")
    const b = makeAgent("iw-b")
    const pending = inbox(db, a.id, { wait: { timeoutMs: 3000 } })
    await expectStillPending(pending)

    sendMessage(db, { from: b.id, to: a.id, body: "到件" })
    const reply = await pending
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["到件"])
    expect(reply.receipts).toEqual([])
  })

  it("游标后已有消息则立即返回（不挂起）", async () => {
    const a = makeAgent("iw-c")
    const b = makeAgent("iw-d")
    sendMessage(db, { from: b.id, to: a.id, body: "旧消息" })

    const reply = await inbox(db, a.id, { wait: { timeoutMs: 3000 } })
    expect(reply.timedOut).toBe(false)
    expect(reply.messages.map((m) => m.body)).toEqual(["旧消息"])
  })

  it("无新消息时 timedOut=true 且两通道为空", async () => {
    const a = makeAgent("iw-e")
    makeAgent("iw-f")
    const reply = await inbox(db, a.id, { wait: { timeoutMs: 150 } })
    expect(reply.timedOut).toBe(true)
    expect(reply.messages).toEqual([])
    expect(reply.receipts).toEqual([])
  })

  it("received 模式超时但带回等待期间到达的消息（inbox 无回执通道）", async () => {
    const a = makeAgent("iw-g")
    const b = makeAgent("iw-h")
    const pending = inbox(db, a.id, { wait: { until: "received", timeoutMs: 150 } })

    sendMessage(db, { from: b.id, to: a.id, body: "不构成回执" })
    const reply = await pending
    expect(reply.timedOut).toBe(true)
    expect(reply.messages.map((m) => m.body)).toEqual(["不构成回执"])
    expect(reply.receipts).toEqual([])
  })
})
