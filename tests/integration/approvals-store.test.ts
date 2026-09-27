/**
 * Task 1 —— approvals 数据层（spec §17 + §5.3/§9 修订）集成测试：
 * - fresh DB：`approvals` 具备 kind/target/result/read_at 四新列，CHECK 含 `'answered'`
 * - 旧库迁移：旧结构（无新列、旧 CHECK）经 `openDb` 重建 → 列齐备、`answered` 可写、
 *   既有行补 `kind='action'/target='human'`；连跑两次 openDb 不报错（幂等）
 * - store：`insertAsk`/`getApproval` 往返；`claimDecision` 首决生效（二决 0 行）；
 *   `markAnswered` 首答生效且不覆盖；`listNotifications` 两 scope；`markRead` 幂等；
 *   `claimExpired`（DoD 的 `listExpired` 落点）覆盖两种 kind
 * 每个用例独立临时 $AGENTCHAT_HOME。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { insertAgent } from "../../server/store/agents"
import {
  claimDecision,
  claimExpired,
  getApproval,
  insertApproval,
  insertAsk,
  markAnswered,
} from "../../server/store/approvals"
import { listNotifications, markRead } from "../../server/store/notifications"

let home = ""
let dbPath = ""
let db: Db

const TTL = 86_400_000

function makeAgent(name: string) {
  return insertAgent(db, {
    name,
    kind: "runtime",
    status: "online",
    vendor: "opencode",
    model: "test-model",
  })
}

function columnsOf(database: Db): string[] {
  return (database.pragma("table_info(approvals)") as { name: string }[]).map((c) => c.name)
}

function approvalsSql(database: Db): string {
  const row = database
    .prepare<[string], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("approvals")
  return row?.sql ?? ""
}

/** 构造旧结构库：schema.sql 建齐八表后，将 approvals 退化为旧结构（无新列、旧 CHECK）+ 一行旧数据。 */
function seedLegacyDb(path: string): void {
  const legacy = new Database(path)
  legacy.pragma("foreign_keys = ON")
  legacy.exec(readFileSync(new URL("../../server/schema.sql", import.meta.url), "utf8"))
  legacy.exec("DROP TABLE approvals")
  legacy.exec(`CREATE TABLE approvals (
    id                 TEXT PRIMARY KEY,
    requester_agent_id TEXT NOT NULL REFERENCES agents(id),
    action             TEXT NOT NULL,
    payload            TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    created_at         INTEGER NOT NULL,
    decided_at         INTEGER
  )`)
  legacy
    .prepare(
      "INSERT INTO agents (id, name, kind, root_id, vendor, status, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("legacy-agent", "legacy-agent", "runtime", "legacy-agent", "opencode", "online", 1000, 1000)
  legacy
    .prepare(
      "INSERT INTO approvals (id, requester_agent_id, action, payload, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("legacy-approval", "legacy-agent", "shout", JSON.stringify({ body: "旧" }), "pending", 1000, null)
  legacy.close()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-approvals-store-"))
  dbPath = loadConfig({ AGENTCHAT_HOME: home }).dbPath
  db = openDb(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

describe("fresh DB schema", () => {
  it("has the four new columns and the five-value status CHECK", () => {
    const columns = columnsOf(db)
    for (const column of ["kind", "target", "result", "read_at"]) {
      expect(columns).toContain(column)
    }
    expect(approvalsSql(db)).toContain("'answered'")
  })
})

describe("旧库幂等迁移", () => {
  it("rebuilds a legacy approvals table, backfills action/human, and is idempotent across two opens", () => {
    const legacyHome = mkdtempSync(join(tmpdir(), "agentchat-approvals-legacy-"))
    const legacyPath = loadConfig({ AGENTCHAT_HOME: legacyHome }).dbPath
    try {
      seedLegacyDb(legacyPath)

      const migrated = openDb(legacyPath)
      const columns = columnsOf(migrated)
      for (const column of ["kind", "target", "result", "read_at"]) {
        expect(columns).toContain(column)
      }
      expect(approvalsSql(migrated)).toContain("'answered'")

      const row = getApproval(migrated, "legacy-approval")
      expect(row).toMatchObject({
        kind: "action",
        target: "human",
        action: "shout",
        status: "pending",
      })
      expect(row?.result).toBeUndefined()
      expect(row?.readAt).toBeUndefined()

      // 旧 CHECK 已放宽：status='answered' 可写、首答生效
      expect(markAnswered(migrated, "legacy-approval", { text: "答复" })).toBe(true)
      expect(getApproval(migrated, "legacy-approval")?.status).toBe("answered")
      migrated.close()

      // 幂等：再次 openDb 不报错、不重复重建（仍恰八张表，无 approvals_new 残留）
      const reopened = openDb(legacyPath)
      const tables = reopened
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((t) => t.name)
      expect(tables).toContain("approvals")
      expect(tables).not.toContain("approvals_new")
      expect(tables).toHaveLength(8)
      reopened.close()
    } finally {
      rmSync(legacyHome, { recursive: true, force: true })
    }
  })
})

describe("insertAsk / getApproval 往返", () => {
  it("stores an ask with kind/target and default allowCustom=true", () => {
    const agent = makeAgent("ask-src")
    const ask = insertAsk(db, {
      requesterAgentId: agent.id,
      target: "human",
      question: "部署到哪个环境？",
      options: ["staging", "prod"],
      now: 100,
    })

    expect(ask).toMatchObject({ kind: "ask", target: "human", action: "ask", status: "pending" })
    const fetched = getApproval(db, ask.id)
    expect(fetched).toMatchObject({
      kind: "ask",
      target: "human",
      action: "ask",
      status: "pending",
      payload: { question: "部署到哪个环境？", options: ["staging", "prod"], allowCustom: true },
    })
    expect(fetched?.result).toBeUndefined()
    expect(fetched?.readAt).toBeUndefined()
  })

  it("honors allowCustom=false and an agent target", () => {
    const requester = makeAgent("ask-src-2")
    const target = makeAgent("ask-target-2")
    const ask = insertAsk(db, {
      requesterAgentId: requester.id,
      target: target.id,
      question: "走不走？",
      options: [],
      allowCustom: false,
      now: 1,
    })
    const fetched = getApproval(db, ask.id)
    expect(fetched?.target).toBe(target.id)
    expect(fetched?.payload["allowCustom"]).toBe(false)
  })
})

describe("claimDecision", () => {
  it("keeps the first decision and returns undefined on a second", () => {
    const agent = makeAgent("dec-src")
    const approval = insertApproval(db, {
      requesterAgentId: agent.id,
      action: "shout",
      payload: { body: "x" },
      now: 1,
    })

    const first = claimDecision(db, { id: approval.id, status: "approved", now: 2 })
    expect(first).toMatchObject({ kind: "action", status: "approved" })
    expect(claimDecision(db, { id: approval.id, status: "rejected", now: 3 })).toBeUndefined()
    expect(getApproval(db, approval.id)?.status).toBe("approved")
  })
})

describe("markAnswered", () => {
  it("keeps the first answer and does not overwrite on a second", () => {
    const agent = makeAgent("ans-src")
    const ask = insertAsk(db, {
      requesterAgentId: agent.id,
      target: "human",
      question: "选哪个？",
      options: ["a", "b"],
      now: 1,
    })

    expect(markAnswered(db, ask.id, { choice: "a", responder: "human" })).toBe(true)
    expect(markAnswered(db, ask.id, { choice: "b", responder: "human" })).toBe(false)

    const answered = getApproval(db, ask.id)
    expect(answered?.status).toBe("answered")
    expect(answered?.result).toMatchObject({ choice: "a", responder: "human" })
    expect(answered?.decidedAt).toEqual(expect.any(Number))
  })
})

describe("listNotifications", () => {
  it("actionable only returns human-targeted pending rows; all includes decided and agent-targeted", () => {
    const requester = makeAgent("notif-src")
    const peer = makeAgent("notif-peer")

    const humanAsk = insertAsk(db, {
      requesterAgentId: requester.id,
      target: "human",
      question: "q1",
      options: [],
      now: 10,
    })
    const agentAsk = insertAsk(db, {
      requesterAgentId: requester.id,
      target: peer.id,
      question: "q2",
      options: [],
      now: 20,
    })
    const action = insertApproval(db, {
      requesterAgentId: requester.id,
      action: "shout",
      payload: { body: "s" },
      now: 30,
    })
    claimDecision(db, { id: action.id, status: "approved", now: 31 })

    const actionable = listNotifications(db, "actionable")
    expect(actionable.map((a) => a.id)).toEqual([humanAsk.id])
    expect(actionable.every((a) => a.target === "human" && a.status === "pending")).toBe(true)

    // all 含已决与 agent↔agent，最新在前
    const all = listNotifications(db, "all")
    expect(all.map((a) => a.id)).toEqual([action.id, agentAsk.id, humanAsk.id])
  })
})

describe("markRead", () => {
  it("sets read_at once and is idempotent", () => {
    const agent = makeAgent("read-src")
    const ask = insertAsk(db, {
      requesterAgentId: agent.id,
      target: "human",
      question: "q",
      options: [],
      now: 5,
    })

    expect(markRead(db, ask.id)).toBe(true)
    const first = getApproval(db, ask.id)?.readAt
    expect(typeof first).toBe("number")
    expect(markRead(db, ask.id)).toBe(false)
    expect(getApproval(db, ask.id)?.readAt).toBe(first)
  })
})

describe("claimExpired（DoD 的 listExpired 落点）", () => {
  it("expires pending rows of both kinds and leaves fresh ones pending", () => {
    const agent = makeAgent("exp-src")
    const action = insertApproval(db, {
      requesterAgentId: agent.id,
      action: "shout",
      payload: { body: "a" },
      now: 1000,
    })
    const ask = insertAsk(db, {
      requesterAgentId: agent.id,
      target: "human",
      question: "q",
      options: [],
      now: 1000,
    })
    const fresh = insertAsk(db, {
      requesterAgentId: agent.id,
      target: "human",
      question: "q2",
      options: [],
      now: 10_000,
    })

    const expired = claimExpired(db, { now: 1000 + TTL + 1, ttlMs: TTL })
    expect(expired.map((a) => a.id).sort()).toEqual([action.id, ask.id].sort())
    expect(expired.every((a) => a.status === "expired")).toBe(true)
    expect(new Set(expired.map((a) => a.kind))).toEqual(new Set(["action", "ask"]))
    expect(getApproval(db, fresh.id)?.status).toBe("pending")
  })
})
