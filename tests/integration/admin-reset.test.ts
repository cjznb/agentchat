/**
 * Hub 管理端点集成测试（`server/routes/admin.ts`）：
 * - 仅回环：非回环 403（注入 `isLoopback:false`）
 * - `confirm` 必须精确 `"RESET"`，否则 400
 * - 成功：`VACUUM INTO` 快照存在且含原始数据；全部表就地重建为空且可用；
 *   tokens/agents/logs/backups/config.json/hub_token 已删；返回 `restartRequired`
 * - `keepBackups` 保留 backups/
 * - 清后引擎仍可用：`GET /api/roster` 200 且能喊话
 * 全程临时 `AGENTCHAT_HOME` + 注入库，绝不触碰用户真实数据。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createApp } from "../../server/index"
import { openDb, type Db } from "../../server/db"
import { insertAgent } from "../../server/store/agents"
import { sendMessage } from "../../server/core/messaging"

const NOW = Date.parse("2026-09-29T12:00:00.000Z")

interface Fixture {
  readonly home: string
  readonly db: Db
  readonly app: ReturnType<typeof createApp>
}

const cleanups: (() => void)[] = []

function fixture(loopback = true): Fixture {
  const home = mkdtempSync(join(tmpdir(), "agentchat-admin-reset-"))
  const db = openDb(join(home, "agentchat.db"))
  const sender = insertAgent(db, { name: "sender", kind: "runtime", status: "online", vendor: "opencode" })
  const node = insertAgent(db, { name: "node", kind: "runtime", status: "online", vendor: "opencode" })
  sendMessage(db, { from: sender.id, to: node.id, body: "历史消息" })
  writeFileSync(join(home, "hub_token"), "old-token")
  writeFileSync(join(home, "config.json"), '{"adapters":["opencode"]}')
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "opencode.id"), "a1")
  mkdirSync(join(home, "logs"), { recursive: true })
  writeFileSync(join(home, "logs", "x.log"), "log")
  mkdirSync(join(home, "backups"), { recursive: true })
  writeFileSync(join(home, "backups", "agentchat-daily-2026-09-01.db"), "B")
  mkdirSync(join(home, "tokens"), { recursive: true })
  writeFileSync(join(home, "tokens", "t"), "t")
  const app = createApp(db, { home, isLoopback: () => loopback, adminNow: () => NOW })
  cleanups.push(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(`${home}.bak-2026-09-29T12-00-00-000Z`, { recursive: true, force: true })
  })
  return { home, db, app }
}

function post(app: Fixture["app"], body: unknown, path = "/api/admin/reset"): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("POST /api/admin/reset —— 守卫", () => {
  it("非回环来源 403（POST reset 与 GET info）", async () => {
    const { app } = fixture(false)
    expect((await post(app, { confirm: "RESET" })).status).toBe(403)
    expect((await app.request("/api/admin/info")).status).toBe(403)
  })

  it("confirm 非精确 RESET → 400 invalid_body", async () => {
    const { app } = fixture()
    for (const body of [{ confirm: "reset" }, { confirm: "RESET " }, {}, { confirm: 1 }]) {
      const res = await post(app, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: "invalid_body" })
    }
  })

  it("GET /api/admin/info 返回 home 与 logsDir", async () => {
    const { app, home } = fixture()
    const body = (await (await app.request("/api/admin/info")).json()) as { home: string; logsDir: string }
    expect(body.home).toBe(home)
    expect(body.logsDir).toBe(join(home, "logs"))
  })
})

describe("POST /api/admin/reset —— 成功路径", () => {
  it("快照含原始数据、表就地重建为空、文件删除、restartRequired", async () => {
    const { app, db, home } = fixture()
    const res = await post(app, { confirm: "RESET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; restartRequired: boolean; snapshotPath: string }
    expect(body.ok).toBe(true)
    expect(body.restartRequired).toBe(true)

    // 快照是有效 SQLite 且含 reset 前的数据
    expect(existsSync(body.snapshotPath)).toBe(true)
    const snapshot = new Database(body.snapshotPath, { readonly: true })
    const before = snapshot.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }
    snapshot.close()
    expect(before.n).toBe(2)

    // 表已重建：空且结构可用
    const after = db.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }
    expect(after.n).toBe(0)
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 })

    // 适配器侧文件已删（DB 文件仍在——运行中不删）
    for (const name of ["hub_token", "config.json", "agents", "logs", "backups", "tokens"]) {
      expect(existsSync(join(home, name))).toBe(false)
    }
    expect(existsSync(join(home, "agentchat.db"))).toBe(true)
  })

  it("keepBackups 保留 backups/，仍清其余", async () => {
    const { app, home } = fixture()
    const res = await post(app, { confirm: "RESET", keepBackups: true })
    expect(res.status).toBe(200)
    expect(existsSync(join(home, "backups", "agentchat-daily-2026-09-01.db"))).toBe(true)
    expect(existsSync(join(home, "hub_token"))).toBe(false)
    expect(existsSync(join(home, "config.json"))).toBe(false)
  })

  it("清后引擎仍可用：GET /api/roster 200 且能喊话", async () => {
    const { app } = fixture()
    expect((await post(app, { confirm: "RESET" })).status).toBe(200)

    const roster = await app.request("/api/roster")
    expect(roster.status).toBe(200)

    const shout = await app.request("/api/shout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "重置后仍可用" }),
    })
    expect(shout.status).toBe(200)
    expect(((await shout.json()) as { ok: boolean }).ok).toBe(true)
  })
})
