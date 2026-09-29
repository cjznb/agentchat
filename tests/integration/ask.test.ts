/**
 * Task 2 —— 请求批示（ask）集成测试（brief DoD）：
 * - 建卡落会话：`to='human'` → 发起方↔用户 DM 且 meta 齐备；`to=agent` 有 DM/共同群 → 落该会话；
 *   无任何共同会话 → `conversation_required`（无孤儿单）；`to==from` → `self_ask`
 * - `respondAsk`：choice ∈ options → `answered` + `result={choice,responder,decidedAt}`；
 *   非法 choice / `allow_custom=false` 的 text → `invalid_choice`；二次 → `ask_already_answered`
 *   且 `result` 不被覆盖；非目标非 human → `forbidden`；human 代答任意 ask
 * - 答复消息落卡所在会话、`meta.askId`、`kind='system'`；`publish` 解锁 `ask{wait}`
 * - `ask{wait}`：respond 后 `{ask:已决,timedOut:false}`；短超时 → `{ask:pending,timedOut:true}`
 * - `sweepExpired` 覆盖 `kind='ask'`：24h → `expired` + 发起方收「批示过期」system 回执（R2）
 * - R1：`approvalSnapshotSchema` / MCP 审批出参容纳 `'ask'`；`emitApproval` 对 ask 行自校验通过
 * - Task 4：群 ask —— `mentions_required` / `mention_not_found`（含名单）/ `mention_not_participant`
 *   三错误码、一目标一卡、三形态等待（`scope:"all"` 全回 / 缺省 all 超时带 `pending` /
 *   `scope:"any"` 首回即返回 / 不传 `wait` 立即返回 `asks` 无 `reply`）
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../../server/config"
import { registerRoot } from "../../server/core/agents"
import { NotParticipantError, sendMessage } from "../../server/core/messaging"
import {
  APPROVAL_TTL_MS,
  ask,
  AskAlreadyAnsweredError,
  AskForbiddenError,
  AskNotFoundError,
  ConversationRequiredError,
  ensureHuman,
  InvalidChoiceError,
  MentionNotParticipantError,
  MentionNotFoundError,
  MentionsRequiredError,
  respondAsk,
  SelfAskError,
  sweepExpired,
} from "../../server/core/permissions"
import { askGroup } from "../../server/core/ask-group"
import { openDb, type Db } from "../../server/db"
import { getApproval, listApprovals, type Approval } from "../../server/store/approvals"
import {
  createDm,
  createGroup,
  dmKey,
  getConversationByKey,
  isParticipant,
} from "../../server/store/conversations"
import { history } from "../../server/store/messages"
import {
  approvalSnapshotSchema,
  MCP_TOOL_OUTPUTS,
  wsApprovalPayloadSchema,
} from "../../shared/contracts"
import { framesSince, resetWsHub } from "../../server/ws"
import * as waitModule from "../../server/core/wait"

let home = ""
let db: Db

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-ask-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 注册根（spec §9 身份 = agent_keys，生产形态）。 */
function makeRoot(name: string) {
  return registerRoot(db, home, { name, vendor: "opencode" }).agent
}

/** 卡/答复消息（按 `meta.askId` 归组）。 */
function messagesWithAsk(conversationId: string, askId: string) {
  return history(db, { conversationId }).filter((m) => m.meta?.["askId"] === askId)
}

/** 捕获同步抛出的 Error（无 `as` 断言的错误码断言）。 */
function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the call to throw")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** WS 环形缓冲中最后一条 `approval` 事件的 payload（R1 自校验证据）。 */
function lastApprovalPayload(): unknown {
  const events = framesSince(0)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (typeof event === "object" && event !== null && "type" in event && event.type === "approval") {
      return "payload" in event ? event.payload : undefined
    }
  }
  return undefined
}

