/**
 * Plan 3 终审 F5 —— ask 答复一致性（`server/core/respond.ts`）：
 * ① 无效 `conversationId`（缺失 / 空串 / 指向不存在会话）→ 回退 `cardConversation`；
 * ② 答复消息写入失败 → 与状态迁移同事务回滚，**不留 answered**。
 *
 * `send` 经 `vi.mock` 包装为可注入失败；其余导出透传真实实现（不影响既有断言）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../../server/config"
import { registerRoot } from "../../server/core/agents"
import { ask, cardConversation } from "../../server/core/ask"
import { ensureHuman, sendMessage } from "../../server/core/messaging"
import { respondAsk } from "../../server/core/respond"
import { openDb, type Db } from "../../server/db"
import { getApproval } from "../../server/store/approvals"
import { history } from "../../server/store/messages"

const sendControl = vi.hoisted(() => ({ fail: false }))

vi.mock("../../server/store/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/store/messages")>()
  return {
    ...actual,
    send: (...args: Parameters<typeof actual.send>) => {
      if (sendControl.fail) throw new Error("boom: simulated send failure")
      return actual.send(...args)
    },
  }
})

let home = ""
let db: Db
let humanId = ""
let rootId = ""

beforeEach(() => {
  sendControl.fail = false
  home = mkdtempSync(join(tmpdir(), "agentchat-respond-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "respond-root", vendor: "opencode" }).agent
  sendMessage(db, { from: human.id, to: root.id, body: "hello" })
  humanId = human.id
  rootId = root.id
})

afterEach(() => {
  sendControl.fail = false
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function newAsk(): { readonly id: string } {
  return ask(db, rootId, { to: "human", question: "选哪个", options: ["a", "b"] }).ask
}

function tamperConversation(askId: string, conversationId: unknown): void {
  const stored = getApproval(db, askId)
  if (stored === undefined) throw new Error("ask missing")
  const payload = { ...stored.payload, conversationId }
  db.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run(JSON.stringify(payload), askId)
}

describe("respondAsk：无效 conversationId 回退（F5①）", () => {
  it("空串 conversationId → 回退到卡会话，答复消息落卡会话", () => {
    const stored = newAsk()
    tamperConversation(stored.id, "")
    const expected = cardConversation(db, getApproval(db, stored.id)!).id

    const answered = respondAsk(db, stored.id, humanId, { choice: "a" })
    expect(answered.status).toBe("answered")

    const answers = history(db, { conversationId: expected }).filter(
      (message) => message.meta?.["askId"] === stored.id && message.meta?.["result"] !== undefined,
    )
    expect(answers).toHaveLength(1)
    expect(answers[0]?.body).toContain("a")
  })

  it("指向不存在会话的 conversationId → 同样回退到卡会话", () => {
    const stored = newAsk()
    tamperConversation(stored.id, "does-not-exist-conversation")
    const expected = cardConversation(db, getApproval(db, stored.id)!).id

    expect(respondAsk(db, stored.id, humanId, { text: "自由答复" }).status).toBe("answered")
    const answers = history(db, { conversationId: expected }).filter(
      (message) => message.meta?.["askId"] === stored.id && message.meta?.["result"] !== undefined,
    )
    expect(answers).toHaveLength(1)
    expect(answers[0]?.body).toContain("自由答复")
  })

  it("合法持久化 conversationId 仍优先（不回归）", () => {
    const stored = newAsk()
    const expected = cardConversation(db, getApproval(db, stored.id)!).id
    expect(respondAsk(db, stored.id, humanId, { choice: "b" }).status).toBe("answered")
    const answers = history(db, { conversationId: expected }).filter(
      (message) => message.meta?.["askId"] === stored.id && message.meta?.["result"] !== undefined,
    )
    expect(answers).toHaveLength(1)
  })
})

describe("respondAsk：写消息失败不留 answered（F5②）", () => {
  it("答复消息写入抛错 → 事务回滚，状态保持 pending", () => {
    const stored = newAsk()
    sendControl.fail = true
    expect(() => respondAsk(db, stored.id, humanId, { choice: "a" })).toThrow(/simulated send failure/)
    sendControl.fail = false

    expect(getApproval(db, stored.id)?.status).toBe("pending")

    // 回滚后可正常答复（无中间态残留）。
    expect(respondAsk(db, stored.id, humanId, { choice: "a" }).status).toBe("answered")
    expect(getApproval(db, stored.id)?.status).toBe("answered")
  })
})
