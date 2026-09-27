/**
 * Task 7 —— 权限审批闸门集成测试（brief DoD）：
 * - 根 agent `shout` → 不发消息、产生 `pending` 审批单 + 用户会话收到 system 审批卡
 *   （`meta={approvalId, action, payload}`）；建群/拉人入口同样被闸（单点执法）
 * - `approve` → 喊话实际发出 + 发起方收到 approved 回执（`inbox` `wait` 中的调用被解锁）
 * - `reject` → rejected 回执、无消息发出
 * - 子 agent / 逻辑节点 → 直接抛 `Forbidden`（无审批单）；人 → 即时执行零审批
 * - `pending` 满 24h → `expired`（dispatcher 注入时钟清扫，不 `sleep(24h)`）
 * - `decide` 幂等：已决单再决 → `approval_already_decided`（路由 409），第一次落库为准
 * - `GET /api/approvals` 待处理列表、`POST /api/approvals/:id {decision}`（400/404/409）
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { registerChild, registerLogical, registerRoot } from "../../server/core/agents"
import { Dispatcher } from "../../server/core/dispatcher"
import {
  addParticipant,
  createGroup,
  ensureHuman,
  inbox,
  shout,
} from "../../server/core/messaging"
import {
  APPROVAL_TTL_MS,
  ApprovalAlreadyDecidedError,
  decide,
  Forbidden,
  sweepExpired,
} from "../../server/core/permissions"
import { createApp } from "../../server/index"
import { getApproval, listApprovals, type Approval } from "../../server/store/approvals"
import { insertAgent, type Agent } from "../../server/store/agents"
import {
  getConversationByKey,
  isParticipant,
  listConversations,
} from "../../server/store/conversations"
import { history as storeHistory } from "../../server/store/messages"

let home = ""
let db: Db

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-approvals-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 注册根（spec §9 身份 = agent_keys，生产形态）。 */
function makeRoot(name: string): Agent {
  return registerRoot(db, home, { name, vendor: "opencode" }).agent
}

/** 从闸门兼容返回（`Gated<T>` / `ApprovalRequested | void`）中取出 pending 审批单。 */
function approvalOf(result: { readonly approval?: Approval } | void): Approval {
  if (result === undefined || result.approval === undefined) {
    throw new Error("expected a pending approval")
  }
  return result.approval
}