describe("ask: 建卡落会话", () => {
  it("lands a to='human' card in the initiator↔human DM with the ask meta", () => {
    const root = makeRoot("ask-human-root")
    const human = ensureHuman(db)

    const { ask: stored } = ask(db, root.id, {
      to: "human",
      question: "部署到哪个环境？",
      options: ["staging", "prod"],
    })

    expect(stored).toMatchObject({
      kind: "ask",
      target: "human",
      action: "ask",
      status: "pending",
      payload: { question: "部署到哪个环境？", options: ["staging", "prod"], allowCustom: true },
    })
    const dm = getConversationByKey(db, dmKey(root.id, human.id))
    expect(dm).toBeDefined()
    const cards = messagesWithAsk(dm?.id ?? "", stored.id)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.kind).toBe("system")
    expect(cards[0]?.meta).toMatchObject({
      askId: stored.id,
      kind: "ask",
      question: "部署到哪个环境？",
      options: ["staging", "prod"],
      allowCustom: true,
    })
  })

  it("lands a to=agent card in the existing DM", () => {
    const a = makeRoot("ask-dm-a")
    const b = makeRoot("ask-dm-b")
    const dm = createDm(db, a.id, b.id)

    const { ask: stored } = ask(db, a.id, { to: b.id, question: "走不走？", options: ["走"] })

    expect(stored).toMatchObject({ kind: "ask", target: b.id, action: "ask", status: "pending" })
    const cards = messagesWithAsk(dm.id, stored.id)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: "system", fromAgentId: a.id })
  })

  it("lands a to=agent card in a shared group when no DM exists", () => {
    const a = makeRoot("ask-grp-a")
    const b = makeRoot("ask-grp-b")
    const group = createGroup(db, { name: "共同群", createdBy: a.id, memberIds: [b.id] })

    const { ask: stored } = ask(db, a.id, { to: b.id, question: "?", options: ["ok"] })

    expect(messagesWithAsk(group.id, stored.id)).toHaveLength(1)
  })

  it("rejects a to=agent ask without any shared conversation and creates no orphan row", () => {
    const a = makeRoot("ask-nope-a")
    const b = makeRoot("ask-nope-b")

    const error = errorOf(() => ask(db, a.id, { to: b.id, question: "?", options: [] }))
    expect(error).toBeInstanceOf(ConversationRequiredError)
    expect(error).toMatchObject({ code: "conversation_required" })
    expect(listApprovals(db)).toHaveLength(0)
  })

  it("rejects asking yourself with self_ask", () => {
    const a = makeRoot("ask-self-a")
    const error = errorOf(() => ask(db, a.id, { to: a.id, question: "?", options: [] }))
    expect(error).toBeInstanceOf(SelfAskError)
    expect(error).toMatchObject({ code: "self_ask" })
  })
})

