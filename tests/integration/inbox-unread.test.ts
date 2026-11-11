/**
 * P9 —— `inbox` 只看未读（回归锁）。
 *
 * 真机缺陷：`inboxMessages` 只按 `seq > $after`（缺省 0）取「全部可见历史的最旧 limit 条」，
 * 于是出现「unread=3（其中 2 条群消息）但 inbox 页里全是旧 DM」——新未读 seq 更大，永远挤不进
 * 这一页，且与 `unreadFor` 口径打架。修复后判据 = **每会话 `read_states` 位点之后**（无位点 = 0）。
 *
 * 本文件固定：真机场景、`after` 叠加语义、human 口径、喊话口径、自发消息边界、wait 结论。
 * 每例独立临时 `$AGENTCHAT_HOME`。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { ack, ensureHuman, inbox, sendMessage, unreadFor } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { insertAgent, type Agent } from "../../server/store/agents"
import { createDm, createGroup } from "../../server/store/conversations"
import { send as storeSend, type Message } from "../../server/store/messages"

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

function bodies(messages: readonly Message[]): string[] {
  return messages.map((message) => message.body)
}

function ids(messages: readonly Message[]): string[] {
  return messages.map((message) => message.id)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 断言等待者此刻仍未解锁（同 wait.test.ts：错误解锁走同步通知，微任务必然先返回）。 */
async function expectStillPending(wait: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    wait.then(() => "resolved" as const),
    delay(50).then(() => "pending" as const),
  ])
  expect(outcome).toBe("pending")
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-inbox-unread-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/**
 * 真机场景夹具：A 与 B 的 DM + B 建的群（A 是成员）。
 * 「旧」两条（DM+群）由 A 读到位点，「新」三条（1 DM + 2 群）保持未读。
 */
function scenario() {
  const a = makeAgent("ux-a")
  const b = makeAgent("ux-b")
  const dm = createDm(db, a.id, b.id)
  const group = createGroup(db, { name: "ux-g", createdBy: b.id, memberIds: [a.id] })

  const oldDm = sendMessage(db, { from: b.id, to: a.id, body: "旧DM" }).message
  const oldGroup = sendMessage(db, { from: b.id, to: group.id, body: "旧群" }).message
  ack(db, a.id, [oldDm.id, oldGroup.id])

  const newDm = sendMessage(db, { from: b.id, to: a.id, body: "新DM" }).message
  const newGroup1 = sendMessage(db, { from: b.id, to: group.id, body: "新群1" }).message
  const newGroup2 = sendMessage(db, { from: b.id, to: group.id, body: "新群2" }).message
  return { a, b, dm, group, oldDm, oldGroup, newDm, newGroup1, newGroup2 }
}