async function post(path: string, body: unknown): Promise<Response> {
  return createApp(db).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("gate: 根 agent 发起受限操作 → pending 审批单 + 审批卡", () => {
  it("holds a root shout: no message sent, pending row, system card in the human conversation", () => {
    const root = makeRoot("gate-root")
    const human = ensureHuman(db)

    const outcome = shout(db, root.id, "全员注意")

    const approval = approvalOf(outcome)
    expect(approval).toMatchObject({
      requesterAgentId: root.id,
      action: "shout",
      status: "pending",
      payload: { body: "全员注意" },
    })
    expect(approval.decidedAt).toBeUndefined()
    // 不发消息：广播会话尚未创建
    expect(getConversationByKey(db, "shout")).toBeUndefined()
    // 审批卡 = system 消息，meta={approvalId, action, payload}，落发起方↔用户 DM
    const cards = inbox(db, human.id).filter((m) => m.kind === "system")
    expect(cards).toHaveLength(1)
    expect(cards[0]?.meta).toMatchObject({
      approvalId: approval.id,
      action: "shout",
      payload: { body: "全员注意" },
    })
    // 未处理列表可见
    expect(listApprovals(db, "pending").map((a) => a.id)).toEqual([approval.id])
  })

  it("gates group create/add for a registered root the same way", () => {
    const root = makeRoot("gate-grp-root")
    const peer = makeRoot("gate-grp-peer")
    const human = ensureHuman(db)

    const created = createGroup(db, { name: "根的群", createdBy: root.id, memberIds: [peer.id] })
    expect(approvalOf(created)).toMatchObject({ action: "group_create", status: "pending" })
    expect(listConversations(db).filter((c) => c.kind === "group")).toHaveLength(0)

    const group = createGroup(db, { name: "人的基群", createdBy: human.id })
    const added = addParticipant(db, {
      conversationId: group.id,
      agentId: peer.id,
      invitedBy: root.id,
    })
    expect(approvalOf(added)).toMatchObject({ action: "group_add", status: "pending" })
    expect(isParticipant(db, group.id, peer.id)).toBe(false)
    expect(listApprovals(db, "pending")).toHaveLength(2)
  })
})

describe("approve: 执行 + 发起方 wait 解锁", () => {
  it("executes the shout on approve and unlocks the initiator's inbox wait with the approved receipt", async () => {
    const root = makeRoot("gate-appr-root")
    ensureHuman(db)
    const approval = approvalOf(shout(db, root.id, "开工了"))

    // 发起方挂起等批（审批确认走 Task 5 消息通道，非新机制）
    const waiting = inbox(db, root.id, { wait: { until: "message", timeoutMs: 3000 } })

    const res = await post(`/api/approvals/${approval.id}`, { decision: "approve" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, approval: { status: "approved" } })

    // 喊话实际发出
    const conversation = getConversationByKey(db, "shout")
    expect(conversation).toBeDefined()
    const sent = storeHistory(db, { conversationId: conversation?.id ?? "" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ fromAgentId: root.id, body: "开工了", kind: "text" })

    // wait 中的调用被解锁，收到 approved 回执
    const reply = await waiting
    expect(reply.timedOut).toBe(false)
    const receipts = reply.messages.filter((m) => m.meta?.["approvalId"] === approval.id)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.kind).toBe("system")
    expect(receipts[0]?.meta).toMatchObject({
      approvalId: approval.id,
      action: "shout",
      result: "approved",
    })
    expect(getApproval(db, approval.id)?.status).toBe("approved")
  })
})

describe("reject: 回执且不执行", () => {
  it("sends the rejected receipt to the initiator and sends no shout", async () => {
    const root = makeRoot("gate-rej-root")
    ensureHuman(db)
    const approval = approvalOf(shout(db, root.id, "别喊"))

    const waiting = inbox(db, root.id, { wait: { until: "message", timeoutMs: 3000 } })

    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, approval: { status: "rejected" } })

    const reply = await waiting
    expect(reply.timedOut).toBe(false)
    expect(
      reply.messages.some(
        (m) => m.meta?.["approvalId"] === approval.id && m.meta?.["result"] === "rejected",
      ),
    ).toBe(true)
    // 无消息发出
    expect(getConversationByKey(db, "shout")).toBeUndefined()
    expect(getApproval(db, approval.id)?.status).toBe("rejected")
  })
})

describe("权限矩阵（spec §8）", () => {
  it("throws Forbidden for child agents and logical nodes without creating any approval", () => {
    const root = makeRoot("gate-mx-root")
    const child = registerChild(db, {
      taskRef: "task-gate-mx-child",
      parentId: root.id,
      name: "gate-mx-child",
    })
    const board = registerLogical(db, { name: "gate-mx-board", parentId: root.id })
    const human = ensureHuman(db)
    const group = createGroup(db, { name: "基群", createdBy: human.id })

    expect(() => shout(db, child.id, "我也要喊")).toThrow(Forbidden)
    expect(() => createGroup(db, { name: "子的群", createdBy: child.id })).toThrow(Forbidden)
    expect(() =>
      addParticipant(db, { conversationId: group.id, agentId: root.id, invitedBy: child.id }),
    ).toThrow(Forbidden)
    expect(() => shout(db, board.id, "逻辑喊话")).toThrow(Forbidden)
    expect(listApprovals(db)).toHaveLength(0)
  })

  it("executes human requests immediately with zero approvals", () => {
    const human = ensureHuman(db)
    const peer = makeRoot("gate-hu-peer")
    const second = makeRoot("gate-hu-second")

    const shoutResult = shout(db, human.id, "我直接喊")
    expect(shoutResult.message.body).toBe("我直接喊")

    const group = createGroup(db, { name: "人的群", createdBy: human.id, memberIds: [peer.id] })
    expect(isParticipant(db, group.id, peer.id)).toBe(true)
    addParticipant(db, { conversationId: group.id, agentId: second.id, invitedBy: human.id })
    expect(isParticipant(db, group.id, second.id)).toBe(true)

    expect(listApprovals(db)).toHaveLength(0)
  })

  it("executes a store-level runtime root without hub identity immediately (spec §9 identity = agent_keys; production roots register via registerRoot)", () => {
    const bare = insertAgent(db, {
      name: "gate-bare-root",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
    })

    const result = shout(db, bare.id, "裸根直发")

    expect(result.message.body).toBe("裸根直发")
    expect(listApprovals(db)).toHaveLength(0)
  })
})

