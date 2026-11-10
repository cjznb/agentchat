/**
 * P6 消息紧急度（urgency）集成测试 —— Hub 侧契约：
 * ① 三档落 `messages.meta.urgency`：`low`/`urgent` 写、`normal`/缺省**不写**（golden 逐字节不变）；
 * ② 与既有 meta 字段**浅合并**（群 `mentions`/`mentionScope`、ask 卡 `askId` 等不被破坏）；
 * ③ `ask` 的 urgency **只落卡消息 meta**（不影响答复链路）；
 * ④ `shout` 的 urgency 进审批 payload：批准后仍按原档投递；**历史单（payload 无 urgency）→ normal 且不崩**；
 * ⑤ `POST /internal/wake` 出参每条消息 additive 带 `urgency`（既有字段形状不变）。
 * 读口径单源 = `urgencyOf(meta)`（非法/缺失 → normal）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MCP_TOOL_INPUTS,
  messageUrgencySchema,
  urgencyOf,
  type MessageUrgency,
} from "../../shared/contracts"
import { ask } from "../../server/core/ask"
import { createGroup, sendMessage, shout } from "../../server/core/messaging"
import { ensureHuman } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { insertAgent, insertAgentKey, type Agent } from "../../server/store/agents"
import { insertApproval } from "../../server/store/approvals"
import { getConversationByKey, SHOUT_KEY } from "../../server/store/conversations"
import { getById, history as storeHistory } from "../../server/store/messages"

let home = ""
let db: Db
let token = ""
let app: ReturnType<typeof createApp>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-urgency-"))
  db = openDb(join(home, "agentchat.db"))
  token = ensureHubToken(join(home, "hub_token"))
  app = createApp(db, { home, hubTokenPath: join(home, "hub_token"), isLoopback: () => true })
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

/** 落库后的 `meta`（读真库，不信任返回值）。 */
function metaOf(messageId: string): Record<string, unknown> | undefined {
  return getById(db, messageId)?.meta
}

