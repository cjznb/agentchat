/**
 * `/api/test/*`（测试面）**独立验证**集成测试（T4）。
 *
 * 立场：按**冻结契约**（`docs/test-api.md`）与 T1/T2 任务书写断言，不照抄实现；
 * 实现只在失败时用于解释原因。覆盖开关/回环、seed 原子性、会话/消息/群/节点端点、
 * reset、生产面回归，以及 `start(port:0)` 起**真实 HTTP 服务**走的真机冒烟。
 * 全程临时 `AGENTCHAT_HOME` + 注入库 + 注入回环判定，绝不触碰用户真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { config, loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { createApp, start, type RunningServer } from "../../server/index"
import { insertAgent, insertAgentKey } from "../../server/store/agents"
import { insertApproval } from "../../server/store/approvals"
import { addParticipant as storeAddParticipant } from "../../server/store/conversations"
import { enqueueWakeJobs } from "../../server/store/wake"

type App = ReturnType<typeof createApp>
type Row = Readonly<Record<string, unknown>>

interface Fixture {
  readonly home: string
  readonly db: Db
  readonly app: App
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** 临时 home + 库（不含 app）：便于在同一库上挂「开」「关」两个 app 做对照。 */
function rawFixture(): { readonly home: string; readonly db: Db } {
  const home = mkdtempSync(join(tmpdir(), "agentchat-test-api-"))
  const db = openDb(join(home, "agentchat.db"))
  cleanups.push(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, db }
}

function fixture(options: { readonly loopback?: boolean; readonly testApi?: boolean } = {}): Fixture {
  const raw = rawFixture()
  const app = createApp(raw.db, {
    home: raw.home,
    isLoopback: () => options.loopback ?? true,
    testApi: options.testApi ?? true,
  })
  return { home: raw.home, db: raw.db, app }
}

function request(app: App, path: string, method = "GET", payload?: unknown): Promise<Response> {
  if (payload === undefined) return Promise.resolve(app.request(path, { method }))
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  )
}

const get = (app: App, path: string): Promise<Response> => request(app, path)
const post = (app: App, path: string, payload?: unknown): Promise<Response> =>
  request(app, path, "POST", payload)
const patch = (app: App, path: string, payload?: unknown): Promise<Response> =>
  request(app, path, "PATCH", payload)
const del = (app: App, path: string): Promise<Response> => request(app, path, "DELETE")

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** 错误响应：断言 HTTP 码 + 稳定错误码，并返回 body（供 detail/refs 进一步断言）。 */
async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  expect(response.status).toBe(status)
  const parsed = await read<ErrorBody>(response)
  expect(parsed.ok).toBe(false)
  expect(parsed.error).toBe(code)
  return parsed
}

// ── 载荷类型（域对象 camelCase；dump 行 snake_case → Row）────────────────────

interface ErrorBody {
  readonly ok: boolean
  readonly error: string
  readonly detail?: string
  readonly count?: number
  readonly refs?: Record<string, number>
}
interface PingBody {
  readonly ok: boolean
  readonly enabled: boolean
}
interface Dump {
  readonly ok: boolean
  readonly agents: Row[]
  readonly conversations: Row[]
  readonly participants: Row[]
  readonly messages: Row[]
  readonly approvals: Row[]
  readonly wakeJobs: Row[]
  readonly readStates: Row[]
  readonly agentKeys: Row[]
}
interface SeedAgent {
  readonly name: string
  readonly id: string
}
interface SeedConversation {
  readonly ref: string
  readonly id: string
  readonly key: string
  readonly kind: string
}
interface SeedResponse {
  readonly ok: boolean
  readonly agents: SeedAgent[]
  readonly conversations: SeedConversation[]
  readonly messages: Array<{ readonly id: string; readonly seq: number }>
}
interface MessagePayload {
  readonly id: string
  readonly seq: number
  readonly conversationId: string
  readonly fromAgentId: string
  readonly body: string
  readonly kind: string
}
interface SendResponse {
  readonly ok: boolean
  readonly message: MessagePayload
  readonly receipts: Array<{ readonly agentId: string; readonly stage: string }>
}
interface ConversationResponse {
  readonly ok: boolean
  readonly conversation: {
    readonly id: string
    readonly key: string
    readonly kind: string
    readonly name?: string
  }
}
interface ConversationListResponse {
  readonly ok: boolean
  readonly conversations: Array<{
    readonly id: string
    readonly kind: string
    readonly key: string
    readonly name?: string
    readonly messageCount: number
    readonly lastSeq: number
    readonly participants: Array<{ readonly agentId: string; readonly role: string }>
  }>
}
interface AgentResponse {
  readonly ok: boolean
  readonly agent: {
    readonly id: string
    readonly name: string
    readonly status: string
    readonly kind: string
    readonly vendor: string
    readonly model: string
  }
}
interface RenameResponse {
  readonly ok: boolean
  readonly name: string
}
interface RetireResponse {
  readonly ok: boolean
  readonly mode: string
  readonly agent: { readonly id: string; readonly status: string }
}
interface HardDeleteReport {
  readonly id: string
  readonly deletedConversations: number
  readonly deletedMessages: number
  readonly deletedApprovals: number
  readonly deletedWakeJobs: number
  readonly deletedParticipants: number
  readonly deletedReadStates: number
  readonly deletedKeys: number
  readonly clearedInvites: number
}
interface HardDeleteResponse {
  readonly ok: boolean
  readonly mode: string
  readonly report: HardDeleteReport
}
interface CascadeDeleteResponse {
  readonly ok: boolean
  readonly deleted: { readonly messages: number }
}
interface PurgeResponse {
  readonly ok: boolean
  readonly deleted: number
}
interface ReadResponse {
  readonly ok: boolean
  readonly lastReadSeq: number
}
interface PagingResponse {
  readonly ok: boolean
  readonly messages: MessagePayload[]
}
interface GroupResponse {
  readonly ok: boolean
  readonly group: { readonly id: string; readonly key: string }
}

// ── dump / 行助手 ──────────────────────────────────────────────────────────

async function readDump(app: App): Promise<Dump> {
  const response = await get(app, "/api/test/dump")
  expect(response.status).toBe(200)
  return read<Dump>(response)
}

function where(rows: readonly Row[], column: string, value: unknown): Row[] {
  return rows.filter((row) => row[column] === value)
}

function one(rows: readonly Row[], label: string): Row {
  if (rows.length !== 1) throw new Error(`${label}：期望恰好 1 行，实际 ${rows.length} 行`)
  const row = rows[0]
  if (row === undefined) throw new Error(`${label}：行缺失`)
  return row
}

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== "string") throw new Error(`列 ${column} 不是字符串（实际 ${typeof value}）`)
  return value
}

function num(row: Row, column: string): number {
  const value = row[column]
  if (typeof value !== "number") throw new Error(`列 ${column} 不是数字（实际 ${typeof value}）`)
  return value
}

function meta(row: Row): Record<string, unknown> {
  const raw = row["meta"]
  if (typeof raw !== "string") throw new Error(`meta 不是 JSON 字符串（实际 ${String(raw)}）`)
  return JSON.parse(raw) as Record<string, unknown>
}

function lookup<T>(map: ReadonlyMap<string, T>, key: string, label: string): T {
  const value = map.get(key)
  if (value === undefined) throw new Error(`${label} 缺失：${key}`)
  return value
}

/** 全表计数（「零写入」断言用）。 */
function tableCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of [
    "agents",
    "conversations",
    "participants",
    "messages",
    "approvals",
    "wake_jobs",
    "read_states",
    "agent_keys",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    counts[table] = row.n
  }
  return counts
}

/** 从 dump 取 human 的 id。 */
function humanIdFromDump(dump: Dump): string {
  return text(one(where(dump.agents, "vendor", "human"), "human 行"), "id")
}

/** 基础夹具：3 节点（甲 logical、乙 runtime online、丙 runtime busy）+ 群 + DM + 4 消息。 */
function basicSeedBody(): unknown {
  return {
    agents: [
      { name: "甲", parentId: "乙" },
      { name: "乙", kind: "runtime", status: "online", vendor: "opencode" },
      { name: "丙", kind: "runtime", status: "busy", vendor: "opencode" },
    ],
    conversations: [
      { kind: "group", name: "作战室", createdBy: "乙", memberIds: ["甲", "丙"], ref: "g1" },
      { kind: "dm", a: "甲", b: "丙", ref: "dm1" },
    ],
    messages: [
      { conversationKey: "g1", from: "乙", body: "开工" },
      { conversationKey: "g1", from: "甲", body: "收到" },
      { conversationKey: "dm1", from: "丙", body: "DM 收到" },
      { conversationKey: "dm1", from: "甲", body: "DM 回执", kind: "system" },
    ],
  }
}

interface BasicIds {
  readonly seed: SeedResponse
  readonly agent: ReadonlyMap<string, string>
  readonly conversation: ReadonlyMap<string, SeedConversation>
}

