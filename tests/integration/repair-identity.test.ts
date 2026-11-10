/**
 * `bin/repair-identity.mjs`（U2 身份遗留一键修复）集成测试。
 *
 * 全程临时 `AGENTCHAT_HOME`：造出"容器身份冒用"的存量（容器 participant / read_states /
 * wake_jobs / 容器署名的非 system 与 system 消息 / 容器创建的群），再验证 dry-run 零写入、
 * `--apply` 的快照与修复结果、幂等、`--check` 退出码与外键完整性。
 * 直接 import 脚本函数（不 spawn 子进程），因此不依赖 CLI 进程环境。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { parseRepairArgs } from "../../bin/repair-args.mjs"
import { LEGACY_IDENTITY_KEY, LEGACY_IDENTITY_VALUE, runRepair } from "../../bin/repair-identity.mjs"
import { openDb, type Db } from "../../server/db"
import { insertAgent, insertAgentKey } from "../../server/store/agents"
import { addParticipant, createDm, createGroup } from "../../server/store/conversations"
import { send } from "../../server/store/messages"
import { markRead } from "../../server/store/read_states"

const NOW = Date.parse("2026-11-10T02:00:00.000Z")
const HOME_PREFIX = "agentchat-repair-identity-"

/** 报告形状（脚本侧为 JSDoc，这里给出断言所需的最小结构）。 */
interface RepairReport {
  readonly ok: boolean
  readonly mode: string
  readonly home: string
  readonly dbExists: boolean
  readonly containers: readonly { readonly id: string; readonly displayName: string }[]
  readonly findings: {
    readonly participants: readonly unknown[]
    readonly readStates: readonly unknown[]
    readonly wakeJobs: readonly unknown[]
    readonly messages: {
      readonly total: number
      readonly marked: number
      readonly unmarked: readonly { readonly seq: number; readonly bodyPreview: string }[]
      readonly system: readonly unknown[]
    }
    readonly containerAgentKeys: readonly unknown[]
    readonly containerCreatedGroups: readonly { readonly id: string }[]
    readonly singleMemberDms: readonly {
      readonly conversationId: string
      readonly remainingParticipantCount: number
      readonly remainingAgentId?: string
    }[]
  }
  readonly residue: {
    readonly participants: number
    readonly readStates: number
    readonly wakeJobs: number
    readonly unmarkedMessages: number
    readonly containerCreatedGroups: number
  }
  readonly foreignKeyViolations: readonly unknown[]
  readonly applied?: {
    readonly deletedParticipants: number
    readonly deletedReadStates: number
    readonly deletedWakeJobs: number
    readonly messagesMarked: number
  }
  readonly snapshotPath?: string
}

interface Outcome {
  readonly code: number
  readonly home: string
  readonly report?: object
}

function reportOf(outcome: Outcome): RepairReport {
  if (outcome.report === undefined) throw new Error("expected a report")
  return outcome.report as RepairReport
}

function deps(home: string, lines?: string[]) {
  return {
    env: { AGENTCHAT_HOME: home },
    now: () => NOW,
    log: (line: string) => {
      if (lines === undefined) console.log(line)
      else lines.push(line)
    },
  }
}

/** 删除本文件产生的一切临时目录（home 与 `<home>.bak-identity-*` 兄弟目录）。 */
afterEach(() => {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(HOME_PREFIX)) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
})

function backupDirs(home: string): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`${basename(home)}.bak-identity-`))
}

interface Fixture {
  readonly home: string
  readonly container1: string
  readonly container2: string
  readonly alice: string
  readonly bob: string
  readonly dmId: string
  readonly groupId: string
  readonly m1: number
  readonly m2: number
  readonly m3: number
  readonly m4: number
}

/**
 * 造存量夹具。`containerCreatedGroup=true` 时额外造一个"容器创建的群"（只报告不修，计入残留）。
 */