/** 走 HTTP 批准一张审批单（`executeApproved` 只在路由层，故必须过 UI 路由）。 */
async function approve(approvalId: string): Promise<number> {
  const response = await app.request(`/api/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  })
  await response.text()
  return response.status
}

async function wake(agentId: string): Promise<{
  readonly messages: readonly { id: string; body: string; urgency: string; meta?: Record<string, unknown> }[]
}> {
  const response = await app.request("/internal/wake", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { messages: readonly { id: string; body: string; urgency: string }[] }
}

describe("P6 三档落库与读口径单源", () => {
  it("writes meta.urgency only for low/urgent and normalises unknown values to normal", () => {
    const sender = makeAgent("p6-levels-sender")
    const peer = makeAgent("p6-levels-peer")
    const levels: ReadonlyArray<readonly [MessageUrgency | undefined, MessageUrgency]> = [
      ["urgent", "urgent"],
      ["low", "low"],
      ["normal", "normal"],
      [undefined, "normal"],
    ]
    const stored = levels.map(([urgency, expected]) => {
      const sent = sendMessage(db, {
        from: sender.id,
        to: peer.id,
        body: `body-${expected}-${String(urgency)}`,
        ...(urgency === undefined ? {} : { urgency }),
      })
      return { messageId: sent.message.id, urgency, expected }
    })
    for (const entry of stored) {
      const meta = metaOf(entry.messageId)
      if (entry.expected === "normal") {
        // normal / 缺省：**不写** meta（未带 urgency 的消息与既有 golden 逐字节一致）。
        expect({ body: entry.urgency, meta }).toEqual({ body: entry.urgency, meta: undefined })
      } else {
        expect(meta?.["urgency"]).toBe(entry.expected)
      }
      expect(urgencyOf(meta)).toBe(entry.expected)
    }
    // 读口径单源：非法/缺失/错误类型一律回落 normal（适配器与 message_status 共用）。
    expect(urgencyOf(undefined)).toBe("normal")
    expect(urgencyOf({})).toBe("normal")
    expect(urgencyOf({ urgency: "bogus" })).toBe("normal")
    expect(urgencyOf({ urgency: 7 })).toBe("normal")
    expect(messageUrgencySchema.safeParse("bogus").success).toBe(false)
    expect(MCP_TOOL_INPUTS.send.safeParse({ to: peer.id, body: "x", urgency: "bogus" }).success).toBe(false)
  })
})

describe("P6 与既有 meta 的浅合并", () => {
  it("keeps mentions/mentionScope intact on a group message that is also urgent", () => {
    const human = ensureHuman(db)
    const a = makeAgent("p6-merge-a")
    const b = makeAgent("p6-merge-b")
    const group = createGroup(db, { name: "p6-merge-group", createdBy: human.id, memberIds: [a.id, b.id] })
    if (!("approved" in group)) throw new Error("human group creation must execute immediately")

    const sent = sendMessage(db, {
      from: human.id,
      to: group.approved.id,
      body: `@${b.name} 请立刻处理`,
      mentions: [b.name],
      urgency: "urgent",
    })
    const meta = metaOf(sent.message.id)
    expect(meta?.["urgency"]).toBe("urgent")
    expect(meta?.["mentions"]).toEqual([b.id])
    expect(meta?.["mentionScope"]).toBeDefined()
  })

  it("keeps the ask card fields while adding urgency (urgency only affects card delivery)", () => {
    const asker = makeAgent("p6-ask-asker")
    const answerer = makeAgent("p6-ask-answerer")
    sendMessage(db, { from: answerer.id, to: asker.id, body: "seed-dm" }) // 建 DM，令 ask 有可沟通会话
    const asked = ask(db, asker.id, {
      to: answerer.id,
      question: "选 A 还是 B？",
      options: ["A", "B"],
      urgency: "urgent",
    })
    const conversationId = asked.ask.payload["conversationId"]
    expect(typeof conversationId).toBe("string")
    const card = storeHistory(db, { conversationId: conversationId as string }).find(
      (message) => message.meta?.["askId"] === asked.ask.id,
    )
    expect(card?.meta?.["urgency"]).toBe("urgent")
    // 既有 ask 卡 meta 一字不动。
    expect(card?.meta?.["kind"]).toBe("ask")
    expect(card?.meta?.["question"]).toBe("选 A 还是 B？")
    expect(card?.meta?.["options"]).toEqual(["A", "B"])
    expect(card?.meta?.["allowCustom"]).toBe(true)
  })
})

describe("P6 shout 的审批透传", () => {
  it("carries urgency through the approval payload and keeps it after approval", async () => {
    const human = ensureHuman(db)
    const direct = shout(db, human.id, "human 直通广播", undefined, "urgent")
    if (!("approved" in direct)) throw new Error("human shout must pass the gate")
    expect(metaOf(direct.approved.message.id)?.["urgency"]).toBe("urgent")

    // root（有 join key）→ 落审批单；payload 必须带 urgency，否则批准后降级。
    const root = makeAgent("p6-shout-root")
    insertAgentKey(db, "hash-p6-shout-root", root.id)
    const gated = shout(db, root.id, "root 紧急广播", undefined, "urgent")
    if (!("approval" in gated)) throw new Error("root shout must be gated")
    expect(gated.approval.payload["urgency"]).toBe("urgent")

    expect(await approve(gated.approval.id)).toBe(200)
    const shoutConversation = getConversationByKey(db, SHOUT_KEY)
    if (shoutConversation === undefined) throw new Error("shout conversation must exist after delivery")
    const broadcast = storeHistory(db, { conversationId: shoutConversation.id }).find(
      (message) => message.body === "root 紧急广播",
    )
    expect(broadcast?.meta?.["urgency"]).toBe("urgent")

    // 普通 shout（无 urgency）批准后仍是 normal：不写 meta。
    const plain = shout(db, root.id, "root 普通广播", undefined, "normal")
    if (!("approval" in plain)) throw new Error("root shout must be gated")
    expect(plain.approval.payload["urgency"]).toBeUndefined()
    expect(await approve(plain.approval.id)).toBe(200)
    const plainBroadcast = storeHistory(db, { conversationId: shoutConversation.id }).find(
      (message) => message.body === "root 普通广播",
    )
    expect(urgencyOf(plainBroadcast?.meta)).toBe("normal")
    expect(plainBroadcast?.meta?.["urgency"]).toBeUndefined()
  })

  it("approves a legacy approval whose payload has no urgency without crashing (defaults to normal)", async () => {
    const root = makeAgent("p6-legacy-root")
    insertAgentKey(db, "hash-p6-legacy-root", root.id)
    const legacy = insertApproval(db, {
      requesterAgentId: root.id,
      action: "shout",
      payload: { body: "legacy 广播" }, // 升级前落库的单：没有 urgency 字段
      now: Date.now(),
    })
    expect(await approve(legacy.id)).toBe(200)
    const shoutConversation = getConversationByKey(db, SHOUT_KEY)
    if (shoutConversation === undefined) throw new Error("shout conversation must exist after delivery")
    const broadcast = storeHistory(db, { conversationId: shoutConversation.id }).find(
      (message) => message.body === "legacy 广播",
    )
    expect(broadcast).toBeDefined()
    expect(urgencyOf(broadcast?.meta)).toBe("normal")
  })
})

describe("P6 /internal/wake 的 additive urgency", () => {
  it("exposes urgency per claimed message while keeping the existing message shape", async () => {
    const sender = makeAgent("p6-wake-sender")
    const target = makeAgent("p6-wake-target")
    sendMessage(db, { from: sender.id, to: target.id, body: "low-body", urgency: "low" })
    sendMessage(db, { from: sender.id, to: target.id, body: "normal-body" })
    sendMessage(db, { from: sender.id, to: target.id, body: "urgent-body", urgency: "urgent" })

    const claimed = await wake(target.id)
    const byBody = new Map(claimed.messages.map((message) => [message.body, message]))
    expect(byBody.get("low-body")?.urgency).toBe("low")
    expect(byBody.get("normal-body")?.urgency).toBe("normal")
    expect(byBody.get("urgent-body")?.urgency).toBe("urgent")
    // 既有字段形状不变（老适配器忽略 urgency 即可）。
    expect(typeof byBody.get("urgent-body")?.id).toBe("string")
    expect(byBody.get("urgent-body")?.meta?.["urgency"]).toBe("urgent")
  })
})
