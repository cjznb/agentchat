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
  ContainerNotChatTargetError,
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
import type { Gated } from "../../server/core/permissions"
import {
  createDm,
  getConversationByKey,
  isParticipant,
  listConversations,
  listParticipants,
} from "../../server/store/conversations"
import { getReadState } from "../../server/store/read_states"
import { history as storeHistory, send as storeSend } from "../../server/store/messages"

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

/** 从闸门判别联合中取出即时执行结果（`"approved" in result` 正向判别）。 */
function approved<T>(result: Gated<T>): T {
  if (!("approved" in result)) throw new Error("expected an approved outcome")
  return result.approved
}

/**
 * 设置 wake_jobs 状态以驱动回执派生透传（Plan 5 修复 2 后发送即建 job，
 * 故 upsert 而非裸 INSERT，兼容「行已存在」）。
 */
function setWakeJobState(messageSeq: number, agentId: string, state: string): void {
  db.prepare<[number, string, string, number, number], void>(
    `INSERT INTO wake_jobs (message_id, agent_id, state, retry_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id, agent_id) DO UPDATE SET state = excluded.state`,
  ).run(messageSeq, agentId, state, Date.now(), Date.now())
}

/** 该消息的唤醒任务收件人集合（Task 3 唤醒集合 T 断言用）。 */
function wakeAgentsOf(messageSeq: number): string[] {
  return db
    .prepare<[number], { agent_id: string }>(
      "SELECT agent_id FROM wake_jobs WHERE message_id = ? ORDER BY agent_id",
    )
    .all(messageSeq)
    .map((row) => row.agent_id)
}

/** Task 3 T 路由夹具：owner（创建者）+ 张三 + 李四，三个 online runtime 成员的群。 */
function t3Group(prefix: string) {
  const owner = makeAgent(`${prefix}-owner`)
  const zhang = makeAgent("张三")
  const li = makeAgent("李四")
  const group = approved(
    createGroup(db, { name: "T3 路由群", createdBy: owner.id, memberIds: [zhang.id, li.id] }),
  )
  return { owner, zhang, li, group }
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
    const group = approved(createGroup(db, { name: "攻坚组", createdBy: a.id, memberIds: [b.id] }))
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
    const group = approved(createGroup(db, { name: "内群", createdBy: a.id, memberIds: [b.id] }))
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

    const result = approved(shout(db, human.id, "全员注意"))

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
    const again = approved(shout(db, human.id, "再喊一次"))
    expect(again.message.conversationId).toBe(result.message.conversationId)
  })
})

describe("分组容器不是聊天实体（M1 服务端守卫）", () => {
  /** 分组容器（`role_tag="container"`，如 `opencode@<host>` 实例节点）。 */
  const container = (name: string): Agent =>
    insertAgent(db, {
      name,
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      roleTag: "container",
    })

  it("rejects a DM to a container on the auto-create path (container_not_chat_target)", () => {
    const human = ensureHuman(db)
    const box = container("m1-box-auto")
    expect(() => sendMessage(db, { from: human.id, to: box.id, body: "hi" })).toThrow(
      ContainerNotChatTargetError,
    )
    // 被拒的发送不得留下 DM 会话。
    expect(getConversationByKey(db, `dm:${[human.id, box.id].sort().join("_")}`)).toBeUndefined()
  })

  it("rejects sending into an existing container DM (conversation-id path, historical rows)", () => {
    const human = ensureHuman(db)
    const box = container("m1-box-existing")
    // 直造历史 DM（模拟旧数据；`createDm` 是 store 原语，不经守卫）。
    const dm = createDm(db, human.id, box.id)
    expect(() => sendMessage(db, { from: human.id, to: dm.id, body: "hi" })).toThrow(
      ContainerNotChatTargetError,
    )
  })

  it("keeps internal system messages deliverable into a container DM (kind=system exempt)", () => {
    const human = ensureHuman(db)
    const box = container("m1-box-system")
    const dm = createDm(db, human.id, box.id)
    expect(() =>
      storeSend(db, {
        conversationId: dm.id,
        fromAgentId: human.id,
        kind: "system",
        body: "（系统）提醒",
      }),
    ).not.toThrow()
    expect(history(db, dm.id)).toHaveLength(1)
  })

  it("excludes containers from shout recipients (no receipt, no wake job)", () => {
    const human = ensureHuman(db)
    const box = container("m1-box-shout")
    const peer = makeAgent("m1-shout-peer")
    const result = approved(shout(db, human.id, "全员注意"))
    const recipients = result.receipts.map((r) => r.agentId)
    expect(recipients).toContain(peer.id)
    expect(recipients).not.toContain(box.id)
  })
})

