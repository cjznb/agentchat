/**
 * `POST /api/admin/prune-sessions` 集成测试（`server/routes/admin.ts`）：
 * - 谓词精确：1h 边界内不入选 / online 不入选 / 无 task_ref（人类与逻辑节点）不入选 / recent 不入选
 * - 预览（`execute:false`）零写入；执行后 `status='retired'` 且 pending wake job 被取消
 * - 二次执行 count=0（幂等）；非回环 403
 * 全程临时库注入，绝不触碰真实 AGENTCHAT_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../../server/index"
import { openDb, type Db } from "../../server/db"
import { insertAgent } from "../../server/store/agents"
import { sendMessage } from "../../server/core/messaging"
import { retire } from "../../server/core/agents"

// ④ 500 注入（prune-report.md:56「部分失败 500 路径无专项用例」）：retire 缺省仍代理真实现，
// 用例内临时改写为「第 2 次调用抛错」触发部分失败分支，finally 恢复（既有执行用例不受影响）。
vi.mock("../../server/core/agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/core/agents")>()
  return { ...original, retire: vi.fn(original.retire) }
})

const NOW = Date.parse("2026-09-30T12:00:00.000Z")
const HOUR = 3_600_000

interface Fixture {
  readonly db: Db
  readonly app: ReturnType<typeof createApp>
}

const cleanups: (() => void)[] = []

function fixture(loopback = true): Fixture {
  const home = mkdtempSync(join(tmpdir(), "agentchat-admin-prune-"))
  const db = openDb(join(home, "agentchat.db"))
  const app = createApp(db, { home, isLoopback: () => loopback, adminNow: () => NOW })
  cleanups.push(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { db, app }
}

function post(app: Fixture["app"], body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/admin/prune-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

/** 造一个历史测试会话节点：runtime + task_ref + offline + last_seen = NOW - age。 */
function historicalSession(db: Db, name: string, ageMs: number, status = "offline"): string {
  const agent = insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode", taskRef: `task-${name}` })
  db.prepare("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?").run(status, NOW - ageMs, agent.id)
  return agent.id
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("POST /api/admin/prune-sessions —— 谓词与预览", () => {
  it("非回环 403", async () => {
    const { app } = fixture(false)
    expect((await post(app, { execute: false })).status).toBe(403)
  })

  it("非法 body 400（execute 非布尔）", async () => {
    const { app } = fixture()
    expect((await post(app, { execute: "yes" })).status).toBe(400)
  })

  it("谓词精确：>1h offline task 节点入选；1h 整/online/无 task_ref/recent 均不入选", async () => {
    const { db, app } = fixture()
    const stale = historicalSession(db, "stale", HOUR + 1)
    historicalSession(db, "boundary", HOUR) // 1h 整：< 不成立，不入选
    historicalSession(db, "online-node", HOUR + 1, "online")
    const human = insertAgent(db, { name: "human", kind: "runtime", status: "online", vendor: "opencode" })
    db.prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").run(NOW - HOUR * 48, human.id)
    const logical = insertAgent(db, { name: "logical", kind: "logical", status: "offline", vendor: "none" })
    db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(NOW - HOUR * 48, logical.id)
    historicalSession(db, "recent", 60_000)

    const response = await post(app, { execute: false })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; count: number; candidates: { id: string; name: string }[] }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
    expect(body.candidates.map((entry) => entry.name)).toEqual(["stale"])
    // 预览零写入
    const status = db.prepare("SELECT status FROM agents WHERE id = ?").pluck().get(stale)
    expect(status).toBe("offline")
  })
})

describe("POST /api/admin/prune-sessions —— 执行", () => {
  it("执行退役候选 + 取消 pending wake job + 幂等二次执行 count=0", async () => {
    const { db, app } = fixture()
    const sender = insertAgent(db, { name: "sender", kind: "runtime", status: "online", vendor: "opencode" })
    const stale = historicalSession(db, "stale", HOUR + 1)
    sendMessage(db, { from: sender.id, to: stale, body: "历史消息" })
    // sendMessage 对 offline 收件人生成 pending wake job（资格：runtime 非 retired）
    const pending = db
      .prepare("SELECT COUNT(*) FROM wake_jobs WHERE agent_id = ? AND state = 'pending'")
      .pluck()
      .get(stale) as number
    expect(pending).toBeGreaterThan(0)

    const execute = await post(app, { execute: true })
    expect(execute.status).toBe(200)
    const body = (await execute.json()) as { ok: boolean; count: number; retired: { name: string }[] }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
    expect(body.retired.map((entry) => entry.name)).toEqual(["stale"])

    expect(db.prepare("SELECT status FROM agents WHERE id = ?").pluck().get(stale)).toBe("retired")
    const cancelled = db
      .prepare("SELECT COUNT(*) FROM wake_jobs WHERE agent_id = ? AND state = 'cancelled'")
      .pluck()
      .get(stale) as number
    expect(cancelled).toBe(pending)
    expect(
      db.prepare("SELECT COUNT(*) FROM wake_jobs WHERE agent_id = ? AND state = 'pending'").pluck().get(stale),
    ).toBe(0)

    // 二次执行（候选已全部退役）→ 空集
    const again = await post(app, { execute: true })
    const againBody = (await again.json()) as { ok: boolean; count: number }
    expect(againBody.count).toBe(0)
  })

  it("④ 部分失败注入：第 2 个 retire 抛错 → 500 {ok:false, error:'prune_failed', retired, count}", async () => {
    const { db, app } = fixture()
    historicalSession(db, "stale-a", HOUR + 1)
    historicalSession(db, "stale-b", HOUR + 2)
    const mocked = vi.mocked(retire)
    const delegate = mocked.getMockImplementation()
    if (delegate === undefined) throw new Error("缺少 vi.mock 工厂代理实现")
    let calls = 0
    mocked.mockImplementation((database, id) => {
      calls += 1
      if (calls === 2) throw new Error("注入：第 2 个 retire 失败")
      return delegate(database, id)
    })
    try {
      const response = await post(app, { execute: true })
      expect(response.status).toBe(500)
      const body = (await response.json()) as {
        ok: boolean
        error: string
        retired: { id: string; name: string }[]
        count: number
      }
      expect(body.ok).toBe(false)
      expect(body.error).toBe("prune_failed")
      expect(body.count).toBe(1)
      expect(body.retired).toHaveLength(1)
    } finally {
      mocked.mockImplementation(delegate)
    }
  })
})