describe("P9：inbox 只看未读", () => {
  it("真机场景：已读的旧 DM/群消息不再出现；新未读 3 条（含 2 条群消息）全部出现，与 unreadFor 一致", () => {
    const s = scenario()

    const page = inbox(db, s.a.id)
    expect(bodies(page)).toEqual(["新DM", "新群1", "新群2"])
    expect(ids(page)).not.toContain(s.oldDm.id)
    expect(ids(page)).not.toContain(s.oldGroup.id)
    // 与未读口径一致（本例 A 无自发消息、无喊话、未超 limit）
    expect(unreadFor(db, s.a.id)).toBe(3)
    expect(page).toHaveLength(unreadFor(db, s.a.id))
  })

  it("after 仍是叠加下界：可翻页，且不会复活已读消息", () => {
    const s = scenario()

    // after=0（缺省）由未读游标主导：已读的旧消息不复活
    expect(bodies(inbox(db, s.a.id, { after: 0 }))).toEqual(["新DM", "新群1", "新群2"])
    // 指向未读中间 → 只取其后
    expect(bodies(inbox(db, s.a.id, { after: s.newDm.seq }))).toEqual(["新群1", "新群2"])
    expect(bodies(inbox(db, s.a.id, { after: s.newDm.seq, limit: 1 }))).toEqual(["新群1"])
    // 指向已读区间 → 未读游标仍然拦住已读的旧消息
    expect(bodies(inbox(db, s.a.id, { after: s.oldGroup.seq }))).toEqual(["新DM", "新群1", "新群2"])
  })

  it("human：无 read_states 时等价旧行为（可见全部）；ack 后只看未读", () => {
    const s = scenario()
    const human = ensureHuman(db)

    // human 是超级观察者且未读过任何东西 → 位点 0 → 可见全部（旧行为）
    const all = inbox(db, human.id)
    expect(ids(all)).toEqual([s.oldDm.id, s.oldGroup.id, s.newDm.id, s.newGroup1.id, s.newGroup2.id])
    expect(unreadFor(db, human.id)).toBe(5)
    expect(all).toHaveLength(unreadFor(db, human.id))

    // 只推进 DM 的位点：DM 旧消息消失，群会话位点未动 → 群消息仍在
    ack(db, human.id, [s.oldDm.id])
    const partial = inbox(db, human.id)
    expect(ids(partial)).not.toContain(s.oldDm.id)
    expect(ids(partial)).toContain(s.oldGroup.id)
    expect(partial).toHaveLength(4)
    expect(unreadFor(db, human.id)).toBe(4)
  })

  it("喊话广播：未读喊话进 inbox（非成员亦可见），ack 后消失", () => {
    const s = scenario()
    const human = ensureHuman(db)
    const shout = sendMessage(db, { from: human.id, to: "*", body: "全体通知" }).message

    expect(ids(inbox(db, s.a.id))).toContain(shout.id)
    expect(unreadFor(db, s.a.id)).toBe(4) // 3 条新未读 + 喊话

    ack(db, s.a.id, [shout.id])
    expect(ids(inbox(db, s.a.id))).not.toContain(shout.id)
    expect(bodies(inbox(db, s.a.id))).toEqual(["新DM", "新群1", "新群2"])
    expect(unreadFor(db, s.a.id)).toBe(3)
  })

  it("默认排除自发（自激环路防护）：文本自发不在页内；includeSelf:true 复原；页与 unread 同口径", () => {
    const s = scenario()
    const mine = sendMessage(db, { from: s.a.id, to: s.group.id, body: "我自己的" }).message

    expect(unreadFor(db, s.a.id)).toBe(3) // 自发消息不计未读（directUnreadSeqs 本就 JOIN from <> 自己）
    const page = inbox(db, s.a.id)
    expect(ids(page)).not.toContain(mine.id) // 默认排除自发：杜绝"轮询 inbox→逐条回复"的自激环路
    expect(page).toHaveLength(3)
    // A 的口径：页内容与未读计数**同口径**（改动前是"计数排除自发、页却含自发"，会误判成取件失败）
    expect(page).toHaveLength(unreadFor(db, s.a.id))

    // 逃生口：旧行为可显式找回
    const withSelf = inbox(db, s.a.id, { includeSelf: true })
    expect(ids(withSelf)).toContain(mine.id)
    expect(withSelf).toHaveLength(4)
  })

  it("例外：喊话与 system 通知仍含自发；且 shout 分支自激**不可达**（agent 不能向 shout 会话 send）", () => {
    const s = scenario()
    const human = ensureHuman(db)
    // 用人做发送者：human 的 shout 立即执行（agent 的 shout 会走审批闸门）
    const shout = sendMessage(db, { from: human.id, to: "*", body: "全体通知" }).message
    expect(ids(inbox(db, human.id))).toContain(shout.id) // 发送者看得到自己那条广播（例外生效）
    expect(ids(inbox(db, s.a.id))).toContain(shout.id) // 其余节点各得一条（既有 DoD）

    // 自激不可达：agent 对 shout 会话 id 直接 send → 成员资格拒绝（喊话会话无 participants 行）
    expect(() =>
      sendMessage(db, { from: s.a.id, to: shout.conversationId, body: "回声" }),
    ).toThrow(expect.objectContaining({ code: "not_participant" }))

    // 例外②system 通知：自发系统消息仍全员可达（既有 DoD）
    const system = storeSend(db, {
      conversationId: s.group.id,
      fromAgentId: s.a.id,
      kind: "system",
      body: "（系统）通知",
    })
    expect(ids(inbox(db, s.a.id))).toContain(system.id)
  })
})

describe("P9：wait 结论（未改 wait 语义）", () => {
  it("已有未读 → 立即返回该批未读；全部 ack 后 → 真正挂起，直到新消息到达", async () => {
    const s = scenario()

    // 有未读：waitFor 先同步复查一次，非空即返回（"已收部分非空手"）
    const immediate = await inbox(db, s.a.id, { wait: { timeoutMs: 3000 } })
    expect(immediate.timedOut).toBe(false)
    expect(bodies(immediate.messages)).toEqual(["新DM", "新群1", "新群2"])
    expect(immediate.receipts).toEqual([])

    // 全部读过 → 无未读 → 挂起（等待语义仍是"新到达"）
    ack(db, s.a.id, [s.newDm.id, s.newGroup1.id, s.newGroup2.id])
    expect(inbox(db, s.a.id)).toHaveLength(0)

    const pending = inbox(db, s.a.id, { wait: { timeoutMs: 3000 } })
    await expectStillPending(pending)

    sendMessage(db, { from: s.b.id, to: s.a.id, body: "到件" })
    const reply = await pending
    expect(reply.timedOut).toBe(false)
    expect(bodies(reply.messages)).toEqual(["到件"])
  })
})