function makeFixture(options: { readonly containerCreatedGroup?: boolean } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), HOME_PREFIX))
  const db = openDb(join(home, "agentchat.db"))
  try {
    const container1 = insertAgent(db, { name: "cont-1", kind: "logical", status: "online", vendor: "dsh", roleTag: "container" })
    const container2 = insertAgent(db, { name: "cont-2", kind: "logical", status: "online", vendor: "dsh", roleTag: "container" })
    const alice = insertAgent(db, { name: "alice", kind: "runtime", status: "online", vendor: "opencode" })
    const bob = insertAgent(db, { name: "bob", kind: "runtime", status: "online", vendor: "opencode" })

    // 容器在 DM 里（删成员后该 DM 只剩 alice）与群里各留一条 participant。
    const dm = createDm(db, alice.id, container1.id)
    const group = createGroup(db, { name: "g-1", createdBy: alice.id, memberIds: [bob.id] })
    addParticipant(db, { conversationId: group.id, agentId: container1.id, invitedBy: alice.id })

    // m1 = 容器署名的非 system 消息（待标注，带其它 meta 键）；m2 = 人类消息（不得动）
    // m3 = 容器署名的 system 消息（不标注）；m4 = 已标注过的消息（幂等）
    const m1 = send(db, { conversationId: dm.id, fromAgentId: container1.id, body: "容器冒名发言", meta: { keep: "me", n: 1 } })
    const m2 = send(db, { conversationId: dm.id, fromAgentId: alice.id, body: "alice 的话" })
    const m3 = send(db, { conversationId: group.id, fromAgentId: container2.id, body: "容器 system 记账", kind: "system", meta: { action: "group_add" } })
    const m4 = send(db, {
      conversationId: group.id,
      fromAgentId: container1.id,
      body: "已标注过",
      meta: { keep: true, [LEGACY_IDENTITY_KEY]: LEGACY_IDENTITY_VALUE },
    })

    markRead(db, { conversationId: dm.id, agentId: container1.id, lastReadSeq: m1.seq })
    db.prepare<[number, string, number, number]>(
      "INSERT INTO wake_jobs (message_id, agent_id, retry_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(m1.seq, container1.id, NOW, NOW)
    db.prepare<[number, string, number, number]>(
      "INSERT INTO wake_jobs (message_id, agent_id, retry_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(m2.seq, container2.id, NOW, NOW)
    insertAgentKey(db, "hash-cont-1", container1.id)

    if (options.containerCreatedGroup === true) createGroup(db, { name: "cont-group", createdBy: container1.id })

    return {
      home,
      container1: container1.id,
      container2: container2.id,
      alice: alice.id,
      bob: bob.id,
      dmId: dm.id,
      groupId: group.id,
      m1: m1.seq,
      m2: m2.seq,
      m3: m3.seq,
      m4: m4.seq,
    }
  } finally {
    db.close()
  }
}

/** 以 openDb 打开夹具库做断言（读）；调用方负责回调内只做读。 */
function withDb<T>(home: string, fn: (db: Db) => T): T {
  const db = openDb(join(home, "agentchat.db"))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** 库内容指纹：任何 participant/read_state/wake_job/message 变化都会被捕捉（dry-run 零写入判据）。 */
function fingerprint(home: string): string {
  return withDb(home, (db) =>
    JSON.stringify([
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM participants").get(),
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM read_states").get(),
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM wake_jobs").get(),
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM conversations").get(),
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM agents").get(),
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM agent_keys").get(),
      db.prepare<[], { seq: number; meta: string | null; body: string }>(
        "SELECT seq, meta, body FROM messages ORDER BY seq",
      ).all(),
    ]),
  )
}

function metaOf(db: Db, seq: number): Record<string, unknown> {
  const row = db
    .prepare<[number], { meta: string | null; body: string }>("SELECT meta, body FROM messages WHERE seq = ?")
    .get(seq)
  if (row === undefined) throw new Error(`message ${seq} missing`)
  return JSON.parse(row.meta ?? "{}") as Record<string, unknown>
}

describe("parseRepairArgs（纯参数解析）", () => {
  it("识别 --apply/--check/--json/--home 两种写法，并拒绝互斥组合", () => {
    expect(parseRepairArgs([])).toMatchObject({ apply: false, check: false, json: false, home: undefined, errors: [] })
    expect(parseRepairArgs(["--apply", "--json"]).apply).toBe(true)
    expect(parseRepairArgs(["--home=/tmp/x"]).home).toBe("/tmp/x")
    expect(parseRepairArgs(["--home", "/tmp/x"]).home).toBe("/tmp/x")
    expect(parseRepairArgs(["--home"]).errors).toHaveLength(1)
    expect(parseRepairArgs(["--apply", "--check"]).errors).toHaveLength(1)
    expect(parseRepairArgs(["--nope"]).errors).toHaveLength(1)
  })
})

describe("dry-run（缺省）", () => {
  it("只扫描并报告发现项：零写入、不生成快照", () => {
    const f = makeFixture()
    const before = fingerprint(f.home)
    const lines: string[] = []

    const outcome = runRepair(parseRepairArgs([]), deps(f.home, lines))
    expect(outcome.code).toBe(0)
    expect(fingerprint(f.home)).toBe(before)
    expect(backupDirs(f.home)).toHaveLength(0)

    const report = reportOf(outcome)
    expect(report.mode).toBe("dry-run")
    expect(report.dbExists).toBe(true)
    expect(report.containers).toHaveLength(2)
    expect(report.residue).toEqual({
      participants: 2,
      readStates: 1,
      wakeJobs: 2,
      unmarkedMessages: 1,
      containerCreatedGroups: 0,
    })
    // system 消息单独计数、不进"待标注"
    expect(report.findings.messages.system).toHaveLength(1)
    expect(report.findings.messages.unmarked.map((m) => m.seq)).toEqual([f.m1])
    expect(report.findings.singleMemberDms).toHaveLength(1)
    expect(report.findings.singleMemberDms[0]).toMatchObject({
      conversationId: f.dmId,
      remainingParticipantCount: 1,
      remainingAgentId: f.alice,
    })
    expect(report.foreignKeyViolations).toEqual([])
    expect(lines.join("\n")).toContain("dry-run")
    expect(lines.join("\n")).toContain("待标注 1")
  })

  it("库文件不存在：dry-run 与 --check 均干净退出 0", () => {
    const home = mkdtempSync(join(tmpdir(), HOME_PREFIX))
    for (const args of [[], ["--check"]]) {
      const outcome = runRepair(parseRepairArgs(args), deps(home))
      expect(outcome.code).toBe(0)
      expect(reportOf(outcome).dbExists).toBe(false)
    }
  })
})

describe("--check（自检，只读）", () => {
  it("有残留退出 1；--apply 后退出 0；--check 本身不改库", () => {
    const f = makeFixture()
    const before = fingerprint(f.home)

    const dirty = runRepair(parseRepairArgs(["--check"]), deps(f.home))
    expect(dirty.code).toBe(1)
    expect(fingerprint(f.home)).toBe(before)
    expect(backupDirs(f.home)).toHaveLength(0)

    expect(runRepair(parseRepairArgs(["--apply"]), deps(f.home)).code).toBe(0)

    const clean = runRepair(parseRepairArgs(["--check"]), deps(f.home))
    expect(clean.code).toBe(0)
    expect(reportOf(clean).ok).toBe(true)
  })
})

describe("--apply（执行修复）", () => {
  it("清 participants/read_states/wake_jobs，标注非 system 消息且保留其它 meta 键与正文", () => {
    const f = makeFixture()
    const outcome = runRepair(parseRepairArgs(["--apply"]), deps(f.home))
    expect(outcome.code).toBe(0)

    const report = reportOf(outcome)
    expect(report.applied).toEqual({
      deletedParticipants: 2,
      deletedReadStates: 1,
      deletedWakeJobs: 2,
      messagesMarked: 1,
    })
    expect(report.residue).toEqual({
      participants: 0,
      readStates: 0,
      wakeJobs: 0,
      unmarkedMessages: 0,
      containerCreatedGroups: 0,
    })

    withDb(f.home, (db) => {
      // 容器 participant 全清
      const containerParts = db
        .prepare<[string, string], { agent_id: string }>(
          "SELECT agent_id FROM participants WHERE agent_id IN (?, ?)",
        )
        .all(f.container1, f.container2)
      expect(containerParts).toEqual([])
      // read_states / wake_jobs 全清
      expect(
        db.prepare<[string, string], { n: number }>("SELECT COUNT(*) AS n FROM read_states WHERE agent_id IN (?, ?)").get(f.container1, f.container2),
      ).toEqual({ n: 0 })
      expect(
        db.prepare<[string, string], { n: number }>("SELECT COUNT(*) AS n FROM wake_jobs WHERE agent_id IN (?, ?)").get(f.container1, f.container2),
      ).toEqual({ n: 0 })

      // 容器 agents / agent_keys 行保留
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM agents WHERE role_tag = 'container'").get()).toEqual({ n: 2 })
      expect(db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM agent_keys WHERE agent_id = ?").get(f.container1)).toEqual({ n: 1 })

      // m1：标注合并进既有 meta，其它键与正文不变
      expect(metaOf(db, f.m1)).toEqual({ keep: "me", n: 1, [LEGACY_IDENTITY_KEY]: LEGACY_IDENTITY_VALUE })
      const m1Body = db.prepare<[number], { body: string }>("SELECT body FROM messages WHERE seq = ?").get(f.m1)
      expect(m1Body?.body).toBe("容器冒名发言")
      // m2：人类消息不动
      expect(metaOf(db, f.m2)).toEqual({})
      // m3：容器 system 消息不标注
      expect(metaOf(db, f.m3)).toEqual({ action: "group_add" })
      // m4：已标注的保持原样（幂等）
      expect(metaOf(db, f.m4)).toEqual({ keep: true, [LEGACY_IDENTITY_KEY]: LEGACY_IDENTITY_VALUE })

      expect(db.pragma("foreign_key_check")).toEqual([])
    })
  })

  it("DM 只剩单一参与者时保留会话与其历史（只报告，不删会话）", () => {
    const f = makeFixture()
    const lines: string[] = []
    const outcome = runRepair(parseRepairArgs(["--apply"]), deps(f.home, lines))
    expect(outcome.code).toBe(0)
    expect(lines.join("\n")).toContain("不足两人的 DM")

    withDb(f.home, (db) => {
      expect(db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE id = ?").get(f.dmId)).toEqual({ n: 1 })
      const remaining = db
        .prepare<[string], { agent_id: string }>("SELECT agent_id FROM participants WHERE conversation_id = ?")
        .all(f.dmId)
      expect(remaining.map((r) => r.agent_id)).toEqual([f.alice])
      // 历史消息（容器署名那条也在）完好
      const history = db
        .prepare<[string], { seq: number }>("SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq")
        .all(f.dmId)
      expect(history.map((r) => r.seq)).toEqual([f.m1, f.m2])
    })
  })

  it("写前生成 VACUUM INTO 快照，且快照是修复前状态", () => {
    const f = makeFixture()
    const outcome = runRepair(parseRepairArgs(["--apply"]), deps(f.home))
    const snapshotPath = outcome.snapshotPath as string | undefined
    expect(snapshotPath).toBeDefined()
    expect(existsSync(snapshotPath as string)).toBe(true)
    expect(basename(snapshotPath as string)).toBe("agentchat.db")
    expect(snapshotPath).toBe(join(`${f.home}.bak-identity-2026-11-10T02-00-00-000Z`, "agentchat.db"))

    const snapshot = new Database(snapshotPath as string, { readonly: true })
    try {
      const row = snapshot
        .prepare("SELECT COUNT(*) AS n FROM participants WHERE agent_id IN (?, ?)")
        .get(f.container1, f.container2) as { n: number }
      expect(row.n).toBe(2)
      const marked = snapshot.prepare("SELECT meta FROM messages WHERE seq = ?").get(f.m1) as { meta: string | null }
      expect(marked.meta).toBe(JSON.stringify({ keep: "me", n: 1 }))
    } finally {
      snapshot.close()
    }
  })

  it("幂等：第二次 --apply 零变更且不生成新快照", () => {
    const f = makeFixture()
    expect(runRepair(parseRepairArgs(["--apply"]), deps(f.home)).code).toBe(0)
    expect(backupDirs(f.home)).toHaveLength(1)
    const afterFirst = fingerprint(f.home)

    const second = runRepair(parseRepairArgs(["--apply"]), deps(f.home))
    expect(second.code).toBe(0)
    expect(reportOf(second).applied).toEqual({
      deletedParticipants: 0,
      deletedReadStates: 0,
      deletedWakeJobs: 0,
      messagesMarked: 0,
    })
    expect(fingerprint(f.home)).toBe(afterFirst)
    expect(backupDirs(f.home)).toHaveLength(1)
  })
})

describe("容器创建的群（只报告不修）", () => {
  it("计入残留（--check 退出 1），但 --apply 不删除该群、不删会话", () => {
    const f = makeFixture({ containerCreatedGroup: true })

    const dirty = runRepair(parseRepairArgs(["--check"]), deps(f.home))
    expect(dirty.code).toBe(1)
    expect(reportOf(dirty).residue.containerCreatedGroups).toBe(1)

    expect(runRepair(parseRepairArgs(["--apply"]), deps(f.home)).code).toBe(0)

    withDb(f.home, (db) => {
      const groups = db
        .prepare<[string], { id: string; memberCount: number }>(
          `SELECT c.id AS id,
                  (SELECT COUNT(*) FROM participants p WHERE p.conversation_id = c.id) AS memberCount
             FROM conversations c WHERE c.created_by = ?`,
        )
        .all(f.container1)
      expect(groups).toHaveLength(1)
      // 容器 owner 行被清（修复项），但会话本身保留
      expect(groups[0]?.memberCount).toBe(0)
    })

    // 群不可自动修 → 残留仍在，--check 仍 1
    const after = runRepair(parseRepairArgs(["--check"]), deps(f.home))
    expect(after.code).toBe(1)
    expect(reportOf(after).residue).toEqual({
      participants: 0,
      readStates: 0,
      wakeJobs: 0,
      unmarkedMessages: 0,
      containerCreatedGroups: 1,
    })
  })
})