describe("respondAsk: 首答生效 + 答复落会话", () => {
  it("records the chosen option and posts the answer into the card conversation", () => {
    const root = makeRoot("ans-choice-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, { to: "human", question: "选哪个", options: ["a", "b"] })

    const answered = respondAsk(db, stored.id, human.id, { choice: "a" })

    expect(answered.status).toBe("answered")
    expect(answered.result).toMatchObject({ choice: "a", responder: human.id })
    expect(answered.result?.["decidedAt"]).toEqual(expect.any(Number))
    expect(answered.decidedAt).toEqual(answered.result?.["decidedAt"])
    expect(getApproval(db, stored.id)?.status).toBe("answered")

    const dm = getConversationByKey(db, dmKey(root.id, human.id))
    const answers = messagesWithAsk(dm?.id ?? "", stored.id).filter(
      (m) => m.fromAgentId === human.id,
    )
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ kind: "system", fromAgentId: human.id })
    expect(answers[0]?.body).toContain("a")
  })

  it("accepts custom text when allow_custom is true", () => {
    const root = makeRoot("ans-text-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, { to: "human", question: "怎么说", options: ["a"] })

    const answered = respondAsk(db, stored.id, human.id, { text: "随便吧" })

    expect(answered.status).toBe("answered")
    expect(answered.result).toMatchObject({ text: "随便吧", responder: human.id })
  })

  it("rejects a choice outside the options with invalid_choice", () => {
    const root = makeRoot("ans-badchoice-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, {
      to: "human",
      question: "?",
      options: ["a"],
      allowCustom: false,
    })

    const error = errorOf(() => respondAsk(db, stored.id, human.id, { choice: "z" }))
    expect(error).toBeInstanceOf(InvalidChoiceError)
    expect(error).toMatchObject({ code: "invalid_choice" })
    expect(getApproval(db, stored.id)?.status).toBe("pending")
  })

  it("rejects custom text when allow_custom is false with invalid_choice", () => {
    const root = makeRoot("ans-badtext-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, {
      to: "human",
      question: "?",
      options: ["a"],
      allowCustom: false,
    })

    const error = errorOf(() => respondAsk(db, stored.id, human.id, { text: "自定义" }))
    expect(error).toBeInstanceOf(InvalidChoiceError)
    expect(getApproval(db, stored.id)?.status).toBe("pending")
  })

  it("keeps the first answer and reports ask_already_answered on the second", () => {
    const root = makeRoot("ans-idem-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, { to: "human", question: "?", options: ["a", "b"] })

    respondAsk(db, stored.id, human.id, { choice: "a" })
    const error = errorOf(() => respondAsk(db, stored.id, human.id, { choice: "b" }))

    expect(error).toBeInstanceOf(AskAlreadyAnsweredError)
    expect(error).toMatchObject({ code: "ask_already_answered" })
    expect(getApproval(db, stored.id)?.result).toMatchObject({ choice: "a" })
  })

  it("answers into the original card conversation even after a DM is created later", () => {
    const a = makeRoot("ans-persist-a")
    const b = makeRoot("ans-persist-b")
    const group = createGroup(db, { name: "先群后 DM", createdBy: a.id, memberIds: [b.id] })

    const { ask: stored } = ask(db, a.id, { to: b.id, question: "?", options: ["ok"] })
    // 建卡时无 DM → 卡落共同群；conversationId 随单据 payload 持久化。
    expect(messagesWithAsk(group.id, stored.id)).toHaveLength(1)
    expect(stored.payload).toMatchObject({ conversationId: group.id })

    // 双方随后新建 DM —— 若 respondAsk 重算卡会话，答复会误落新 DM。
    const dm = createDm(db, a.id, b.id)

    const answered = respondAsk(db, stored.id, b.id, { choice: "ok" })
    expect(answered.status).toBe("answered")

    // 答复落卡所在会话（群），而非新 DM。
    expect(
      messagesWithAsk(group.id, stored.id).filter((m) => m.fromAgentId === b.id),
    ).toHaveLength(1)
    expect(messagesWithAsk(dm.id, stored.id)).toHaveLength(0)
  })

  it("forbids a non-target non-human responder and allows the target / the human", () => {
    const a = makeRoot("ans-forbid-a")
    const target = makeRoot("ans-forbid-target")
    const other = makeRoot("ans-forbid-other")
    const human = ensureHuman(db)
    createDm(db, a.id, target.id)
    const { ask: stored } = ask(db, a.id, { to: target.id, question: "?", options: ["a"] })

    const error = errorOf(() => respondAsk(db, stored.id, other.id, { choice: "a" }))
    expect(error).toBeInstanceOf(AskForbiddenError)
    expect(error).toMatchObject({ code: "forbidden" })

    const answered = respondAsk(db, stored.id, target.id, { choice: "a" })
    expect(answered.result).toMatchObject({ responder: target.id })

    // human 超级观察者：代理答复 agent↔agent 的 ask
    const { ask: second } = ask(db, a.id, { to: target.id, question: "?", options: ["b"] })
    const proxied = respondAsk(db, second.id, human.id, { choice: "b" })
    expect(proxied.result).toMatchObject({ responder: human.id })
  })

  it("reports ask_not_found for an unknown id", () => {
    const human = ensureHuman(db)
    const error = errorOf(() => respondAsk(db, "no-such-ask", human.id, { choice: "a" }))
    expect(error).toBeInstanceOf(AskNotFoundError)
    expect(error).toMatchObject({ code: "ask_not_found" })
  })
})

describe("ask{wait}: 解锁与超时", () => {
  it("unlocks the initiator with the decided ask after respondAsk (human target)", async () => {
    const root = makeRoot("ask-wait-root")
    const human = ensureHuman(db)

    const pending = ask(db, root.id, {
      to: "human",
      question: "继续吗",
      options: ["是", "否"],
      wait: { until: "message", timeoutMs: 3000 },
    })
    const stored = listApprovals(db, "pending")[0]
    if (stored === undefined) throw new Error("expected a pending ask")

    respondAsk(db, stored.id, human.id, { choice: "是" })

    const outcome = await pending
    expect(outcome.timedOut).toBe(false)
    expect(outcome.ask.status).toBe("answered")
    expect(outcome.ask.result).toMatchObject({ choice: "是" })
  })

  it("unlocks an agent→agent ask when the target responds", async () => {
    const a = makeRoot("ask-aa-a")
    const b = makeRoot("ask-aa-b")
    createDm(db, a.id, b.id)

    const pending = ask(db, a.id, {
      to: b.id,
      question: "走不走",
      options: ["走", "不走"],
      wait: { until: "message", timeoutMs: 3000 },
    })
    const stored = listApprovals(db, "pending")[0]
    if (stored === undefined) throw new Error("expected a pending ask")

    const answered = respondAsk(db, stored.id, b.id, { choice: "走" })
    expect(answered.result).toMatchObject({ choice: "走", responder: b.id })

    const outcome = await pending
    expect(outcome.timedOut).toBe(false)
    expect(outcome.ask.status).toBe("answered")
  })

  it("times out to pending + timedOut when the ask goes unanswered", async () => {
    const root = makeRoot("ask-timeout-root")
    ensureHuman(db)

    const outcome = await ask(db, root.id, {
      to: "human",
      question: "有人吗",
      options: ["在"],
      wait: { until: "message", timeoutMs: 80 },
    })

    expect(outcome.timedOut).toBe(true)
    expect(outcome.ask.status).toBe("pending")
  })
})

