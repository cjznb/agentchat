/**
 * Task 4 —— 消息编排集成测试（brief DoD）：
 * - 发私聊自动建 DM 会话；未知收件人 → `RecipientNotFound`；幂等键重发返回首条
 * - 群 `create/add` 后成员可收发；非成员发群 → `NotParticipantError`（human 豁免）
 * - `shout` → 每个 `kind=runtime|logical` 节点 inbox 各得一条（广播会话无成员行）
 * - 发送即为收件方生成 `queued` 回执；`ack` 后 `read_states` 前移且发送方查得 `read`
 * - wake_jobs 状态透传（sending/accepted/refused），每收件方四级互不串扰
 * - `unreadFor` = 自身未读 + 后代递归（两层树断言数值，孙层证递归）
 * - `history(conversationId, before, limit)` 分页；`inbox` after/limit 游标
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import {
  addParticipant,
  ack,
  createGroup,
  ensureHuman,
  history,
  inbox,
  NotParticipantError,
  RecipientNotFound,
  receiptState,
  sendMessage,
  shout,
  unreadFor,
} from "../../server/core/messaging"
import {
  insertAgent,
  listAgents,
  type Agent,
} from "../../server/store/agents"
import {
  createDm,
  getConversationByKey,
  listConversations,
  listParticipants,
} from "../../server/store/conversations"
import { getReadState } from "../../server/store/read_states"
import { history as storeHistory } from "../../server/store/messages"

let home = ""
let db: Db

function makeAgent(name: string, parentId?: string): Agent {
  return insertAgent(db, {
    name,
    kind: "runtime",
    status: "online",
    vendor: "opencode",
    model: "test-model",
    ...(parentId === undefined ? {} : { parentId }),
  })
}

/** wake_jobs 行手工落库（Task 6 才提供 store）——证明回执派生透传。 */
function insertWakeJob(messageSeq: number, agentId: string, state: string): void {
  db.prepare<[number, string, string, number, number], void>(
    "INSERT INTO wake_jobs (message_id, agent_id, state, retry_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(messageSeq, agentId, state, Date.now(), Date.now())
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-messaging-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

describe("sendMessage DM", () => {
  it("auto-creates the DM conversation on first send and returns a queued receipt", () => {
    const a = makeAgent("dm-a")
    const b = makeAgent("dm-b")

    const result = sendMessage(db, { from: a.id, to: b.id, body: "在吗" })

    const conversation = getConversationByKey(db, `dm:${[a.id, b.id].sort().join("_")}`)
    expect(conversation?.id).toBe(result.message.conversationId)
    expect(conversation?.kind).toBe("dm")
    expect(listParticipants(db, result.message.conversationId)).toHaveLength(2)
    expect(result.message.body).toBe("在吗")
    // 发送即为收件方生成 queued 回执记录
    expect(result.receipts).toEqual([{ agentId: b.id, stage: "queued" }])
  })

  it("reuses the same DM conversation on the next send", () => {
    const a = makeAgent("dm-c")
    const b = makeAgent("dm-d")

    const first = sendMessage(db, { from: a.id, to: b.id, body: "1" })
    const second = sendMessage(db, { from: b.id, to: a.id, body: "2" })

    expect(second.message.conversationId).toBe(first.message.conversationId)
    expect(listConversations(db)).toHaveLength(1)
  })

  it("throws RecipientNotFound for an unknown recipient id", () => {
    const a = makeAgent("dm-e")
    expect(() => sendMessage(db, { from: a.id, to: randomUUID(), body: "?" })).toThrow(
      RecipientNotFound,
    )
  })

  it("returns the first message and its receipts when idempotencyKey repeats", () => {
    const a = makeAgent("dm-f")
    const b = makeAgent("dm-g")

    const first = sendMessage(db, { from: a.id, to: b.id, body: "首版", idempotencyKey: "k-1" })
    const again = sendMessage(db, { from: a.id, to: b.id, body: "改了 body", idempotencyKey: "k-1" })

    expect(again.message.id).toBe(first.message.id)
    expect(again.message.body).toBe("首版")
    expect(again.receipts).toEqual([{ agentId: b.id, stage: "queued" }])
    expect(storeHistory(db, { conversationId: first.message.conversationId })).toHaveLength(1)
  })
})

describe("group create/add", () => {
  it("lets members send and receive after create/add, with a queued receipt each", () => {
    const a = makeAgent("grp-a")
    const b = makeAgent("grp-b")
    const c = makeAgent("grp-c")
    const group = createGroup(db, { name: "攻坚组", createdBy: a.id, memberIds: [b.id] })
    addParticipant(db, { conversationId: group.id, agentId: c.id, invitedBy: a.id })

    const fromB = sendMessage(db, { from: b.id, to: group.id, body: "进度 50%" })
    expect(new Set(fromB.receipts.map((r) => r.agentId))).toEqual(new Set([a.id, c.id]))
    expect(fromB.receipts.every((r) => r.stage === "queued")).toBe(true)

    const fromC = sendMessage(db, { from: c.id, to: group.id, body: "收到" })
    expect(new Set(fromC.receipts.map((r) => r.agentId))).toEqual(new Set([a.id, b.id]))

    expect(inbox(db, a.id).map((m) => m.id)).toEqual(
      expect.arrayContaining([fromB.message.id, fromC.message.id]),
    )
    expect(inbox(db, c.id).map((m) => m.id)).toContain(fromB.message.id)
  })

  it("rejects a non-member sender but lets the human send to any conversation", () => {
    const a = makeAgent("gate-a")
    const b = makeAgent("gate-b")
    const outsider = makeAgent("gate-outsider")
    const group = createGroup(db, { name: "内群", createdBy: a.id, memberIds: [b.id] })
    const human = ensureHuman(db)

    expect(() => sendMessage(db, { from: outsider.id, to: group.id, body: "蹭一下" })).toThrow(
      NotParticipantError,
    )
    const humanSend = sendMessage(db, { from: human.id, to: group.id, body: "我来说两句" })
    expect(humanSend.message.conversationId).toBe(group.id)
    expect(new Set(humanSend.receipts.map((r) => r.agentId))).toEqual(new Set([a.id, b.id]))
  })
})

describe("shout", () => {
  it("delivers one message to every runtime|logical node inbox with no participant rows", () => {
    const root = makeAgent("shout-root")
    const child = makeAgent("shout-child", root.id)
    const board = insertAgent(db, { name: "shout-board", kind: "logical", status: "offline", vendor: "—" })
    const human = ensureHuman(db)

    const result = shout(db, human.id, "全员注意")

    // 喊话 = 系统广播会话：key=shout、kind=group、无 participants 行
    const conversation = getConversationByKey(db, "shout")
    expect(conversation?.id).toBe(result.message.conversationId)
    expect(conversation?.kind).toBe("group")
    expect(conversation?.name).toBe("全员喊话")
    expect(listParticipants(db, conversation?.id ?? "")).toHaveLength(0)

    // 每个 kind=runtime|logical 节点的 inbox 各得一条（含发送者本人）
    const nodes = listAgents(db)
    expect(nodes.map((n) => n.kind).every((k) => k === "runtime" || k === "logical")).toBe(true)
    for (const node of nodes) {
      expect(inbox(db, node.id).map((m) => m.id)).toContain(result.message.id)
    }
    expect([root.id, child.id, board.id, human.id].every((id) =>
      inbox(db, id).some((m) => m.id === result.message.id),
    )).toBe(true)

    // 收件方 = 除发送者外的全部节点，回执各自独立 queued
    expect(new Set(result.receipts.map((r) => r.agentId))).toEqual(
      new Set(nodes.map((n) => n.id).filter((id) => id !== human.id)),
    )
    expect(result.receipts.every((r) => r.stage === "queued")).toBe(true)

    // 幂等：再次喊话复用同一广播会话
    const again = shout(db, human.id, "再喊一次")
    expect(again.message.conversationId).toBe(result.message.conversationId)
  })
})

describe("ack and receipts", () => {
  it("advances read_states and the sender queries the receipt as read", () => {
    const a = makeAgent("ack-a")
    const b = makeAgent("ack-b")
    const { message } = sendMessage(db, { from: a.id, to: b.id, body: "看这个" })

    expect(receiptState(db, message, b.id)).toBe("queued")
    expect(ack(db, b.id, [message.id])).toBe(1)

    expect(getReadState(db, message.conversationId, b.id)?.lastReadSeq).toBe(message.seq)
    expect(receiptState(db, message, b.id)).toBe("read")
    // 发送方查得 read（回执按收件方派生，与查询者无关）
    expect(receiptState(db, message, a.id)).toBe("queued")
  })

  it("ignores unknown ids in ack and counts only resolved messages", () => {
    const a = makeAgent("ack-c")
    const b = makeAgent("ack-d")
    const { message } = sendMessage(db, { from: a.id, to: b.id, body: "确认数" })

    expect(ack(db, b.id, [message.id, "no-such-id"])).toBe(1)
    expect(ack(db, b.id, ["no-such-id"])).toBe(0)
  })

  it("derives each recipient's receipt independently from wake_jobs without cross-talk", () => {
    const a = makeAgent("rc-a")
    const b = makeAgent("rc-b")
    const c = makeAgent("rc-c")
    const group = createGroup(db, { name: "回执群", createdBy: a.id, memberIds: [b.id, c.id] })

    const { message, receipts } = sendMessage(db, { from: a.id, to: group.id, body: "开工" })
    expect(receipts).toHaveLength(2)
    expect(receipts.every((r) => r.stage === "queued")).toBe(true)

    insertWakeJob(message.seq, b.id, "sending")
    expect(receiptState(db, message, b.id)).toBe("sending")
    expect(receiptState(db, message, c.id)).toBe("queued")

    db.prepare<[string, number, string], void>(
      "UPDATE wake_jobs SET state = ? WHERE message_id = ? AND agent_id = ?",
    ).run("accepted", message.seq, b.id)
    expect(receiptState(db, message, b.id)).toBe("delivered")

    insertWakeJob(message.seq, c.id, "refused")
    expect(receiptState(db, message, c.id)).toBe("queued") // 失败态不新增阶段

    // read 仅由 ack 触发，且优先于 job 状态；b 的 ack 不串扰 c
    expect(ack(db, b.id, [message.id])).toBe(1)
    expect(receiptState(db, message, b.id)).toBe("read")
    expect(receiptState(db, message, c.id)).toBe("queued")
  })
})

describe("unreadFor", () => {
  it("sums own unread plus nested child conversations (two-layer tree)", () => {
    const human = ensureHuman(db)
    const root = makeAgent("un-root")
    const child = makeAgent("un-child", root.id)

    // human→root 两条、root→child 三条、child→root 一条
    sendMessage(db, { from: human.id, to: root.id, body: "h1" })
    sendMessage(db, { from: human.id, to: root.id, body: "h2" })
    sendMessage(db, { from: root.id, to: child.id, body: "r1" })
    sendMessage(db, { from: root.id, to: child.id, body: "r2" })
    sendMessage(db, { from: root.id, to: child.id, body: "r3" })
    sendMessage(db, { from: child.id, to: root.id, body: "c1" })

    expect(unreadFor(db, child.id)).toBe(3) // 自身：root 的三条
    expect(unreadFor(db, root.id)).toBe(6) // 自身 3（h1,h2,c1）+ 子 3
    expect(unreadFor(db, human.id)).toBe(0) // 只发不收
  })

  it("recurses through grandchildren", () => {
    const root = makeAgent("rec-root")
    const child = makeAgent("rec-child", root.id)
    const grandchild = makeAgent("rec-gc", child.id)

    sendMessage(db, { from: root.id, to: child.id, body: "下钻" })
    sendMessage(db, { from: child.id, to: grandchild.id, body: "继续" })

    expect(unreadFor(db, grandchild.id)).toBe(1)
    expect(unreadFor(db, child.id)).toBe(2) // 自身 1（下钻）+ 孙 1（继续）
    expect(unreadFor(db, root.id)).toBe(2) // 自身 0 + 子树 2
  })

  it("includes shout unread for every node", () => {
    const root = makeAgent("shout-un-root")
    ensureHuman(db)

    shout(db, root.id, "全员开会")

    expect(unreadFor(db, root.id)).toBe(0) // 自己发的不计
    const others = listAgents(db).filter((n) => n.id !== root.id)
    for (const node of others) {
      expect(unreadFor(db, node.id)).toBe(1)
    }
  })
})

describe("inbox cursor", () => {
  it("returns messages after the cursor in seq order with a limit", () => {
    const a = makeAgent("in-a")
    const b = makeAgent("in-b")
    const m1 = sendMessage(db, { from: a.id, to: b.id, body: "1" }).message
    const m2 = sendMessage(db, { from: a.id, to: b.id, body: "2" }).message
    const m3 = sendMessage(db, { from: a.id, to: b.id, body: "3" }).message

    expect(inbox(db, b.id).map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])
    expect(inbox(db, b.id, { after: m1.seq }).map((m) => m.id)).toEqual([m2.id, m3.id])
    expect(inbox(db, b.id, { after: m1.seq, limit: 1 }).map((m) => m.id)).toEqual([m2.id])
  })

  it("does not surface conversations the agent is not part of", () => {
    const a = makeAgent("in-c")
    const b = makeAgent("in-d")
    const stranger = makeAgent("in-e")
    const { message } = sendMessage(db, { from: a.id, to: b.id, body: "私下说" })

    expect(inbox(db, stranger.id, { after: 0 })).toHaveLength(0)
    expect(inbox(db, stranger.id, { after: 0 })).not.toContain(message)
  })
})

describe("history paging", () => {
  it("pages backwards with history(conversationId, before, limit)", () => {
    const a = makeAgent("hist-a")
    const b = makeAgent("hist-b")
    const dm = createDm(db, a.id, b.id)
    sendMessage(db, { from: a.id, to: b.id, body: "1" })
    sendMessage(db, { from: a.id, to: b.id, body: "2" })
    sendMessage(db, { from: a.id, to: b.id, body: "3" })
    const fourth = sendMessage(db, { from: a.id, to: b.id, body: "4" }).message
    sendMessage(db, { from: a.id, to: b.id, body: "5" })

    expect(history(db, dm.id, undefined, 2).map((m) => m.body)).toEqual(["4", "5"])
    expect(history(db, dm.id, fourth.seq, 2).map((m) => m.body)).toEqual(["2", "3"])
    expect(history(db, dm.id).map((m) => m.body)).toEqual(["1", "2", "3", "4", "5"])
  })
})

describe("ensureHuman", () => {
  it("creates the human node idempotently with the resolution-2 shape", () => {
    const first = ensureHuman(db)
    const again = ensureHuman(db)

    expect(again.id).toBe(first.id)
    expect(listAgents(db).filter((n) => n.name === "用户")).toHaveLength(1)
    expect(first).toMatchObject({ kind: "logical", vendor: "human", status: "offline" })
    expect(first.parentId).toBeUndefined()
    expect(first.rootId).toBe(first.id)
  })
})