describe("唤醒集合 T（spec §2，Task 3）", () => {
  it("agent 发群消息无提及 → 0 条 wake_jobs（回执收件方口径不变 = 其余全员）", () => {
    const { owner, zhang, li, group } = t3Group("t3-noat")

    const sent = sendMessage(db, { from: owner.id, to: group.id, body: "进度同步" })

    expect(wakeAgentsOf(sent.message.seq)).toEqual([])
    // 可见性/回执口径不变：回执仍列其余全员（wake 才按 T 过滤）。
    expect(new Set(sent.receipts.map((r) => r.agentId))).toEqual(new Set([zhang.id, li.id]))
    expect(sent.receipts.every((r) => r.stage === "queued")).toBe(true)
  })

  it("@张三 → 仅张三 1 条 wake_job", () => {
    const { owner, zhang, li, group } = t3Group("t3-at")

    const sent = sendMessage(db, { from: owner.id, to: group.id, body: "@张三 你跟进" })

    expect(wakeAgentsOf(sent.message.seq)).toEqual([zhang.id])
    // 回执口径不变：仍列其余全员（仅 wake 按 T 过滤）。
    expect(new Set(sent.receipts.map((r) => r.agentId))).toEqual(new Set([zhang.id, li.id]))
  })

  it("@所有人 → 除发送者外的全体参与者", () => {
    const { owner, zhang, li, group } = t3Group("t3-all")

    const sent = sendMessage(db, { from: zhang.id, to: group.id, body: "@所有人 开会" })

    expect(new Set(wakeAgentsOf(sent.message.seq))).toEqual(new Set([owner.id, li.id]))
  })

  it("人类（isHuman）无提及 → 全体参与者", () => {
    const { owner, zhang, li, group } = t3Group("t3-human-none")
    const human = ensureHuman(db)

    const sent = sendMessage(db, { from: human.id, to: group.id, body: "大家下午好" })

    expect(new Set(wakeAgentsOf(sent.message.seq))).toEqual(new Set([owner.id, zhang.id, li.id]))
  })

  it("人类带提及 → 仅被提及者", () => {
    const { li, group } = t3Group("t3-human-at")
    const human = ensureHuman(db)

    const sent = sendMessage(db, { from: human.id, to: group.id, body: "@李四 跟进客户反馈" })

    expect(wakeAgentsOf(sent.message.seq)).toEqual([li.id])
  })

  // F2（PAIR 评审裁决锁定）：spec §2 字面「M 空 → 人类 T=全体」—— 防止被反向「修」成无人唤醒。
  it("人类@错字（M 空、scope=explicit）→ 唤醒全体参与者", () => {
    const { owner, zhang, li, group } = t3Group("t3-human-typo")
    const human = ensureHuman(db)

    const sent = sendMessage(db, { from: human.id, to: group.id, body: "@错字 在吗" })

    expect(sent.mentions).toMatchObject({ matched: [], unmatched: ["错字"], scope: "explicit" })
    expect(sent.message.meta).toEqual({ mentions: [], mentionScope: "explicit" })
    expect(new Set(wakeAgentsOf(sent.message.seq))).toEqual(new Set([owner.id, zhang.id, li.id]))
  })

  it("结构化 mentions（id 前 8 位）与正文取并集并参与 T 计算", () => {
    const { owner, zhang, li, group } = t3Group("t3-structured")

    const sent = sendMessage(db, {
      from: owner.id,
      to: group.id,
      body: "@张三 看下",
      mentions: [li.id.slice(0, 8)],
    })

    expect(new Set(wakeAgentsOf(sent.message.seq))).toEqual(new Set([zhang.id, li.id]))
    expect(sent.mentions?.matched.map((t) => t.id).sort()).toEqual([zhang.id, li.id].sort())
  })

  it("容器恒排除在 T 与回执收件方之外（M1 延伸）", () => {
    const { owner, group } = t3Group("t3-container")
    const box = insertAgent(db, {
      name: "t3-container-box",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      roleTag: "container",
    })
    addParticipant(db, { conversationId: group.id, agentId: box.id, invitedBy: owner.id })

    const sent = sendMessage(db, { from: owner.id, to: group.id, body: "@所有人 注意" })

    expect(wakeAgentsOf(sent.message.seq)).not.toContain(box.id)
    expect(sent.receipts.map((r) => r.agentId)).not.toContain(box.id)
  })

  it('kind:"system" 内部消息豁免：不经提及路由、0 wake_job、全员收件箱可达', () => {
    const { owner, zhang, li, group } = t3Group("t3-system")

    const message = storeSend(db, {
      conversationId: group.id,
      fromAgentId: owner.id,
      kind: "system",
      body: "群成员变更：李四 加入了群聊",
    })

    expect(wakeAgentsOf(message.seq)).toEqual([])
    expect(message.meta).toBeUndefined() // 直写路径：不解析提及、不落 mentions meta
    for (const member of [owner, zhang, li]) {
      expect(inbox(db, member.id).map((m) => m.id)).toContain(message.id)
    }
  })

  it("messages.meta.mentions 与 mentionScope 落库可查（经 history）", () => {
    const { owner, zhang, li, group } = t3Group("t3-meta")

    const explicit = sendMessage(db, { from: owner.id, to: group.id, body: "@李四 看下" }).message
    const none = sendMessage(db, { from: owner.id, to: group.id, body: "全员周报" }).message
    const all = sendMessage(db, { from: owner.id, to: group.id, body: "@所有人 集合" }).message

    expect(explicit.meta).toEqual({ mentions: [li.id], mentionScope: "explicit" })
    expect(none.meta).toEqual({ mentions: [], mentionScope: "none" })
    expect(all.meta?.["mentionScope"]).toBe("all")
    expect(all.meta?.["mentions"]).toEqual(expect.arrayContaining([owner.id, zhang.id, li.id]))

    // 落库侧（读回）与发送时对象一致。
    const stored = history(db, group.id).find((m) => m.id === explicit.id)
    expect(stored?.meta).toEqual({ mentions: [li.id], mentionScope: "explicit" })
  })

  it("send 出参回显 mentions：命中回 matched、错字进 unmatched 且不阻断发送", () => {
    const { owner, zhang, group } = t3Group("t3-echo")

    const hit = sendMessage(db, { from: owner.id, to: group.id, body: "@张三 请过目" })
    expect(hit.mentions).toEqual({
      matched: [{ id: zhang.id, name: "张三" }],
      unmatched: [],
      scope: "explicit",
    })

    const typo = sendMessage(db, { from: owner.id, to: group.id, body: "@错字 在吗" })
    expect(typo.mentions).toEqual({ matched: [], unmatched: ["错字"], scope: "explicit" })
    expect(typo.message.body).toBe("@错字 在吗") // 宽容回显：未命中不阻断发送（spec §3.2）
    expect(wakeAgentsOf(typo.message.seq)).toEqual([]) // agent：M 空 → ∅
  })

  it("DM 与喊话不走提及路由（逐字节不变：无 meta、无回声、T = 既有收件方）", () => {
    const a = makeAgent("t3-dm-a")
    const b = makeAgent("t3-dm-b")

    const dm = sendMessage(db, { from: a.id, to: b.id, body: `@${b.name} 在吗` })
    expect(dm.message.meta).toBeUndefined()
    expect(dm.mentions).toBeUndefined()
    expect(wakeAgentsOf(dm.message.seq)).toEqual([b.id])

    const human = ensureHuman(db)
    const shouted = approved(shout(db, human.id, "@所有人 注意"))
    expect(shouted.message.meta).toBeUndefined()
    expect(shouted.mentions).toBeUndefined()
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
    const group = approved(createGroup(db, { name: "回执群", createdBy: a.id, memberIds: [b.id, c.id] }))

    const { message, receipts } = sendMessage(db, { from: a.id, to: group.id, body: "开工" })
    expect(receipts).toHaveLength(2)
    expect(receipts.every((r) => r.stage === "queued")).toBe(true)

    setWakeJobState(message.seq, b.id, "sending")
    expect(receiptState(db, message, b.id)).toBe("sending")
    expect(receiptState(db, message, c.id)).toBe("queued")

    db.prepare<[string, number, string], void>(
      "UPDATE wake_jobs SET state = ? WHERE message_id = ? AND agent_id = ?",
    ).run("accepted", message.seq, b.id)
    expect(receiptState(db, message, b.id)).toBe("delivered")

    setWakeJobState(message.seq, c.id, "refused")
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
    // 超级观察者（复审 Important #1）：human 计入全部会话未读 = 未参与的 root↔child 4 条
    expect(unreadFor(db, human.id)).toBe(4)
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

  it("counts a shared group message once across a root's subtree (dedup by message seq)", () => {
    const root = makeAgent("dedup-root")
    const child = makeAgent("dedup-child", root.id)
    const sender = makeAgent("dedup-sender")
    const group = approved(
      createGroup(db, {
        name: "共享群",
        createdBy: sender.id,
        memberIds: [root.id, child.id],
      }),
    )
    // 同一会话内、非自发的一条消息 → root 与 child 各自直达未读该 seq
    sendMessage(db, { from: sender.id, to: group.id, body: "同一条" })

    expect(unreadFor(db, child.id)).toBe(1)
    // 裁决：子树内按 message seq 去重 —— 同一消息被父子同时未读只计一次
    expect(unreadFor(db, root.id)).toBe(1)
    // 自发消息排除不变
    expect(unreadFor(db, sender.id)).toBe(0)
  })
})

describe("human super-observer (read side, 复审 Important #1)", () => {
  it("receives and reads group messages without any participants row", () => {
    const a = makeAgent("so-a")
    const b = makeAgent("so-b")
    const group = approved(createGroup(db, { name: "观察组", createdBy: a.id, memberIds: [b.id] }))
    const human = ensureHuman(db)
    expect(isParticipant(db, group.id, human.id)).toBe(false)

    const { message } = sendMessage(db, { from: b.id, to: group.id, body: "组内回复" })

    // human 非成员仍收到群消息（隐含成员：读取不依赖 participants 行）
    expect(inbox(db, human.id, { after: 0 }).map((m) => m.id)).toContain(message.id)
    expect(unreadFor(db, human.id)).toBe(1)
    // 未读位点记入 read_states（spec §5.4），ack 后归零
    expect(ack(db, human.id, [message.id])).toBe(1)
    expect(unreadFor(db, human.id)).toBe(0)

    // 回归保护：非 human 节点可见性口径不变（旁观者看不到、未读为 0）
    const stranger = makeAgent("so-stranger")
    expect(inbox(db, stranger.id, { after: 0 })).toHaveLength(0)
    expect(unreadFor(db, stranger.id)).toBe(0)
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