describe("sweepExpired 覆盖 ask（R2）", () => {
  it("expires a pending ask after 24h and sends a 批示过期 receipt to the initiator", () => {
    const root = makeRoot("ask-exp-root")
    const human = ensureHuman(db)
    const { ask: stored } = ask(db, root.id, {
      to: "human",
      question: "还在吗",
      options: ["在", "不在"],
    })

    expect(sweepExpired(db, Date.now() + APPROVAL_TTL_MS - 60_000)).toBe(0)
    expect(getApproval(db, stored.id)?.status).toBe("pending")

    expect(sweepExpired(db, Date.now() + APPROVAL_TTL_MS + 1)).toBe(1)
    expect(getApproval(db, stored.id)?.status).toBe("expired")

    const dm = getConversationByKey(db, dmKey(root.id, human.id))
    const receipts = messagesWithAsk(dm?.id ?? "", stored.id).filter(
      (m) => m.fromAgentId === human.id,
    )
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.kind).toBe("system")
    expect(receipts[0]?.body).toContain("批示已过期")
    expect(receipts[0]?.meta).toMatchObject({
      askId: stored.id,
      result: { expiredAt: expect.any(Number) },
    })
  })
})

describe("R1: 契约容纳 ask", () => {
  it("admits 'ask' in the approval snapshot and MCP approval outputs, rejecting unknown actions", () => {
    const snapshot = {
      id: "a",
      requesterAgentId: "r",
      action: "ask",
      payload: {},
      status: "pending",
      createdAt: 0,
      decidedAt: null,
    }
    expect(approvalSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(approvalSnapshotSchema.safeParse({ ...snapshot, action: "nope" }).success).toBe(false)

    const approval = { id: "a", requesterAgentId: "r", action: "ask", payload: {}, status: "pending", createdAt: 0 }
    expect(MCP_TOOL_OUTPUTS.shout.safeParse({ approval }).success).toBe(true)
    expect(MCP_TOOL_OUTPUTS.group.safeParse({ approval }).success).toBe(true)
  })

  it("emits an ask approval event whose payload passes the snapshot schema", () => {
    resetWsHub()
    const root = makeRoot("ask-emit-root")
    ensureHuman(db)

    ask(db, root.id, { to: "human", question: "q", options: ["a"] })

    const payload = lastApprovalPayload()
    const parsed = wsApprovalPayloadSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.approval.action).toBe("ask")
      expect(parsed.data.approval.status).toBe("pending")
    }
  })
})

describe("ask{wait}: 群会话第三方消息不提前解锁、不忙旋（review #2）", () => {
  it("ignores third-party group messages and still unlocks on the target's answer", async () => {
    const a = makeRoot("ask-spin-a")
    const b = makeRoot("ask-spin-b")
    const c = makeRoot("ask-spin-c")
    const group = createGroup(db, { name: "批示群", createdBy: a.id, memberIds: [b.id, c.id] })
    const spy = vi.spyOn(waitModule, "waitFor")

    try {
      const pending = ask(db, a.id, {
        to: b.id,
        question: "走不走",
        options: ["走", "不走"],
        wait: { until: "message", timeoutMs: 4000 },
      })

      // 第三方成员在群内插话：publish 唤醒等待者，但 ask 仍未决 —— 不得提前解锁。
      sendMessage(db, { from: c.id, to: group.id, body: "我插一句" })

      const raced = await Promise.race([
        pending.then(() => "resolved" as const),
        delay(150).then(() => "alive" as const),
      ])
      expect(raced).toBe("alive")

      // 忙旋防护：推进基线后，第三方消息不会令 waitFor 以同一 afterSeq 反复重入。
      // （若 lastAfterSeq 未前进，此处会因紧循环而远超上限。）
      expect(spy.mock.calls.length).toBeLessThan(5)

      const stored = listApprovals(db, "pending")[0]
      if (stored === undefined) throw new Error("expected a pending ask")
      respondAsk(db, stored.id, b.id, { choice: "走" })

      const outcome = await pending
      expect(outcome.timedOut).toBe(false)
      expect(outcome.ask.status).toBe("answered")
      expect(outcome.ask.result).toMatchObject({ choice: "走", responder: b.id })
    } finally {
      spy.mockRestore()
    }
  })
})