async function seedBasic(app: App): Promise<BasicIds> {
  const response = await post(app, "/api/test/seed", basicSeedBody())
  expect(response.status).toBe(200)
  const seed = await read<SeedResponse>(response)
  expect(seed.ok).toBe(true)
  return {
    seed,
    agent: new Map(seed.agents.map((agent) => [agent.name, agent.id] as const)),
    conversation: new Map(
      seed.conversations.map((conversation) => [conversation.ref, conversation] as const),
    ),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 开关（默认关闭）与回环守卫
// ═══════════════════════════════════════════════════════════════════════════

describe("A. 开关（默认关闭）与回环守卫", () => {
  it("loadConfig：无 env、无 config.json → testApi 默认 false；env > 文件 > 默认", () => {
    const home = mkdtempSync(join(tmpdir(), "agentchat-test-api-cfg-"))
    try {
      expect(loadConfig({ AGENTCHAT_HOME: home }).testApi).toBe(false)
      expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_TEST_API: "0" }).testApi).toBe(false)
      expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_TEST_API: "1" }).testApi).toBe(true)
      expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_TEST_API: "true" }).testApi).toBe(true)

      writeFileSync(join(home, "config.json"), JSON.stringify({ testApi: true }))
      expect(loadConfig({ AGENTCHAT_HOME: home }).testApi).toBe(true)
      // env 显式 0 压过文件 true（契约：env > 文件 > 默认）
      expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_TEST_API: "0" }).testApi).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("不传 testApi（进程默认关闭）→ /api/test/* 404 纯文本；生产端点不受影响", async () => {
    const { home, db } = rawFixture()
    // 前置：vitest setup 未设 AGENTCHAT_TEST_API。若开发者环境显式开启，此断言会明确失败
    //（前置被破坏），而不是让「默认关闭」的结论失真。
    expect(config.testApi).toBe(false)

    const app = createApp(db, { home, isLoopback: () => true }) // 刻意不传 testApi
    const ping = await get(app, "/api/test/ping")
    expect(ping.status).toBe(404)
    expect(await ping.text()).toBe("Not Found")
    expect((await get(app, "/api/test/dump")).status).toBe(404)
    expect((await get(app, "/api/test/agents")).status).toBe(404)

    // 显式 false 同样关闭
    const off = createApp(db, { home, isLoopback: () => true, testApi: false })
    expect((await get(off, "/api/test/ping")).status).toBe(404)

    // 生产面照旧可用（开关只影响 /api/test/*）
    expect((await get(off, "/api/health")).status).toBe(200)
    expect((await get(off, "/api/roster")).status).toBe(200)
  })

  it("非回环来源：全部测试端点 403 forbidden，且零写入", async () => {
    const { db, app } = fixture({ loopback: false })
    const cases: ReadonlyArray<readonly [string, string, unknown]> = [
      ["GET", "/api/test/ping", undefined],
      ["GET", "/api/test/dump", undefined],
      ["POST", "/api/test/reset", { confirm: "RESET" }],
      ["POST", "/api/test/seed", { agents: [{ name: "偷偷写入" }] }],
      ["POST", "/api/test/agents", { name: "偷偷写入" }],
      ["POST", "/api/test/shout", { body: "hi" }],
      ["DELETE", "/api/test/messages/deadbeef", undefined],
      ["DELETE", "/api/test/agents/x?mode=hard&force=1", undefined],
    ]
    for (const [method, path, payload] of cases) {
      const response = await request(app, path, method, payload)
      expect(response.status).toBe(403)
      expect(await read<ErrorBody>(response)).toEqual({ ok: false, error: "forbidden" })
    }
    expect(tableCounts(db)).toEqual({
      agents: 0,
      conversations: 0,
      participants: 0,
      messages: 0,
      approvals: 0,
      wake_jobs: 0,
      read_states: 0,
      agent_keys: 0,
    })
  })

  it("回环注入 true：ping 200 {ok:true,enabled:true}", async () => {
    const { app } = fixture()
    const response = await get(app, "/api/test/ping")
    expect(response.status).toBe(200)
    expect(await read<PingBody>(response)).toEqual({ ok: true, enabled: true })
  })

  it("未注册的 /api/test/* 子路径 → 404 纯文本（不泄露路由表）", async () => {
    const { app } = fixture()
    const response = await get(app, "/api/test/nope")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Not Found")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B. seed / dump
// ═══════════════════════════════════════════════════════════════════════════

describe("B. POST /api/test/seed 与 GET /api/test/dump", () => {
  it("3 节点（含前向父引用）+ 群 + DM + 4 消息：dump 行数与内容吻合，生产 roster 仍可用", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)

    expect(ids.seed.agents).toHaveLength(3)
    expect(ids.seed.conversations).toHaveLength(2)
    expect(ids.seed.messages).toHaveLength(4)

    const dump = await readDump(app)
    expect(dump.agents).toHaveLength(3)
    expect(dump.conversations).toHaveLength(2)
    expect(dump.participants).toHaveLength(5) // 群 3（乙 owner + 甲 + 丙）+ DM 2
    expect(dump.messages).toHaveLength(4)
    expect(dump.approvals).toHaveLength(0)
    expect(dump.wakeJobs).toHaveLength(0) // seed 直写：不触发 wake
    expect(dump.readStates).toHaveLength(0)
    expect(dump.agentKeys).toHaveLength(0)

    // 前向父引用：甲 的 parent_id/root_id 都指向后出现的 乙
    const yi = lookup(ids.agent, "乙", "agent 乙")
    const jia = one(where(dump.agents, "name", "甲"), "agent 甲")
    expect(text(jia, "id")).toBe(lookup(ids.agent, "甲", "agent 甲"))
    expect(text(jia, "parent_id")).toBe(yi)
    expect(text(jia, "root_id")).toBe(yi)
    expect(text(jia, "kind")).toBe("logical") // seed 默认 kind=logical
    expect(text(jia, "status")).toBe("online") // seed 默认 status=online
    expect(text(jia, "vendor")).toBe("opencode") // seed 默认 vendor

    // 群：key/name/created_by；DM：成员排序 key
    const group = lookup(ids.conversation, "g1", "会话别名 g1")
    const dm = lookup(ids.conversation, "dm1", "会话别名 dm1")
    const groupRow = one(where(dump.conversations, "id", group.id), "群会话行")
    expect(text(groupRow, "kind")).toBe("group")
    expect(text(groupRow, "key")).toBe(`group:${group.id}`)
    expect(text(groupRow, "name")).toBe("作战室")
    expect(text(groupRow, "created_by")).toBe(yi)
    const dmRow = one(where(dump.conversations, "id", dm.id), "DM 会话行")
    expect(text(dmRow, "kind")).toBe("dm")
    expect(dmRow["name"]).toBeNull()
    const dmMembers = [lookup(ids.agent, "甲", "甲"), lookup(ids.agent, "丙", "丙")].sort()
    expect(text(dmRow, "key")).toBe(`dm:${dmMembers[0]}_${dmMembers[1]}`)

    // 消息：按 seq 升序、正文/来源/kind 正确；seed 直写无 meta
    const seqs = dump.messages.map((message) => num(message, "seq"))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(dump.messages.map((message) => text(message, "body"))).toEqual([
      "开工",
      "收到",
      "DM 收到",
      "DM 回执",
    ])
    const systemMessage = one(where(dump.messages, "body", "DM 回执"), "system 消息")
    expect(text(systemMessage, "kind")).toBe("system")
    expect(text(systemMessage, "conversation_id")).toBe(dm.id)
    expect(systemMessage["meta"]).toBeNull()

    // 测试面不破坏生产面
    const roster = await get(app, "/api/roster")
    expect(roster.status).toBe(200)
    const tree = (await read<unknown>(roster)) as unknown[]
    expect(Array.isArray(tree)).toBe(true)
    // 根 = 乙（甲挂其下）、丙，外加 **human** —— `/api/roster` 自身会 `ensureHuman`（生产端点固有
    // 行为，与 seed 无关）。上面的 dump 断言发生在本调用之前，故当时仍为 3 个节点。
    expect(tree).toHaveLength(3)
    const rosterText = JSON.stringify(tree)
    for (const name of ["甲", "乙", "丙", "用户"]) expect(rosterText).toContain(name)
    expect(where((await readDump(app)).agents, "vendor", "human")).toHaveLength(1)
  })

  it("seed 引用解析失败（messages.from 不存在）→ 400 seed_ref_not_found 且整请求零写入", async () => {
    const { app } = fixture()
    // 刻意只留**一处**坏引用（消息的 from）：会话两端都合法 → 能走到 messages 校验，
    // 证明"agents/conversations 本可写入但整请求仍零写入"（而非被更早的会话引用错误拦下）
    const response = await post(app, "/api/test/seed", {
      agents: [{ name: "甲好" }, { name: "乙好" }],
      conversations: [{ kind: "dm", a: "甲好", b: "乙好", ref: "d1" }],
      messages: [{ conversationKey: "d1", from: "不存在的节点", body: "炸" }],
    })
    const body = await expectError(response, 400, "seed_ref_not_found")
    expect(body.detail).toBe("不存在的节点")
    const dump = await readDump(app)
    expect(dump.agents).toHaveLength(0)
    expect(dump.conversations).toHaveLength(0)
    expect(dump.participants).toHaveLength(0)
    expect(dump.messages).toHaveLength(0)
  })

  it("seed 形状校验：conversationId/conversationKey 都缺或都给 → 400 invalid_body", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const dm = lookup(ids.conversation, "dm1", "会话别名 dm1")

    const neither = await post(app, "/api/test/seed", {
      messages: [{ from: "甲", body: "没有目标" }],
    })
    await expectError(neither, 400, "invalid_body")

    const both = await post(app, "/api/test/seed", {
      messages: [{ conversationId: dm.id, conversationKey: dm.key, from: "甲", body: "两个目标" }],
    })
    await expectError(both, 400, "invalid_body")

    expect((await readDump(app)).messages).toHaveLength(4) // 零写入

    // 正向：`conversationKey` 支持**真实 key**（`dm:<idA>_<idB>`），非仅本次请求的 ref 别名
    const byRealKey = await post(app, "/api/test/seed", {
      messages: [{ conversationKey: dm.key, from: "甲", body: "按真实 key 写入" }],
    })
    expect(byRealKey.status).toBe(200)
    expect((await readDump(app)).messages).toHaveLength(5)
  })

  it("seed：DM 两端同一节点 → 400 invalid_body 且零写入（含本请求新建的节点）", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const jia = lookup(ids.agent, "甲", "甲")
    const before = await readDump(app)

    // 库内既有节点：同名同人
    await expectError(
      await post(app, "/api/test/seed", { conversations: [{ kind: "dm", a: "甲", b: "甲" }] }),
      400,
      "invalid_body",
    )
    // 库内既有节点：名字 + id 混写指同一人（契约 §3.1 表格）
    await expectError(
      await post(app, "/api/test/seed", { conversations: [{ kind: "dm", a: "甲", b: jia }] }),
      400,
      "invalid_body",
    )
    // 本请求将创建的节点：两端同一新名
    await expectError(
      await post(app, "/api/test/seed", {
        agents: [{ name: "新人甲" }],
        conversations: [{ kind: "dm", a: "新人甲", b: "新人甲" }],
      }),
      400,
      "invalid_body",
    )
    // 未知引用优先报 seed_ref_not_found（不是 invalid_body）
    await expectError(
      await post(app, "/api/test/seed", { conversations: [{ kind: "dm", a: "查无A", b: "查无B" }] }),
      400,
      "seed_ref_not_found",
    )
    // 全部失败路径零写入
    const after = await readDump(app)
    expect(after.agents).toEqual(before.agents)
    expect(after.conversations).toEqual(before.conversations)
    expect(after.participants).toEqual(before.participants)
  })

  it("seed 重名 409 name_taken（请求内 / 与库内既有）；请求内 ref 重复 → 400 invalid_body", async () => {
    const { app } = fixture()
    await expectError(
      await post(app, "/api/test/seed", { agents: [{ name: "同名" }, { name: "同名" }] }),
      409,
      "name_taken",
    )
    expect((await readDump(app)).agents).toHaveLength(0)

    await seedBasic(app)
    await expectError(await post(app, "/api/test/seed", { agents: [{ name: "乙" }] }), 409, "name_taken")
    expect((await readDump(app)).agents).toHaveLength(3)

    const duplicateRef = await post(app, "/api/test/seed", {
      agents: [{ name: "戊" }, { name: "己" }],
      conversations: [
        { kind: "dm", a: "戊", b: "己", ref: "dup" },
        { kind: "dm", a: "戊", b: "己", ref: "dup" },
      ],
    })
    await expectError(duplicateRef, 400, "invalid_body")
    expect((await readDump(app)).agents).toHaveLength(3) // 零写入
  })

  it("seed parentId 成环 → 400 seed_ref_not_found（detail=卡住的父引用），零写入", async () => {
    const { app } = fixture()
    const response = await post(app, "/api/test/seed", {
      agents: [
        { name: "环A", parentId: "环B" },
        { name: "环B", parentId: "环A" },
      ],
    })
    const body = await expectError(response, 400, "seed_ref_not_found")
    expect(["环A", "环B"]).toContain(String(body.detail))
    expect((await readDump(app)).agents).toHaveLength(0)
  })

  it("seed 引用未知会话 / 未知父节点 → 400 seed_ref_not_found，零写入", async () => {
    const { app } = fixture()
    await expectError(
      await post(app, "/api/test/seed", {
        agents: [{ name: "甲" }],
        messages: [{ conversationKey: "shout", from: "甲", body: "无会话" }],
      }),
      400,
      "seed_ref_not_found",
    )
    await expectError(
      await post(app, "/api/test/seed", { agents: [{ name: "孤儿", parentId: "没有这个人" }] }),
      400,
      "seed_ref_not_found",
    )
    const dump = await readDump(app)
    expect(dump.agents).toHaveLength(0)
    expect(dump.conversations).toHaveLength(0)
    expect(dump.messages).toHaveLength(0)
  })

  it("seed 非 JSON 请求体 → 400 invalid_body（JSON 错误响应，非 500）", async () => {
    const { app } = fixture()
    const response = await app.request("/api/test/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ 这不是 JSON",
    })
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type") ?? "").toContain("application/json")
    expect(await read<ErrorBody>(response)).toEqual({ ok: false, error: "invalid_body" })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 会话（列表 / 建 / 改名 / 删除 / 分页）
// ═══════════════════════════════════════════════════════════════════════════

describe("C. 会话端点", () => {
  it("GET /api/test/conversations：participants/messageCount/lastSeq 与库内一致", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const response = await get(app, "/api/test/conversations")
    expect(response.status).toBe(200)
    const body = await read<ConversationListResponse>(response)
    expect(body.conversations).toHaveLength(2)

    const group = body.conversations.find((item) => item.id === lookup(ids.conversation, "g1", "g1").id)
    if (group === undefined) throw new Error("列表缺少群 g1")
    expect(group.kind).toBe("group")
    expect(group.name).toBe("作战室")
    expect(group.participants.map((participant) => participant.agentId).sort()).toEqual(
      [lookup(ids.agent, "甲", "甲"), lookup(ids.agent, "乙", "乙"), lookup(ids.agent, "丙", "丙")].sort(),
    )
    expect(group.messageCount).toBe(2)
    const ownerRow = group.participants.find(
      (participant) => participant.agentId === lookup(ids.agent, "乙", "乙"),
    )
    expect(ownerRow?.role).toBe("owner")

    const dump = await readDump(app)
    const groupSeqs = where(dump.messages, "conversation_id", group.id).map((message) => num(message, "seq"))
    expect(group.lastSeq).toBe(Math.max(...groupSeqs))
  })

  it("POST /api/test/conversations：DM 幂等取或建；未知 agent 404；group 建群含 human owner", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)

    const first = await post(app, "/api/test/conversations", { kind: "dm", a: "甲", b: "丙" })
    expect(first.status).toBe(200)
    expect((await read<ConversationResponse>(first)).conversation.id).toBe(
      lookup(ids.conversation, "dm1", "dm1").id,
    )
    expect((await readDump(app)).conversations).toHaveLength(2) // 幂等：不新建

    await expectError(
      await post(app, "/api/test/conversations", { kind: "dm", a: "甲", b: "查无此人" }),
      404,
      "agent_not_found",
    )

    const groupResponse = await post(app, "/api/test/conversations", {
      kind: "group",
      name: "新群",
      memberIds: ["乙"],
    })
    expect(groupResponse.status).toBe(200)
    const group = await read<ConversationResponse>(groupResponse)
    expect(group.conversation.kind).toBe("group")
    const dump = await readDump(app)
    expect(where(dump.conversations, "id", group.conversation.id)).toHaveLength(1)
    expect(where(dump.participants, "conversation_id", group.conversation.id)).toHaveLength(2)
    const humanRow = one(
      where(
        where(dump.participants, "conversation_id", group.conversation.id),
        "agent_id",
        humanIdFromDump(dump),
      ),
      "human owner 行",
    )
    expect(text(humanRow, "role")).toBe("owner")
  })

  it("POST /api/test/conversations：DM 两端同一节点 → 400 invalid_body（含名字/id 混写）；未知引用仍 404", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const jia = lookup(ids.agent, "甲", "甲")
    const before = await readDump(app)

    // 同名同人
    await expectError(
      await post(app, "/api/test/conversations", { kind: "dm", a: "甲", b: "甲" }),
      400,
      "invalid_body",
    )
    // 名字 + id 混写指同一人（契约 docs/test-api.md §3.2）
    await expectError(
      await post(app, "/api/test/conversations", { kind: "dm", a: "甲", b: jia }),
      400,
      "invalid_body",
    )
    // 引用解析优先于形状判定：未知引用仍是 404（不是 400）
    await expectError(
      await post(app, "/api/test/conversations", { kind: "dm", a: "查无此人", b: "查无此人" }),
      404,
      "agent_not_found",
    )
    // 零写入（仍只有 DM1 + 群 g1）
    expect((await readDump(app)).conversations).toEqual(before.conversations)
  })

  it("PATCH 会话改名：群与 DM 都写 conversations.name；未知 404；非法名 400", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const dmId = lookup(ids.conversation, "dm1", "dm1").id
    const dmKey = lookup(ids.conversation, "dm1", "dm1").key

    const renamed = await patch(app, `/api/test/conversations/${groupId}`, { name: "  改名后的群  " })
    expect(renamed.status).toBe(200)
    expect((await read<ConversationResponse>(renamed)).conversation.name).toBe("改名后的群") // trim 后落库

    expect((await patch(app, `/api/test/conversations/${dmId}`, { name: "DM 备注名" })).status).toBe(200)

    const dump = await readDump(app)
    const groupRow = one(where(dump.conversations, "id", groupId), "群行")
    expect(text(groupRow, "name")).toBe("改名后的群")
    const dmRow = one(where(dump.conversations, "id", dmId), "DM 行")
    expect(text(dmRow, "name")).toBe("DM 备注名")
    expect(text(dmRow, "key")).toBe(dmKey) // key 是身份，改名不得动摇

    await expectError(
      await patch(app, "/api/test/conversations/不存在的会话", { name: "x" }),
      404,
      "conversation_not_found",
    )
    for (const body of [{ name: "" }, { name: "   " }, {}, { name: "a".repeat(65) }, { name: "带\u0007控制符" }]) {
      await expectError(await patch(app, `/api/test/conversations/${groupId}`, body), 400, "invalid_body")
    }
  })

  it("DELETE 群：会话 + messages + participants 全消失，其它会话不受影响，deleted.messages 正确", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const dmId = lookup(ids.conversation, "dm1", "dm1").id

    const before = await readDump(app)
    const expected = where(before.messages, "conversation_id", groupId).length
    expect(expected).toBe(2)

    const response = await del(app, `/api/test/conversations/${groupId}`)
    expect(response.status).toBe(200)
    const body = await read<CascadeDeleteResponse>(response)
    expect(body.deleted.messages).toBe(expected)

    const after = await readDump(app)
    expect(where(after.conversations, "id", groupId)).toHaveLength(0)
    expect(where(after.messages, "conversation_id", groupId)).toHaveLength(0)
    expect(where(after.participants, "conversation_id", groupId)).toHaveLength(0)
    expect(where(after.conversations, "id", dmId)).toHaveLength(1) // DM 仍在
    expect(where(after.messages, "conversation_id", dmId)).toHaveLength(2)
  })

  it("DELETE DM 同样级联；未知会话各处 404", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const dmId = lookup(ids.conversation, "dm1", "dm1").id
    const response = await del(app, `/api/test/conversations/${dmId}`)
    expect(response.status).toBe(200)
    expect((await read<CascadeDeleteResponse>(response)).deleted.messages).toBe(2)
    const after = await readDump(app)
    expect(where(after.conversations, "id", dmId)).toHaveLength(0)
    expect(where(after.messages, "conversation_id", dmId)).toHaveLength(0)
    expect(where(after.participants, "conversation_id", dmId)).toHaveLength(0)

    await expectError(await del(app, "/api/test/conversations/不存在"), 404, "conversation_not_found")
    await expectError(
      await get(app, "/api/test/conversations/不存在/messages"),
      404,
      "conversation_not_found",
    )
    await expectError(await post(app, "/api/test/conversations/不存在/purge"), 404, "conversation_not_found")
    await expectError(await post(app, "/api/test/conversations/不存在/read"), 404, "conversation_not_found")
    await expectError(await post(app, "/api/test/conversations/不存在/dissolve"), 404, "conversation_not_found")
    await expectError(
      await post(app, "/api/test/conversations/不存在/members/remove", { agentId: "甲" }),
      404,
      "conversation_not_found",
    )
  })

  it("GET .../messages 分页与参数校验（limit 1..200、before 非负整数）", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id

    const page = await get(app, `/api/test/conversations/${groupId}/messages?limit=1`)
    expect(page.status).toBe(200)
    const paged = await read<PagingResponse>(page)
    expect(paged.messages).toHaveLength(1)
    const maxSeq = paged.messages[0]?.seq ?? 0
    expect(maxSeq).toBeGreaterThan(0)

    const beforePage = await read<PagingResponse>(
      await get(app, `/api/test/conversations/${groupId}/messages?before=${maxSeq}`),
    )
    expect(beforePage.messages.every((message) => message.seq < maxSeq)).toBe(true)
    expect(beforePage.messages).toHaveLength(1)

    for (const query of ["limit=0", "limit=201", "limit=abc", "before=-1", "before=abc"]) {
      const response = await get(app, `/api/test/conversations/${groupId}/messages?${query}`)
      expect(response.status).toBe(400)
      expect((await read<ErrorBody>(response)).error).toBe(
        query.startsWith("limit") ? "invalid_limit" : "invalid_before",
      )
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D. 消息（真实投递 / 单条删除 / purge / read / shout）
// ═══════════════════════════════════════════════════════════════════════════

describe("D. 消息端点", () => {
  it("POST .../messages（from=agent）真实投递：写 messages + wake_jobs，receipts 与 job 同源；幂等键不重复投递", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const yi = lookup(ids.agent, "乙", "乙")
    const bing = lookup(ids.agent, "丙", "丙")
    const dmResponse = await post(app, "/api/test/conversations", { kind: "dm", a: "乙", b: "丙" })
    const dmId = (await read<ConversationResponse>(dmResponse)).conversation.id

    const send = await post(app, `/api/test/conversations/${dmId}/messages`, {
      from: "乙",
      body: "真实投递",
      idempotencyKey: "k-真实-1",
    })
    expect(send.status).toBe(200)
    const sent = await read<SendResponse>(send)
    expect(sent.message.conversationId).toBe(dmId)
    expect(sent.message.fromAgentId).toBe(yi)
    expect(sent.message.body).toBe("真实投递")
    expect(sent.message.kind).toBe("text")
    expect(sent.receipts).toEqual([{ agentId: bing, stage: "queued" }])

    const dump = await readDump(app)
    const row = one(where(dump.messages, "id", sent.message.id), "投递消息行")
    expect(num(row, "seq")).toBe(sent.message.seq)
    expect(text(row, "from_agent_id")).toBe(yi)
    const job = one(where(dump.wakeJobs, "message_id", sent.message.seq), "wake job")
    expect(text(job, "agent_id")).toBe(bing)
    expect(text(job, "state")).toBe("pending")
    expect(text(job, "pending_reason")).toBe("busy") // 丙 seed 状态 busy

    // 幂等键重发：不产生第二行消息、第二条 job
    const replayed = await read<SendResponse>(
      await post(app, `/api/test/conversations/${dmId}/messages`, {
        from: "乙",
        body: "真实投递（重发）",
        idempotencyKey: "k-真实-1",
      }),
    )
    expect(replayed.message.id).toBe(sent.message.id)
    const after = await readDump(app)
    expect(where(after.messages, "conversation_id", dmId)).toHaveLength(1)
    expect(where(after.wakeJobs, "message_id", sent.message.seq)).toHaveLength(1)
  })

  it("POST .../messages 错误码：非成员 403 not_participant / from 未知 404 / body 非法 400", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const dmId = lookup(ids.conversation, "dm1", "dm1").id
    expect((await post(app, "/api/test/agents", { name: "丁", kind: "runtime", status: "online" })).status).toBe(200)

    await expectError(
      await post(app, `/api/test/conversations/${dmId}/messages`, { from: "丁", body: "我不是成员" }),
      403,
      "not_participant",
    )
    await expectError(
      await post(app, `/api/test/conversations/${dmId}/messages`, { from: "查无此人", body: "x" }),
      404,
      "agent_not_found",
    )
    await expectError(
      await post(app, `/api/test/conversations/${dmId}/messages`, { from: "甲" }),
      400,
      "invalid_body",
    )

    // DM 内含分组容器（role_tag=container）→ 409 container_not_chat_target（契约 §3.2 错误码）
    const containerSeed = await read<SeedResponse>(
      await post(app, "/api/test/seed", {
        agents: [{ name: "容器", kind: "runtime", status: "online", roleTag: "container" }],
        conversations: [{ kind: "dm", a: "容器", b: "丁", ref: "cdm" }],
      }),
    )
    const cdm = lookup(
      new Map(containerSeed.conversations.map((conversation) => [conversation.ref, conversation] as const)),
      "cdm",
      "容器 DM",
    )
    await expectError(
      await post(app, `/api/test/conversations/${cdm.id}/messages`, { from: "丁", body: "给容器发" }),
      409,
      "container_not_chat_target",
    )
    expect((await readDump(app)).messages).toHaveLength(4) // 零写入
  })

  it("DELETE /api/test/messages/:id：删单条同时清掉 wake_jobs；未知 404", async () => {
    const { app } = fixture()
    await seedBasic(app)
    const dmResponse = await post(app, "/api/test/conversations", { kind: "dm", a: "乙", b: "丙" })
    const dmId = (await read<ConversationResponse>(dmResponse)).conversation.id
    const sent = await read<SendResponse>(
      await post(app, `/api/test/conversations/${dmId}/messages`, { from: "乙", body: "待删" }),
    )
    expect(where((await readDump(app)).wakeJobs, "message_id", sent.message.seq)).toHaveLength(1)

    const response = await del(app, `/api/test/messages/${sent.message.id}`)
    expect(response.status).toBe(200)
    expect(await read<{ ok: boolean }>(response)).toEqual({ ok: true })

    const after = await readDump(app)
    expect(where(after.messages, "id", sent.message.id)).toHaveLength(0)
    // 外键残留检查：没有任何 job 指向已不存在的消息
    const liveSeqs = new Set(after.messages.map((message) => num(message, "seq")))
    expect(after.wakeJobs.every((job) => liveSeqs.has(num(job, "message_id")))).toBe(true)

    await expectError(await del(app, "/api/test/messages/000000000000"), 404, "message_not_found")
  })

  it("POST .../purge：清空该会话 messages 与 wake_jobs，保留会话与成员", async () => {
    const { app } = fixture()
    await seedBasic(app)
    const dmResponse = await post(app, "/api/test/conversations", { kind: "dm", a: "乙", b: "丙" })
    const dmId = (await read<ConversationResponse>(dmResponse)).conversation.id
    await post(app, `/api/test/conversations/${dmId}/messages`, { from: "乙", body: "一" })
    await post(app, `/api/test/conversations/${dmId}/messages`, { from: "丙", body: "二" })

    const before = await readDump(app)
    const expected = where(before.messages, "conversation_id", dmId).length
    expect(expected).toBe(2)
    expect(before.wakeJobs).toHaveLength(2)

    const response = await post(app, `/api/test/conversations/${dmId}/purge`)
    expect(response.status).toBe(200)
    expect((await read<PurgeResponse>(response)).deleted).toBe(expected)

    const after = await readDump(app)
    expect(where(after.messages, "conversation_id", dmId)).toHaveLength(0)
    expect(after.wakeJobs).toHaveLength(0)
    expect(where(after.conversations, "id", dmId)).toHaveLength(1)
    expect(where(after.participants, "conversation_id", dmId)).toHaveLength(2)
  })

  it("POST .../read：read_states 位点 = 该会话最大 seq；body 可整体省略（缺省 human）", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const dmId = lookup(ids.conversation, "dm1", "dm1").id
    const bing = lookup(ids.agent, "丙", "丙")
    const before = await readDump(app)
    const maxSeq = Math.max(
      ...where(before.messages, "conversation_id", dmId).map((message) => num(message, "seq")),
    )

    const response = await post(app, `/api/test/conversations/${dmId}/read`, { agentId: "丙" })
    expect(response.status).toBe(200)
    expect((await read<ReadResponse>(response)).lastReadSeq).toBe(maxSeq)

    const dump = await readDump(app)
    const readState = one(
      where(where(dump.readStates, "conversation_id", dmId), "agent_id", bing),
      "丙 的已读位点",
    )
    expect(num(readState, "last_read_seq")).toBe(maxSeq)

    // 省略 body → 缺省 human（并顺带建出 human 行）
    const humanRead = await post(app, `/api/test/conversations/${dmId}/read`)
    expect(humanRead.status).toBe(200)
    expect((await read<ReadResponse>(humanRead)).lastReadSeq).toBe(maxSeq)
    const dump2 = await readDump(app)
    const humanState = one(
      where(where(dump2.readStates, "conversation_id", dmId), "agent_id", humanIdFromDump(dump2)),
      "human 的已读位点",
    )
    expect(num(humanState, "last_read_seq")).toBe(maxSeq)
  })

  it("POST /api/test/shout：喊话落 shout 广播会话（无成员行），仅 runtime 收件方建 job", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const bing = lookup(ids.agent, "丙", "丙")

    const response = await post(app, "/api/test/shout", { from: "乙", body: "全员注意" })
    expect(response.status).toBe(200)
    const shouted = await read<SendResponse>(response)
    expect(shouted.message.body).toBe("全员注意")

    const dump = await readDump(app)
    const shoutConversation = one(where(dump.conversations, "key", "shout"), "shout 会话")
    const shoutId = text(shoutConversation, "id")
    expect(text(shoutConversation, "name")).toBe("全员喊话")
    expect(where(dump.participants, "conversation_id", shoutId)).toHaveLength(0)
    expect(where(dump.messages, "conversation_id", shoutId)).toHaveLength(1)
    // 收件方 = 全部节点减去发送者（乙）；仅 runtime 收件方建 job → 丙
    const jobs = where(dump.wakeJobs, "message_id", shouted.message.seq)
    expect(jobs).toHaveLength(1)
    expect(text(one(jobs, "喊话 wake job"), "agent_id")).toBe(bing)
  })

  it("POST /api/test/shout（from=持 hub 身份的根 runtime）→ 走审批闸门返回 {ok:true,approval}，不广播", async () => {
    const { app, db } = fixture()
    await seedBasic(app)
    // 有 agent_keys 行的 runtime 根 = 生产根身份 → gate 落审批单而不执行（spec §8）
    const root = insertAgent(db, { name: "根R", kind: "runtime", status: "online", vendor: "opencode" })
    insertAgentKey(db, "hash-根R", root.id)

    const response = await post(app, "/api/test/shout", { from: "根R", body: "我要喊话" })
    expect(response.status).toBe(200)
    const body = await read<{
      ok: boolean
      approval?: { id: string; status: string; action: string }
      message?: unknown
    }>(response)
    expect(body.ok).toBe(true)
    expect(body.message).toBeUndefined()
    expect(body.approval?.status).toBe("pending")
    expect(body.approval?.action).toBe("shout")
    expect(typeof body.approval?.id).toBe("string")

    const dump = await readDump(app)
    // 未执行：没有 shout 广播会话、没有 broadcast 消息
    expect(where(dump.conversations, "key", "shout")).toHaveLength(0)
    expect(dump.approvals).toHaveLength(1)
    expect(text(dump.approvals[0] as Row, "requester_agent_id")).toBe(root.id)
    // 审批卡落在 发起方↔human 的 DM 里（kind=system，meta.approvalId）
    const channel = one(where(dump.participants, "agent_id", root.id), "审批通道成员行")
    const card = one(
      where(dump.messages, "conversation_id", text(channel, "conversation_id")).filter(
        (message) => text(message, "kind") === "system",
      ),
      "审批卡",
    )
    expect(meta(card)["approvalId"]).toBe(body.approval?.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E. 群成员与解散
// ═══════════════════════════════════════════════════════════════════════════

describe("E. 群成员与解散", () => {
  it("POST /api/test/shout：from=逻辑节点/子节点 → 403 forbidden（gate 直接拒绝，零写入）", async () => {
    const { app } = fixture()
    await seedBasic(app)
    const before = await readDump(app)

    // 甲 是 seed 默认的 logical 节点 → gate 拒绝（docs/test-api.md §3.6）
    await expectError(await post(app, "/api/test/shout", { from: "甲", body: "逻辑节点发起" }), 403, "forbidden")

    // runtime 子节点（parentId 指向父）：同样被 gate 拒绝
    const parent = await read<AgentResponse>(
      await post(app, "/api/test/agents", { name: "父根", kind: "runtime", status: "online" }),
    )
    expect(
      (await post(app, "/api/test/agents", {
        name: "子节点S",
        kind: "runtime",
        status: "online",
        parentId: parent.agent.id,
      })).status,
    ).toBe(200)
    await expectError(await post(app, "/api/test/shout", { from: "子节点S", body: "子节点发起" }), 403, "forbidden")

    // 零写入：无审批单（Forbidden 不落单）、无 shout 广播会话、无新增消息
    const after = await readDump(app)
    expect(after.approvals).toHaveLength(0)
    expect(where(after.conversations, "key", "shout")).toHaveLength(0)
    expect(after.messages).toEqual(before.messages)
  })

  it("建群 + 拉人：入群 system 通知（meta.action=group_add，0 wake job）；非成员拉人校验", async () => {
    const { app } = fixture()
    await seedBasic(app)
    const group = await read<ConversationResponse>(
      await post(app, "/api/test/conversations", { kind: "group", name: "拉人群", memberIds: ["乙"] }),
    )
    const groupId = group.conversation.id

    expect((await post(app, `/api/test/conversations/${groupId}/members`, { agentId: "丙" })).status).toBe(200)
    const dump = await readDump(app)
    expect(where(dump.participants, "conversation_id", groupId)).toHaveLength(3)

    const notice = one(
      where(dump.messages, "conversation_id", groupId).filter((message) => text(message, "kind") === "system"),
      "入群通知",
    )
    expect(meta(notice)["action"]).toBe("group_add")
    expect(text(notice, "from_agent_id")).toBe(humanIdFromDump(dump))
    // 入群通知经 postSystem：0 wake job（system 通知不唤醒）
    expect(where(dump.wakeJobs, "message_id", num(notice, "seq"))).toHaveLength(0)

    await expectError(
      await post(app, `/api/test/conversations/${groupId}/members`, { agentId: "查无此人" }),
      404,
      "agent_not_found",
    )
    await expectError(await post(app, `/api/test/conversations/${groupId}/members`, {}), 400, "invalid_body")
  })

  it("members/remove：写 meta.action=group_remove 的 system 消息，participants 行删除", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const jia = lookup(ids.agent, "甲", "甲")

    const response = await post(app, `/api/test/conversations/${groupId}/members/remove`, { agentId: "甲" })
    expect(response.status).toBe(200)
    expect(await read<{ ok: boolean }>(response)).toEqual({ ok: true })

    const dump = await readDump(app)
    expect(where(where(dump.participants, "conversation_id", groupId), "agent_id", jia)).toHaveLength(0)
    expect(where(dump.participants, "conversation_id", groupId)).toHaveLength(2)

    const notice = one(
      where(dump.messages, "conversation_id", groupId).filter((message) => text(message, "kind") === "system"),
      "移出通知",
    )
    expect(meta(notice)["action"]).toBe("group_remove")
    expect(meta(notice)["agentId"]).toBe(jia)
    expect(text(notice, "body")).toContain("已移出群")
    expect(where(dump.wakeJobs, "message_id", num(notice, "seq"))).toHaveLength(0)
  })

  it("members/remove 守卫：仅剩 1 人 409 / 非群 400 not_group / 不在群 404 not_in_group", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const dmId = lookup(ids.conversation, "dm1", "dm1").id

    // g1 = 乙(owner) + 甲 + 丙；依次移除 甲、丙 → 仅剩 乙
    for (const name of ["甲", "丙"]) {
      expect((await post(app, `/api/test/conversations/${groupId}/members/remove`, { agentId: name })).status).toBe(200)
    }
    const dumpAfter = await readDump(app)
    expect(where(dumpAfter.participants, "conversation_id", groupId)).toHaveLength(1)
    const messagesBefore = dumpAfter.messages.length

    await expectError(
      await post(app, `/api/test/conversations/${groupId}/members/remove`, { agentId: "乙" }),
      409,
      "cannot_remove_last_member",
    )
    const afterFail = await readDump(app)
    expect(where(afterFail.participants, "conversation_id", groupId)).toHaveLength(1) // 零写入
    expect(afterFail.messages).toHaveLength(messagesBefore) // 不落 system 消息

    // 非群会话
    await expectError(
      await post(app, `/api/test/conversations/${dmId}/members/remove`, { agentId: "甲" }),
      400,
      "not_group",
    )
    // 不在群里；解析不到的引用按原值透传 → 仍是 not_in_group（不另立错误码）
    const fresh = await read<ConversationResponse>(
      await post(app, "/api/test/conversations", { kind: "group", name: "多人群", memberIds: ["乙"] }),
    )
    expect((await post(app, "/api/test/agents", { name: "局外人", kind: "runtime", status: "online" })).status).toBe(200)
    for (const agentId of ["局外人", "谁也不是"]) {
      await expectError(
        await post(app, `/api/test/conversations/${fresh.conversation.id}/members/remove`, { agentId }),
        404,
        "not_in_group",
      )
    }
  })

  it("dissolve：先落 meta.action=group_dissolve 的 system 消息（触发器捕获），再级联清空；DM 400；未知 404", async () => {
    const { app, db } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const dmId = lookup(ids.conversation, "dm1", "dm1").id

    // 仅测试库加 SQLite AFTER DELETE 触发器，捕获被级联删除的 messages 行（生产代码零改动）
    db.exec(
      `CREATE TEMP TABLE captured_deleted (
         id TEXT, kind TEXT, meta TEXT, body TEXT, conversation_id TEXT
       );
       CREATE TEMP TRIGGER capture_message_delete AFTER DELETE ON messages BEGIN
         INSERT INTO captured_deleted (id, kind, meta, body, conversation_id)
         VALUES (OLD.id, OLD.kind, OLD.meta, OLD.body, OLD.conversation_id);
       END;`,
    )

    expect(where((await readDump(app)).messages, "conversation_id", groupId)).toHaveLength(2)

    const response = await post(app, `/api/test/conversations/${groupId}/dissolve`)
    expect(response.status).toBe(200)
    expect(await read<{ ok: boolean }>(response)).toEqual({ ok: true })

    const after = await readDump(app)
    expect(where(after.conversations, "id", groupId)).toHaveLength(0)
    expect(where(after.messages, "conversation_id", groupId)).toHaveLength(0)
    expect(where(after.participants, "conversation_id", groupId)).toHaveLength(0)
    expect(where(after.conversations, "id", dmId)).toHaveLength(1) // 其它会话不受影响

    const captured = db.prepare("SELECT * FROM captured_deleted").all() as Row[]
    expect(captured).toHaveLength(3) // 2 条既有消息 + 1 条解散通知
    const notices = captured.filter((row) => text(row, "kind") === "system")
    expect(notices).toHaveLength(1)
    const notice = one(notices, "解散通知（被级联删除前落库）")
    expect(meta(notice)["action"]).toBe("group_dissolve")
    expect(text(notice, "body")).toContain("已解散")

    await expectError(await post(app, `/api/test/conversations/${dmId}/dissolve`), 400, "not_group")
    await expectError(await post(app, "/api/test/conversations/没有这个群/dissolve"), 404, "conversation_not_found")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E2. P5 容器语义（测试面稳定码：不可入群 / 不可建群 / 不可发送 / 移除仍可清）
// ═══════════════════════════════════════════════════════════════════════════

describe("E2. P5 容器语义（/api/test/* 稳定码）", () => {
  /** 造一个分组容器节点（`role_tag='container'`，如实例节点）。 */
  async function seedContainer(app: App, name = "容器P5"): Promise<string> {
    const response = await post(app, "/api/test/agents", {
      name,
      kind: "runtime",
      status: "online",
      roleTag: "container",
    })
    expect(response.status).toBe(200)
    return (await read<AgentResponse>(response)).agent.id
  }

  it("拉容器入群 → 409 container_not_group_member（participants / messages 零写入）", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    await seedContainer(app)
    const before = await readDump(app)

    await expectError(
      await post(app, `/api/test/conversations/${groupId}/members`, { agentId: "容器P5" }),
      409,
      "container_not_group_member",
    )

    const after = await readDump(app)
    expect(after.participants).toEqual(before.participants)
    expect(after.messages).toEqual(before.messages) // 连入群 system 通知都不落
  })

  it("建群 memberIds 含容器 → 409 container_not_group_member（未建群）", async () => {
    const { app } = fixture()
    await seedBasic(app)
    await seedContainer(app)
    const before = await readDump(app)

    await expectError(
      await post(app, "/api/test/conversations", {
        kind: "group",
        name: "容器群",
        memberIds: ["容器P5"],
      }),
      409,
      "container_not_group_member",
    )
    expect((await readDump(app)).conversations).toEqual(before.conversations)
  })

  it("容器作发送方 → 409 container_cannot_send（会话消息与 shout 两径，零消息写入）", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const dmId = lookup(ids.conversation, "dm1", "dm1").id
    await seedContainer(app)
    const before = await readDump(app)

    await expectError(
      await post(app, `/api/test/conversations/${dmId}/messages`, {
        from: "容器P5",
        body: "我代表所有人发言",
      }),
      409,
      "container_cannot_send",
    )
    await expectError(
      await post(app, "/api/test/shout", { from: "容器P5", body: "全员注意" }),
      409,
      "container_cannot_send",
    )
    expect((await readDump(app)).messages).toEqual(before.messages)
  })

  it("seed 直造的历史容器成员仍可被移除：移除路径**不得**有容器守卫", async () => {
    const { app } = fixture()
    const seeded = await read<SeedResponse>(
      await post(app, "/api/test/seed", {
        agents: [
          { name: "历史容器", kind: "runtime", status: "online", roleTag: "container" },
          { name: "历史群主", kind: "runtime", status: "online" },
        ],
        conversations: [
          {
            kind: "group",
            name: "历史容器群",
            createdBy: "历史群主",
            memberIds: ["历史容器"],
            ref: "hg",
          },
        ],
      }),
    )
    const groupId = lookup(
      new Map(seeded.conversations.map((conversation) => [conversation.ref, conversation] as const)),
      "hg",
      "历史容器群",
    ).id
    expect(where((await readDump(app)).participants, "conversation_id", groupId)).toHaveLength(2)

    const removed = await post(app, `/api/test/conversations/${groupId}/members/remove`, {
      agentId: "历史容器",
    })

    expect(removed.status).toBe(200)
    expect(where((await readDump(app)).participants, "conversation_id", groupId)).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// F. 节点（agent）
// ═══════════════════════════════════════════════════════════════════════════

describe("F. 节点端点", () => {
  it("POST /api/test/agents：默认字段、重名 409、父未知 404、status=retired 400", async () => {
    const { app } = fixture()
    const response = await post(app, "/api/test/agents", { name: "节点A" })
    expect(response.status).toBe(200)
    const created = await read<AgentResponse>(response)
    expect(created.agent.name).toBe("节点A")
    expect(created.agent.kind).toBe("logical")
    expect(created.agent.status).toBe("online")
    expect(created.agent.vendor).toBe("opencode")
    expect(created.agent.model).toBe("—")

    const dump = await readDump(app)
    const row = one(where(dump.agents, "id", created.agent.id), "节点A 行")
    expect(text(row, "root_id")).toBe(created.agent.id) // 根 = 自身
    expect(row["parent_id"]).toBeNull()
    expect(row["custom_name"]).toBeNull()

    await expectError(await post(app, "/api/test/agents", { name: "节点A" }), 409, "name_taken")
    await expectError(
      await post(app, "/api/test/agents", { name: "子节点", parentId: "查无此人" }),
      404,
      "agent_not_found",
    )
    await expectError(
      await post(app, "/api/test/agents", { name: "退役出生", status: "retired" }),
      400,
      "invalid_body",
    )
    await expectError(await post(app, "/api/test/agents", { name: "" }), 400, "invalid_body")

    const list = await get(app, "/api/test/agents")
    expect(list.status).toBe(200)
    expect((await read<{ ok: boolean; agents: unknown[] }>(list)).agents).toHaveLength(1)
    expect((await readDump(app)).agents).toHaveLength(1)
  })

  it("PATCH /api/test/agents/:id：改名写 custom_name（系统名不变），重名 409，未知 404，非法 400", async () => {
    const { app } = fixture()
    const a = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "原名A" }))
    const b = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "原名B" }))
    const c = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "原名C" }))

    const renamed = await patch(app, `/api/test/agents/${a.agent.id}`, { name: "展示名A" })
    expect(renamed.status).toBe(200)
    expect(await read<RenameResponse>(renamed)).toEqual({ ok: true, name: "展示名A" })

    const dump = await readDump(app)
    const rowA = one(where(dump.agents, "id", a.agent.id), "A 行")
    expect(text(rowA, "custom_name")).toBe("展示名A")
    expect(text(rowA, "name")).toBe("原名A") // 系统名（身份）不动

    // 改回自身当前展示名 → 幂等放行
    expect((await patch(app, `/api/test/agents/${a.agent.id}`, { name: "展示名A" })).status).toBe(200)
    // 撞他人展示名 / 他人系统名 → 409
    await expectError(await patch(app, `/api/test/agents/${b.agent.id}`, { name: "展示名A" }), 409, "name_taken")
    await expectError(await patch(app, `/api/test/agents/${b.agent.id}`, { name: "原名C" }), 409, "name_taken")
    await expectError(await patch(app, "/api/test/agents/不存在", { name: "x" }), 404, "agent_not_found")
    for (const body of [{ name: "" }, { name: "   " }, {}, { name: "a".repeat(65) }, { name: "x\u0001y" }]) {
      await expectError(await patch(app, `/api/test/agents/${a.agent.id}`, body), 400, "invalid_body")
    }
    // 改名只写 custom_name：三个节点的系统名仍互不相同（c 的展示名未被改）
    const finalDump = await readDump(app)
    expect(finalDump.agents).toHaveLength(3)
    expect(one(where(finalDump.agents, "id", c.agent.id), "C 行")["custom_name"]).toBeNull()
  })

  it("DELETE ?mode=retire：status=retired 且行保留；缺省即 retire；未知 404；mode 非法 400", async () => {
    const { app } = fixture()
    const a = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "待退役" }))
    const response = await del(app, `/api/test/agents/${a.agent.id}?mode=retire`)
    expect(response.status).toBe(200)
    const retired = await read<RetireResponse>(response)
    expect(retired.mode).toBe("retire")
    expect(retired.agent.status).toBe("retired")

    const dump = await readDump(app)
    const row = one(where(dump.agents, "id", a.agent.id), "退役行")
    expect(text(row, "status")).toBe("retired")
    expect(row["retired_at"]).not.toBeNull()

    // 缺省 mode = retire
    const b = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "缺省退役" }))
    expect((await del(app, `/api/test/agents/${b.agent.id}`)).status).toBe(200)
    expect(text(one(where((await readDump(app)).agents, "id", b.agent.id), "缺省退役行"), "status")).toBe("retired")

    await expectError(await del(app, "/api/test/agents/不存在?mode=retire"), 404, "agent_not_found")
    await expectError(await del(app, `/api/test/agents/${b.agent.id}?mode=bogus`), 400, "invalid_body")
  })

  it("DELETE ?mode=hard：无引用（无消息/审批/自建会话）→ 直接 200；有消息且无 force → 409 agent_in_use（零写入）", async () => {
    const { app, db } = fixture()
    // 1) 无任何引用：不传 force 也直接删掉
    const lone = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "孤零零" }))
    const loneDelete = await del(app, `/api/test/agents/${lone.agent.id}?mode=hard`)
    expect(loneDelete.status).toBe(200)
    const loneReport = (await read<HardDeleteResponse>(loneDelete)).report
    expect(loneReport).toEqual({
      id: lone.agent.id,
      deletedConversations: 0,
      deletedMessages: 0,
      deletedApprovals: 0,
      deletedWakeJobs: 0,
      deletedParticipants: 0,
      deletedReadStates: 0,
      deletedKeys: 0,
      clearedInvites: 0,
    })
    expect(where((await readDump(app)).agents, "id", lone.agent.id)).toHaveLength(0)

    // 2) 有消息（且自建会话）→ 无 force 409
    const d = insertAgent(db, { name: "被引用", kind: "runtime", status: "online", vendor: "opencode" })
    const e = insertAgent(db, { name: "引用者", kind: "runtime", status: "online", vendor: "opencode" })
    const dm = await read<ConversationResponse>(
      await post(app, "/api/test/conversations", { kind: "dm", a: "被引用", b: "引用者" }),
    )
    await post(app, `/api/test/conversations/${dm.conversation.id}/messages`, { from: "被引用", body: "我发的" })
    const before = await readDump(app)

    const error = await expectError(await del(app, `/api/test/agents/${d.id}?mode=hard`), 409, "agent_in_use")
    expect(error.refs).toMatchObject({
      children: 0,
      messages: 1,
      approvals: 0,
      conversations: 1,
      participants: 1,
      readStates: 0,
      wakeJobs: 0,
      keys: 0,
    })
    expect(await readDump(app)).toEqual(before) // 失败路径零写入
    expect(where(before.agents, "id", e.id)).toHaveLength(1)

    await expectError(await del(app, "/api/test/agents/不存在?mode=hard&force=1"), 404, "agent_not_found")
  })

  it("硬删全流程：有子节点 409 agent_has_children（force 也不删），force 后无残留且 report 合 A 口径", async () => {
    const { app, db } = fixture()
    const d = insertAgent(db, { name: "D", kind: "runtime", status: "online", vendor: "opencode" })
    const e = insertAgent(db, { name: "E", kind: "runtime", status: "online", vendor: "opencode" })
    const f = insertAgent(db, { name: "F", kind: "runtime", status: "online", vendor: "opencode" })
    insertAgentKey(db, "hash-D", d.id)

    // 1) D 创建的 DM（created_by=D）——硬删时整体级联（含 E 的消息 → 计入 deletedMessages）
    const dm1 = await read<ConversationResponse>(
      await post(app, "/api/test/conversations", { kind: "dm", a: "D", b: "E" }),
    )
    // 2) 他人（E）创建的 DM，D 在其中留有消息（走 seed 直写，避开成员校验）
    const dm2 = await read<ConversationResponse>(
      await post(app, "/api/test/conversations", { kind: "dm", a: "E", b: "F" }),
    )
    // 3) 他人（E）创建的群，D 是成员；F 由 D 邀请（→ invited_by=D，删除时须置 NULL）
    const keepSeed = await read<SeedResponse>(
      await post(app, "/api/test/seed", {
        conversations: [{ kind: "group", name: "保活群", createdBy: "E", memberIds: ["D"], ref: "keep" }],
      }),
    )
    const keepId = lookup(
      new Map(keepSeed.conversations.map((conversation) => [conversation.ref, conversation] as const)),
      "keep",
      "保活群",
    ).id
    // 只写 participants 行（store 原语）：不走 core 的 applyAddParticipant，
    // 以免入群 system 通知（其 from = D）额外改变硬删的删除行数口径
    storeAddParticipant(db, { conversationId: keepId, agentId: f.id, invitedBy: d.id })

    const msgDE = await read<SendResponse>(
      await post(app, `/api/test/conversations/${dm1.conversation.id}/messages`, { from: "D", body: "D→E" }),
    )
    const msgED = await read<SendResponse>(
      await post(app, `/api/test/conversations/${dm1.conversation.id}/messages`, { from: "E", body: "E→D" }),
    )
    const seededMsg = await read<SeedResponse>(
      await post(app, "/api/test/seed", {
        messages: [{ conversationId: dm2.conversation.id, from: "D", body: "D 在他人会话" }],
      }),
    )
    const dInOther = seededMsg.messages[0]
    if (dInOther === undefined) throw new Error("seed 未返回消息")
    expect(enqueueWakeJobs(db, { messageId: dInOther.seq, recipientIds: [e.id] })).toBe(1)

    await post(app, `/api/test/conversations/${dm1.conversation.id}/read`, { agentId: "D" })
    await post(app, `/api/test/conversations/${dm1.conversation.id}/read`, { agentId: "E" })
    insertApproval(db, { requesterAgentId: d.id, action: "shout", payload: { body: "x" }, now: Date.now() })

    // 守卫 1：有子节点 → 409（force 也不删子节点）
    const child = await read<AgentResponse>(await post(app, "/api/test/agents", { name: "D子", parentId: "D" }))
    const beforeChildGuard = await readDump(app)
    const childrenError = await expectError(
      await del(app, `/api/test/agents/${d.id}?mode=hard&force=1`),
      409,
      "agent_has_children",
    )
    expect(childrenError.count).toBe(1)
    expect(await readDump(app)).toEqual(beforeChildGuard) // 零写入
    expect(where((await readDump(app)).agents, "id", child.agent.id)).toHaveLength(1)

    // 移除子节点后，硬删 D
    expect((await del(app, `/api/test/agents/${child.agent.id}?mode=hard&force=1`)).status).toBe(200)
    const before = await readDump(app)
    const response = await del(app, `/api/test/agents/${d.id}?mode=hard&force=1`)
    expect(response.status).toBe(200)
    const deleted = await read<HardDeleteResponse>(response)
    expect(deleted.mode).toBe("hard")

    const after = await readDump(app)
    // A 口径：report = 表级实际减少行数（含会话级联的副作用行）
    expect(deleted.report).toEqual({
      id: d.id,
      deletedConversations: before.conversations.length - after.conversations.length,
      deletedMessages: before.messages.length - after.messages.length,
      deletedApprovals: before.approvals.length - after.approvals.length,
      deletedWakeJobs: before.wakeJobs.length - after.wakeJobs.length,
      deletedParticipants: before.participants.length - after.participants.length,
      deletedReadStates: before.readStates.length - after.readStates.length,
      deletedKeys: before.agentKeys.length - after.agentKeys.length,
      clearedInvites: 1,
    })
    expect(deleted.report).toEqual({
      id: d.id,
      deletedConversations: 1,
      deletedMessages: 3, // dm1 的 2 条（含 E 的）+ D 在 dm2 的 1 条
      deletedApprovals: 1,
      deletedWakeJobs: 3,
      deletedParticipants: 3,
      deletedReadStates: 2,
      deletedKeys: 1,
      clearedInvites: 1,
    })

    // 无残留
    expect(where(after.agents, "id", d.id)).toHaveLength(0)
    expect(where(after.messages, "from_agent_id", d.id)).toHaveLength(0)
    expect(where(after.participants, "agent_id", d.id)).toHaveLength(0)
    expect(where(after.readStates, "agent_id", d.id)).toHaveLength(0)
    expect(where(after.agentKeys, "agent_id", d.id)).toHaveLength(0)
    expect(where(after.wakeJobs, "agent_id", d.id)).toHaveLength(0)
    expect(after.messages).toHaveLength(0) // 全部消息都属 D 的消息或其创建的会话
    expect(after.wakeJobs).toHaveLength(0)
    expect(after.approvals).toHaveLength(0)

    // 他人资产仍在
    expect(where(after.conversations, "id", dm2.conversation.id)).toHaveLength(1)
    expect(where(after.conversations, "id", keepId)).toHaveLength(1)
    expect(where(after.agents, "id", e.id)).toHaveLength(1)
    expect(where(after.agents, "id", f.id)).toHaveLength(1)
    // invited_by 置 NULL，行保留
    const fInvited = after.participants.filter(
      (participant) => participant["agent_id"] === f.id && participant["conversation_id"] === keepId,
    )
    expect(one(fInvited, "F 在保活群的成员行")["invited_by"]).toBeNull()
    expect(after.participants).toHaveLength(4)
    // 全局外键无残留：所有 job 都指向仍存在的消息
    const liveSeqs = new Set(after.messages.map((message) => num(message, "seq")))
    expect(after.wakeJobs.every((job) => liveSeqs.has(num(job, "message_id")))).toBe(true)
    // 被级联删除的 DM 里那两条消息的 job 也已消失
    expect(where(after.wakeJobs, "message_id", msgDE.message.seq)).toHaveLength(0)
    expect(where(after.wakeJobs, "message_id", msgED.message.seq)).toHaveLength(0)
    expect(where(after.messages, "seq", dInOther.seq)).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// G. reset
// ═══════════════════════════════════════════════════════════════════════════

describe("G. POST /api/test/reset", () => {
  it("confirm 精确 RESET → 200 且八表全空、引擎仍可用；其它 confirm → 400", async () => {
    const { app } = fixture()
    await seedBasic(app)
    expect((await readDump(app)).agents).toHaveLength(3)

    for (const body of [{ confirm: "reset" }, { confirm: "RESET " }, {}, { confirm: 1 }]) {
      await expectError(await post(app, "/api/test/reset", body), 400, "invalid_body")
    }
    const nonJson = await app.request("/api/test/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    await expectError(nonJson, 400, "invalid_body")
    expect((await readDump(app)).agents).toHaveLength(3) // 守卫失败零写入

    const response = await post(app, "/api/test/reset", { confirm: "RESET" })
    expect(response.status).toBe(200)
    expect(await read<{ ok: boolean }>(response)).toEqual({ ok: true })

    const cleared = await readDump(app)
    for (const table of [
      "agents",
      "conversations",
      "participants",
      "messages",
      "approvals",
      "wakeJobs",
      "readStates",
      "agentKeys",
    ] as const) {
      expect(cleared[table]).toHaveLength(0)
    }

    // 清后引擎仍可用：表结构已重建
    expect((await post(app, "/api/test/agents", { name: "复活" })).status).toBe(200)
    expect((await get(app, "/api/roster")).status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// H. 生产面回归
// ═══════════════════════════════════════════════════════════════════════════

describe("H. 生产面回归（T1 重构未改坏既有端点）", () => {
  it("/api/groups/*：404/400/409 三个码与测试面一致，成功路径写同一条 group_remove 通知", async () => {
    const { app } = fixture()
    const ids = await seedBasic(app)
    const groupId = lookup(ids.conversation, "g1", "g1").id
    const dmId = lookup(ids.conversation, "dm1", "dm1").id

    await expectError(
      await post(app, "/api/groups/没有这个群/members/remove", { agentId: "甲" }),
      404,
      "conversation_not_found",
    )
    await expectError(await post(app, `/api/groups/${dmId}/members/remove`, { agentId: "甲" }), 400, "not_group")
    await expectError(
      await post(app, `/api/groups/${groupId}/members/remove`, { agentId: "查无此人" }),
      404,
      "not_in_group",
    )
    await expectError(await post(app, `/api/groups/${groupId}/members/remove`, {}), 400, "invalid_body")

    // 单人生产群（human owner）→ 409
    const single = await read<GroupResponse>(await post(app, "/api/groups", { name: "单人生产群" }))
    await expectError(
      await post(app, `/api/groups/${single.group.id}/members/remove`, {
        agentId: humanIdFromDump(await readDump(app)),
      }),
      409,
      "cannot_remove_last_member",
    )

    // 生产端点只认 **agent id**：名字→id 的解析是测试面的便利（docs/test-api.md §3.3）。
    // 传系统名 → 原值透传 → 404 not_in_group（与测试面不同，属既有语义而非回归）
    await expectError(
      await post(app, `/api/groups/${groupId}/members/remove`, { agentId: "甲" }),
      404,
      "not_in_group",
    )
    expect(
      where((await readDump(app)).participants, "conversation_id", groupId),
    ).toHaveLength(3) // 未写入

    // 成功：与测试面同一实现 → 同一条 system 通知（按 id 传参）
    const jia = lookup(ids.agent, "甲", "agent 甲")
    const removed = await post(app, `/api/groups/${groupId}/members/remove`, { agentId: jia })
    expect(removed.status).toBe(200)
    expect(await read<{ ok: boolean }>(removed)).toEqual({ ok: true })
    const dump = await readDump(app)
    const notice = one(
      where(dump.messages, "conversation_id", groupId).filter((message) => text(message, "kind") === "system"),
      "生产端点移出通知",
    )
    expect(meta(notice)["action"]).toBe("group_remove")

    // dissolve：DM 400 / 未知 404 / 群 200 且级联清空
    await expectError(await post(app, `/api/groups/${dmId}/dissolve`), 400, "not_group")
    await expectError(await post(app, "/api/groups/没有这个群/dissolve"), 404, "conversation_not_found")
    expect((await post(app, `/api/groups/${groupId}/dissolve`)).status).toBe(200)
    const after = await readDump(app)
    expect(where(after.conversations, "id", groupId)).toHaveLength(0)
    expect(where(after.messages, "conversation_id", groupId)).toHaveLength(0)
    expect(where(after.participants, "conversation_id", groupId)).toHaveLength(0)
  })

  it("/api/admin/reset：非回环 403、confirm 非精确 400；回环成功清库且不删 DB 文件", async () => {
    const { home, db } = rawFixture()
    const off = createApp(db, { home, isLoopback: () => false, testApi: true })
    await expectError(await post(off, "/api/admin/reset", { confirm: "RESET" }), 403, "forbidden")
    expect((await get(off, "/api/admin/info")).status).toBe(403)

    const app = createApp(db, { home, isLoopback: () => true, testApi: true })
    await expectError(await post(app, "/api/admin/reset", { confirm: "reset" }), 400, "invalid_body")

    expect((await seedBasic(app)).seed.agents).toHaveLength(3)
    const response = await post(app, "/api/admin/reset", { confirm: "RESET" })
    expect(response.status).toBe(200)
    const body = await read<{ ok: boolean; restartRequired: boolean; snapshotPath: string }>(response)
    expect(body.ok).toBe(true)
    expect(body.restartRequired).toBe(true)
    rmSync(dirname(body.snapshotPath), { recursive: true, force: true }) // 清理 home 外的快照目录
    expect((await readDump(app)).agents).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I. 真机冒烟：真实 HTTP 服务（非 app.request）
// ═══════════════════════════════════════════════════════════════════════════

describe("I. 真机冒烟（start + 真实 socket fetch）", () => {
  it("开/关两个真实服务：ping/seed/dump/真实投递/删消息/硬删/404，关闭态 ping 404", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentchat-smoke-"))
    const db = openDb(join(home, "agentchat.db"))
    let server: RunningServer | undefined
    let offServer: RunningServer | undefined
    try {
      server = await start({ port: 0, db, home, testApi: true })
      const base = server.url

      const ping = await fetch(`${base}/api/test/ping`)
      expect(ping.status).toBe(200)
      expect(await ping.json()).toEqual({ ok: true, enabled: true })

      const seedResponse = await fetch(`${base}/api/test/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(basicSeedBody()),
      })
      expect(seedResponse.status).toBe(200)
      const seed = (await seedResponse.json()) as SeedResponse
      expect(seed.agents).toHaveLength(3)
      const agentIds = new Map(seed.agents.map((agent) => [agent.name, agent.id] as const))

      const dump1 = (await (await fetch(`${base}/api/test/dump`)).json()) as Dump
      expect(dump1.agents).toHaveLength(3)
      expect(dump1.messages).toHaveLength(4)
      expect(dump1.participants).toHaveLength(5)

      // 真实投递（乙 → 丙，同 DM）
      const dmResponse = await fetch(`${base}/api/test/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "dm", a: "乙", b: "丙" }),
      })
      const dm = (await dmResponse.json()) as ConversationResponse
      const sendResponse = await fetch(`${base}/api/test/conversations/${dm.conversation.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "乙", body: "冒烟投递" }),
      })
      expect(sendResponse.status).toBe(200)
      const sent = (await sendResponse.json()) as SendResponse

      const dump2 = (await (await fetch(`${base}/api/test/dump`)).json()) as Dump
      expect(dump2.messages).toHaveLength(5)
      expect(dump2.wakeJobs).toHaveLength(1)

      // 删单条消息（连带清 wake_jobs）
      expect((await fetch(`${base}/api/test/messages/${sent.message.id}`, { method: "DELETE" })).status).toBe(200)
      const dump3 = (await (await fetch(`${base}/api/test/dump`)).json()) as Dump
      expect(dump3.messages).toHaveLength(4)
      expect(dump3.wakeJobs).toHaveLength(0)

      // 硬删节点（force；甲 有消息 + 成员行，且它是自建会话的 created_by）
      const jia = lookup(agentIds, "甲", "agent 甲")
      const hardDelete = await fetch(`${base}/api/test/agents/${jia}?mode=hard&force=1`, { method: "DELETE" })
      expect(hardDelete.status).toBe(200)
      const hardBody = (await hardDelete.json()) as HardDeleteResponse
      expect(hardBody.mode).toBe("hard")
      expect(hardBody.report.deletedMessages).toBeGreaterThan(0)
      const dump4 = (await (await fetch(`${base}/api/test/dump`)).json()) as Dump
      expect(where(dump4.agents, "id", jia)).toHaveLength(0)

      // 未注册的测试子路径
      const missing = await fetch(`${base}/api/test/nope`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe("Not Found")

      await server.close()
      server = undefined

      // 默认关闭的真实服务：路径不存在，但生产端点照旧
      offServer = await start({ port: 0, db, home, testApi: false })
      const offPing = await fetch(`${offServer.url}/api/test/ping`)
      expect(offPing.status).toBe(404)
      expect(await offPing.text()).toBe("Not Found")
      expect((await fetch(`${offServer.url}/api/health`)).status).toBe(200)
      expect((await fetch(`${offServer.url}/api/roster`)).status).toBe(200)
    } finally {
      if (offServer !== undefined) await offServer.close()
      if (server !== undefined) await server.close()
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("MCP 会话确定性触发器（POST /api/test/mcp-sessions/clear，B 提出）", () => {
  it("默认无会话 → 200 {ok:true,cleared:0}；非回环 → 403（三重防线不变）", async () => {
    const { app } = fixture()
    const ok = await post(app, "/api/test/mcp-sessions/clear")
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, cleared: 0 })

    const { app: blocked } = fixture({ loopback: false })
    const forbidden = await post(blocked, "/api/test/mcp-sessions/clear")
    expect(forbidden.status).toBe(403)

    // 开关关闭时该路径根本不存在（404），与其它测试端点一致
    const { app: off } = fixture({ testApi: false })
    const missing = await post(off, "/api/test/mcp-sessions/clear")
    expect(missing.status).toBe(404)
  })
})
