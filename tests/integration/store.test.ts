/**
 * Task 2 —— 数据层集成测试（spec §5.3 八表、PRAGMA、全局 seq、幂等 send、
 * read_states upsert、DM key 成员排序）。每个用例用独立临时 $AGENTCHAT_HOME。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import {
  getAgentByName,
  getAgentByTaskRef,
  insertAgent,
  type Agent,
} from "../../server/store/agents"
import {
  addParticipant,
  createDm,
  createGroup,
  dmKey,
  getConversationByKey,
  getReadState,
  isParticipant,
  listConversations,
  listParticipants,
  markRead,
} from "../../server/store/conversations"
import { getById, history, messagesAfter, send } from "../../server/store/messages"

let home = ""
let dbPath = ""
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-store-"))
  dbPath = loadConfig({ AGENTCHAT_HOME: home }).dbPath
  db = openDb(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

describe("openDb", () => {
  it("opens $AGENTCHAT_HOME/agentchat.db with journal_mode=WAL and foreign_keys=ON", () => {
    expect(dbPath).toBe(join(home, "agentchat.db"))
    expect(existsSync(dbPath)).toBe(true)
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal")
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1)
  })

  it("creates exactly the eight spec §5.3 tables", () => {
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    expect(rows.map((r) => r.name)).toEqual([
      "agent_keys",
      "agents",
      "approvals",
      "conversations",
      "messages",
      "participants",
      "read_states",
      "wake_jobs",
    ])
  })

  it("rejects a message row pointing at an unknown conversation (FK enforced)", () => {
    const a = makeAgent("fk-agent")
    expect(() =>
      send(db, { conversationId: "missing-conversation", fromAgentId: a.id, body: "x" }),
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe("agents store", () => {
  it("round-trips an agent by id, unique name and task_ref", () => {
    const created = insertAgent(db, {
      name: "root-1",
      kind: "runtime",
      status: "online",
      vendor: "opencode",
      model: "m1",
      taskRef: "task-42",
      purpose: "协调",
      skills: ["go", "sql"],
      roleTag: "organizer",
      remark: "备注",
    })
    expect(created.rootId).toBe(created.id)
    expect(getAgentByName(db, "root-1")).toEqual(created)
    expect(getAgentByTaskRef(db, "task-42")).toEqual(created)
  })

  it("rejects duplicate agent names", () => {
    makeAgent("dup")
    expect(() => makeAgent("dup")).toThrow(/UNIQUE/i)
  })
})

describe("messages.seq", () => {
  it("stays strictly increasing across conversations (global order source)", () => {
    const a = makeAgent("seq-a")
    const b = makeAgent("seq-b")
    const dm = createDm(db, a.id, b.id)
    const group = createGroup(db, { name: "g", createdBy: a.id, memberIds: [b.id] })

    const m1 = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "1" })
    const m2 = send(db, { conversationId: group.id, fromAgentId: b.id, body: "2" })
    const m3 = send(db, { conversationId: dm.id, fromAgentId: b.id, body: "3" })

    expect(m1.seq).toBeLessThan(m2.seq)
    expect(m2.seq).toBeLessThan(m3.seq)
    expect(new Set([m1.seq, m2.seq, m3.seq]).size).toBe(3)
  })
})

describe("send idempotency", () => {
  it("returns the first row when the same idempotencyKey is sent again", () => {
    const a = makeAgent("idem-a")
    const b = makeAgent("idem-b")
    const dm = createDm(db, a.id, b.id)

    const first = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "第一版", idempotencyKey: "key-1" })
    const again = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "重试改了 body", idempotencyKey: "key-1" })

    expect(again.seq).toBe(first.seq)
    expect(again.id).toBe(first.id)
    expect(again.body).toBe("第一版")
    expect(history(db, { conversationId: dm.id })).toHaveLength(1)
  })

  it("scopes idempotency keys to the sending agent", () => {
    const a = makeAgent("scope-a")
    const b = makeAgent("scope-b")
    const dm = createDm(db, a.id, b.id)

    const fromA = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "from A", idempotencyKey: "shared-key" })
    const fromB = send(db, { conversationId: dm.id, fromAgentId: b.id, body: "from B", idempotencyKey: "shared-key" })

    expect(fromB.seq).not.toBe(fromA.seq)
    expect(fromB.id).not.toBe(fromA.id)
    expect(history(db, { conversationId: dm.id })).toHaveLength(2)
  })
})

describe("message round-trip", () => {
  it("round-trips body, kind, meta JSON and short id lookup", () => {
    const a = makeAgent("rt-a")
    const b = makeAgent("rt-b")
    const dm = createDm(db, a.id, b.id)

    const written = send(db, {
      conversationId: dm.id,
      fromAgentId: a.id,
      body: "审批卡",
      kind: "system",
      meta: { approvalId: "ap-1", depth: 7 },
    })
    const read = getById(db, written.id)

    expect(read).toEqual(written)
    expect(read?.kind).toBe("system")
    expect(read?.meta).toEqual({ approvalId: "ap-1", depth: 7 })
  })
})

describe("read_states", () => {
  it("upserts the read position and only ever advances it", () => {
    const a = makeAgent("read-a")
    const b = makeAgent("read-b")
    const dm = createDm(db, a.id, b.id)
    const m1 = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "1" })
    send(db, { conversationId: dm.id, fromAgentId: a.id, body: "2" })
    const m3 = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "3" })

    markRead(db, { conversationId: dm.id, agentId: b.id, lastReadSeq: m1.seq })
    expect(getReadState(db, dm.id, b.id)?.lastReadSeq).toBe(m1.seq)

    markRead(db, { conversationId: dm.id, agentId: b.id, lastReadSeq: m3.seq })
    expect(getReadState(db, dm.id, b.id)?.lastReadSeq).toBe(m3.seq)

    markRead(db, { conversationId: dm.id, agentId: b.id, lastReadSeq: m1.seq })
    expect(getReadState(db, dm.id, b.id)?.lastReadSeq).toBe(m3.seq)
  })
})

describe("DM conversation key", () => {
  it("sorts members: dm:<idA>_<idB>", () => {
    expect(dmKey("b", "a")).toBe("dm:a_b")
    expect(dmKey("a", "b")).toBe("dm:a_b")
  })

  it("creates one DM with two participants regardless of argument order", () => {
    const a = makeAgent("dm-a")
    const b = makeAgent("dm-b")
    const [min, max] = a.id <= b.id ? [a.id, b.id] : [b.id, a.id]

    const first = createDm(db, b.id, a.id)
    expect(first.key).toBe(`dm:${min}_${max}`)
    expect(first.kind).toBe("dm")
    expect(getConversationByKey(db, `dm:${min}_${max}`)?.id).toBe(first.id)

    const second = createDm(db, a.id, b.id)
    expect(second.id).toBe(first.id)
    expect(listParticipants(db, first.id)).toHaveLength(2)
    expect(listConversations(db)).toHaveLength(1)
  })
})

describe("group conversations", () => {
  it("creates a group with an owner row and member rows", () => {
    const a = makeAgent("grp-a")
    const b = makeAgent("grp-b")
    const group = createGroup(db, { name: "团队", createdBy: a.id, memberIds: [b.id] })

    expect(group.kind).toBe("group")
    expect(group.key).toBe(`group:${group.id}`)
    expect(group.name).toBe("团队")
    const parts = listParticipants(db, group.id)
    expect(parts).toHaveLength(2)
    expect(parts.find((p) => p.agentId === a.id)?.role).toBe("owner")
    expect(parts.find((p) => p.agentId === b.id)?.role).toBe("member")
    expect(isParticipant(db, group.id, a.id)).toBe(true)
    expect(isParticipant(db, group.id, "outsider")).toBe(false)
  })

  it("rolls back every row when one member is unknown (BEGIN IMMEDIATE)", () => {
    const a = makeAgent("rb-a")
    const b = makeAgent("rb-b")
    expect(() =>
      createGroup(db, { name: "broken", createdBy: a.id, memberIds: [b.id, "ghost-agent"] }),
    ).toThrow(/FOREIGN KEY/i)
    expect(listConversations(db)).toHaveLength(0)
  })

  it("adds a participant to an existing group", () => {
    const a = makeAgent("add-a")
    const c = makeAgent("add-c")
    const group = createGroup(db, { name: "g2", createdBy: a.id })

    addParticipant(db, { conversationId: group.id, agentId: c.id, invitedBy: a.id })

    expect(listParticipants(db, group.id)).toHaveLength(2)
    expect(isParticipant(db, group.id, c.id)).toBe(true)
  })
})

describe("history paging", () => {
  it("returns the latest page, pages backwards with before, and reads after a cursor", () => {
    const a = makeAgent("hist-a")
    const b = makeAgent("hist-b")
    const dm = createDm(db, a.id, b.id)
    send(db, { conversationId: dm.id, fromAgentId: a.id, body: "1" })
    send(db, { conversationId: dm.id, fromAgentId: a.id, body: "2" })
    send(db, { conversationId: dm.id, fromAgentId: a.id, body: "3" })
    const fourth = send(db, { conversationId: dm.id, fromAgentId: a.id, body: "4" })
    send(db, { conversationId: dm.id, fromAgentId: a.id, body: "5" })

    const latest = history(db, { conversationId: dm.id, limit: 2 })
    expect(latest.map((m) => m.body)).toEqual(["4", "5"])

    const earlier = history(db, { conversationId: dm.id, before: fourth.seq, limit: 2 })
    expect(earlier.map((m) => m.body)).toEqual(["2", "3"])

    const after = messagesAfter(db, dm.id, fourth.seq)
    expect(after.map((m) => m.body)).toEqual(["5"])
  })
})