// ── Task 4：群内 ask（spec §3.2/§3.3/§3.4）─────────────────────────

/** 建群夹具：发起方 a（owner）+ 成员 b/c（`recipientsOf` 口径下可提及 = b/c）。 */
function seedGroup(prefix: string) {
  const a = makeRoot(`${prefix}-a`)
  const b = makeRoot(`${prefix}-b`)
  const c = makeRoot(`${prefix}-c`)
  const group = createGroup(db, { name: `${prefix}-group`, createdBy: a.id, memberIds: [b.id, c.id] })
  return { a, b, c, group }
}

/** 按 `target` 定位群卡（`created_at` 同毫秒时 id 序不可依赖）。 */
function cardFor(cards: readonly Approval[], targetId: string): Approval {
  const card = cards.find((approval) => approval.target === targetId)
  if (card === undefined) throw new Error(`no ask card for target ${targetId}`)
  return card
}

function pendingAskCards(): Approval[] {
  return listApprovals(db, "pending").filter((approval) => approval.kind === "ask")
}

describe("群 ask：目标解析与错误码（Task 4，spec §3.2/§6）", () => {
  it("rejects a group ask without mentions with mentions_required (ask 与 askGroup 同码，无孤儿单)", () => {
    const { a, group } = seedGroup("g-req")

    const viaAsk = errorOf(() => ask(db, a.id, { to: group.id, question: "?", options: ["ok"] }))
    expect(viaAsk).toBeInstanceOf(MentionsRequiredError)
    expect(viaAsk).toMatchObject({ code: "mentions_required" })

    const viaGroup = errorOf(() => askGroup(db, a.id, { to: group.id, question: "?", options: ["ok"] }))
    expect(viaGroup).toBeInstanceOf(MentionsRequiredError)
    expect(viaGroup).toMatchObject({ code: "mentions_required" })
    expect(listApprovals(db)).toHaveLength(0)
  })

  it("reports mention_not_found with the unmatched list and creates no card", () => {
    const { a, group } = seedGroup("g-nf")

    const error = errorOf(() =>
      askGroup(db, a.id, {
        to: group.id,
        question: "?",
        options: ["ok"],
        mentions: ["不存在的人"],
      }),
    )

    expect(error).toBeInstanceOf(MentionNotFoundError)
    expect(error).toMatchObject({ code: "mention_not_found", unmatched: ["不存在的人"] })
    expect(error.message).toContain("不存在的人")
    expect(listApprovals(db)).toHaveLength(0)
  })

  it("reports mention_not_participant when the mentioned node is real but outside the group", () => {
    const { a, group } = seedGroup("g-np")
    const outsider = makeRoot("g-np-outsider")

    const error = errorOf(() =>
      askGroup(db, a.id, {
        to: group.id,
        question: "?",
        options: ["ok"],
        mentions: [outsider.name],
      }),
    )

    expect(error).toBeInstanceOf(MentionNotParticipantError)
    expect(error).toMatchObject({ code: "mention_not_participant", outsiders: [outsider.name] })
    expect(listApprovals(db)).toHaveLength(0)
  })

  // F1（PAIR 评审）：成员表即授权边界 —— 非成员不得向他人群写卡/广播 approval。
  it("rejects a non-member agent's group ask with not_participant before any card (0 orphan)", () => {
    const { b, group } = seedGroup("g-gate")
    const outsider = makeRoot("g-gate-outsider")
    expect(isParticipant(db, group.id, outsider.id)).toBe(false)

    const error = errorOf(() =>
      askGroup(db, outsider.id, {
        to: group.id,
        question: "?",
        options: ["ok"],
        mentions: [b.name],
      }),
    )

    expect(error).toBeInstanceOf(NotParticipantError)
    expect(error).toMatchObject({ code: "not_participant" })
    expect(listApprovals(db)).toHaveLength(0)
  })

  it("keeps the human super-observer exemption: a human outside the membership may group-ask", () => {
    const { b, group } = seedGroup("g-human-gate")
    const human = ensureHuman(db)
    expect(isParticipant(db, group.id, human.id)).toBe(false)

    const result = askGroup(db, human.id, {
      to: group.id,
      question: "人类发起？",
      options: ["ok"],
      mentions: [b.name],
    })

    expect(result.asks).toHaveLength(1)
    expect(result.asks[0]).toMatchObject({ target: b.id, status: "pending" })
  })

  it("creates one card per mentioned member in that group (no wait → asks, no reply)", () => {
    const { a, b, c, group } = seedGroup("g-cards")

    const result = askGroup(db, a.id, {
      to: group.id,
      question: "走哪个方案？",
      options: ["x", "y"],
      mentions: [b.name, c.name],
    })

    expect(result.asks).toHaveLength(2)
    expect(result.asks.map((card) => card.target)).toEqual([b.id, c.id])
    expect(result).not.toHaveProperty("reply")
    for (const card of result.asks) {
      expect(card).toMatchObject({ kind: "ask", status: "pending" })
      expect(card.payload).toMatchObject({ conversationId: group.id })
      expect(messagesWithAsk(group.id, card.id)).toHaveLength(1)
    }
  })
})