describe("24h 过期（注入时钟）", () => {
  it("expires a pending approval through the dispatcher sweep and sends the rejection-semantics receipt", async () => {
    const root = makeRoot("gate-exp-root")
    ensureHuman(db)
    const approval = approvalOf(shout(db, root.id, "明天再说"))

    // 未满 24h：清扫不动它
    expect(sweepExpired(db, Date.now() + APPROVAL_TTL_MS - 60_000)).toBe(0)
    expect(getApproval(db, approval.id)?.status).toBe("pending")

    // 满 24h：dispatcher 每轮顺带调用（注入 now，不 sleep）
    await new Dispatcher({ db, home }).tick(Date.now() + APPROVAL_TTL_MS + 1)

    expect(getApproval(db, approval.id)?.status).toBe("expired")
    const receipts = inbox(db, root.id).filter(
      (m) => m.meta?.["approvalId"] === approval.id && m.meta?.["result"] === "expired",
    )
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.kind).toBe("system")
    // 过期 = 拒绝语义：无消息发出
    expect(getConversationByKey(db, "shout")).toBeUndefined()
  })
})

describe("decide 幂等", () => {
  it("keeps the first decision and reports approval_already_decided on a second one", async () => {
    const root = makeRoot("gate-idem-root")
    ensureHuman(db)
    const approval = approvalOf(shout(db, root.id, "只批一次"))

    expect(decide(db, approval.id, "approve", Date.now()).status).toBe("approved")
    try {
      decide(db, approval.id, "reject", Date.now())
      throw new Error("decide should have thrown on an already-decided approval")
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalAlreadyDecidedError)
      if (error instanceof ApprovalAlreadyDecidedError) {
        expect(error.code).toBe("approval_already_decided")
      }
    }
    // 条件 UPDATE：并发双决以第一次落库为准
    expect(getApproval(db, approval.id)?.status).toBe("approved")

    // 路由层同样映射 409
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: "approval_already_decided" })
  })
})

describe("GET/POST /api/approvals", () => {
  it("lists pending approvals and empties the list after a decision", async () => {
    const root = makeRoot("gate-ui-root")
    ensureHuman(db)
    const approval = approvalOf(shout(db, root.id, "走流程"))

    const before = await createApp(db).request("/api/approvals")
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual([
      expect.objectContaining({
        id: approval.id,
        requesterAgentId: root.id,
        action: "shout",
        status: "pending",
        payload: { body: "走流程" },
      }),
    ])

    const decision = await post(`/api/approvals/${approval.id}`, { decision: "approve" })
    expect(decision.status).toBe(200)

    const after = await createApp(db).request("/api/approvals")
    expect(await after.json()).toEqual([])
  })

  it("maps a malformed decision body to 400 and an unknown approval id to 404", async () => {
    const bad = await post("/api/approvals/any-id", { decision: "maybe" })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: "invalid_body" })

    const missing = await post("/api/approvals/no-such-id", { decision: "approve" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ ok: false, error: "approval_not_found" })
  })
})