describe("群 ask：三形态等待（Task 4，spec §3.4）", () => {
  it("scope=all blocks until both cards are answered, then returns timedOut:false", async () => {
    const { a, b, c, group } = seedGroup("g-all")
    const pending = askGroup(db, a.id, {
      to: group.id,
      question: "走哪条线？",
      options: ["x", "y"],
      mentions: [b.name, c.name],
      wait: { until: "message", timeoutMs: 4000, scope: "all" },
    })
    const cards = pendingAskCards()
    expect(cards).toHaveLength(2)

    respondAsk(db, cardFor(cards, b.id).id, b.id, { choice: "x" })
    // 仅一人回：scope=all 不得提前解锁。
    const raced = await Promise.race([
      pending.then(() => "resolved" as const),
      delay(120).then(() => "alive" as const),
    ])
    expect(raced).toBe("alive")

    respondAsk(db, cardFor(cards, c.id).id, c.id, { choice: "y" })
    const outcome = await pending
    expect(outcome.reply.timedOut).toBe(false)
    expect(outcome.reply.replies).toEqual([
      { target: b.id, choice: "x" },
      { target: c.id, choice: "y" },
    ])
    expect(outcome.reply.pending).toEqual([])
    expect(outcome.asks).toHaveLength(2)
  })

  it("scope=all times out with the answered subset and the pending target id", async () => {
    const { a, b, c, group } = seedGroup("g-to")
    const pending = askGroup(db, a.id, {
      to: group.id,
      question: "有人接吗？",
      options: ["x", "y"],
      mentions: [b.name, c.name],
      wait: { until: "message", timeoutMs: 400, scope: "all" },
    })
    const cards = pendingAskCards()
    expect(cards).toHaveLength(2)
    respondAsk(db, cardFor(cards, b.id).id, b.id, { choice: "x" })

    const outcome = await pending
    expect(outcome.reply.timedOut).toBe(true)
    expect(outcome.reply.replies).toEqual([{ target: b.id, choice: "x" }])
    expect(outcome.reply.pending).toEqual([c.id])
  })

  it("scope=any returns as soon as the first member answers", async () => {
    const { a, b, c, group } = seedGroup("g-any")
    const pending = askGroup(db, a.id, {
      to: group.id,
      question: "谁接这活？",
      options: ["x", "y"],
      mentions: [b.name, c.name],
      wait: { until: "message", timeoutMs: 4000, scope: "any" },
    })
    const cards = pendingAskCards()
    expect(cards).toHaveLength(2)
    respondAsk(db, cardFor(cards, c.id).id, c.id, { choice: "y" })

    const outcome = await pending
    expect(outcome.reply.timedOut).toBe(false)
    expect(outcome.reply.replies).toEqual([{ target: c.id, choice: "y" }])
    expect(outcome.reply.pending).toEqual([b.id])
  })

  it("defaults scope to all when wait omits it (partial answer still times out)", async () => {
    const { a, b, c, group } = seedGroup("g-def")
    const pending = askGroup(db, a.id, {
      to: group.id,
      question: "缺省 scope？",
      options: ["x", "y"],
      mentions: [b.name, c.name],
      wait: { until: "message", timeoutMs: 300 },
    })
    const cards = pendingAskCards()
    respondAsk(db, cardFor(cards, b.id).id, b.id, { choice: "x" })

    const outcome = await pending
    expect(outcome.reply.timedOut).toBe(true)
    expect(outcome.reply.pending).toEqual([c.id])
  })
})
