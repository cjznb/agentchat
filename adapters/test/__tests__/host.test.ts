/**
 * 测试适配器 C：vitest 自动化（`adapters/test/__tests__/host.test.ts`）。
 *
 * **进程内真 Hub**（`server/index.ts` 的 `start({port:0})`）+ 一次性临时 `AGENTCHAT_HOME`，
 * 客户端是 `../lib/host.mjs` 的无头假宿主（复用 dsh 真 `hub/flush/poll/mcp`，只替换"注入宿主"一步）。
 * **不依赖任何真实 LLM / DSH**：会话注册走 MCP `register`，消息走真实 core 编排，回执走真 `wake_jobs`。
 *
 * 两层断言（互相印证）：
 * 1. 逐场景跑 `../lib/scenarios.mjs`（与 CLI **同一份**口径），任一条 `✘` 即失败；
 * 2. 关键口径再写**显式断言**（排队→送达、group 未 flush 无回执、busy 只能等、refused 不写 seen、
 *    offline 是否建 job、states 的 409 口径），防止"场景库整体写错但自洽"。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearAdapters } from "../../../server/adapters/types"
import { openDb, type Db } from "../../../server/db"
import { start, type RunningServer } from "../../../server/index"
import { ensureHubToken } from "../../../server/routes/internal"
import { createTestHost } from "../lib/host.mjs"
import { createReporter } from "../lib/report.mjs"
import { SCENARIOS, SCENARIO_NAMES } from "../lib/scenarios.mjs"

type ScenarioName = keyof typeof SCENARIOS
type TestHost = ReturnType<typeof createTestHost>

let home = ""
let db: Db
let server: RunningServer
const hosts: TestHost[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentchat-t6-"))
  db = openDb(join(home, "agentchat.db"))
  // 适配器注册表是**进程级单例**：逐用例清空，避免某 vendor 的 pull 占位跨用例渗漏。
  clearAdapters()
  // 与路由同一个 `ensureHubToken`：token 先落盘，Hub 与客户端才会用同一张票（Hub 侧是惰性创建）。
  ensureHubToken(join(home, "hub_token"))
  // 显式注入 home / hubTokenPath / testApi：`config` 是导入期求值的单例，不能靠事后改 env。
  server = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token"), testApi: true })
})

afterEach(async () => {
  for (const host of hosts.splice(0)) host.close()
  await server.close()
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 新建无头假宿主（绑到本用例的进程内 Hub；`afterEach` 统一 close）。 */
function makeHost(namePrefix: string): TestHost {
  const host = createTestHost({ home, baseUrl: server.url, namePrefix })
  hosts.push(host)
  return host
}

/** 建实例根 + 若干 runtime 会话（默认挂实例根下，registerChild 落 online）。 */
async function makeSessions(host: TestHost, taskRefs: string[]) {
  // 根名交给 host 自动生成（带 host 前缀 + 序号）：同一用例内可安全建多台假宿主。
  await host.registerRoot({})
  const sessions: Record<string, { agentId: string }> = {}
  for (const taskRef of taskRefs) {
    sessions[taskRef] = await host.registerSession({ taskRef, name: taskRef })
  }
  return sessions
}

describe("场景库逐条跑（与 CLI 同一口径）", () => {
  const names = SCENARIO_NAMES as readonly ScenarioName[]
  for (const name of names) {
    it(`${name}：全部检查通过`, async () => {
      const report = createReporter({ out: (line) => console.log(line) })
      const host = makeHost(`t-${name}`)
      await SCENARIOS[name]({
        host,
        report,
        // holdMs 收窄观察窗（口径不变）；pollMs 为真 IdlePoller 间隔；
        // lease 用注入的"推过租约"替代 30s 真实等待。
        args: { holdMs: 150, pollMs: 200, leaseWaitMs: 0 },
        advanceLease: () => {
          // 推过在途租约：把 retry_at 改到"早已过期"（-60s，远大于任何跨进程时钟偏斜）。
          db.prepare("UPDATE wake_jobs SET retry_at = ? WHERE state = 'sending'").run(Date.now() - 60_000)
        },
      })
      report.table(`场景 ${name} 状态迁移表`)
      const failed = report.checks.filter((check) => !check.ok)
      expect(failed, `场景 ${name} 未通过的检查`).toEqual([])
    }, 30_000)
  }
})

describe("关键口径（显式断言）", () => {
  it("dm：pending 排队 → 真 flush 后 accepted/delivered，二次 flush 不重复注入", async () => {
    const host = makeHost("x-dm")
    const sessions = await makeSessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "hi" })
    expect(sent.receipts).toEqual([{ agentId: b.agentId, stage: "queued" }])
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({
      state: "pending",
      pending_reason: null,
    })
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect(host.injectedIdsOf(b.agentId)).toEqual([sent.message.id])
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe(
      "delivered",
    )
    await host.flush(b.agentId, b.agentId)
    expect(host.deliveries).toHaveLength(1)
    await host.ack("b", [sent.message.id])
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe("read")
    expect(a.agentId).not.toBe(b.agentId)
  })

  it("group：未 flush 的成员一直 queued/pending（用户报「有人收不到提醒」的结构性证据）", async () => {
    const host = makeHost("x-group")
    const sessions = await makeSessions(host, ["a", "b", "c", "d"])
    const group = await host.createGroup("g", ["a", "b", "c", "d"].map((key) => sessions[key]!.agentId))
    const sent = await host.send("a", { to: group.conversation.id, body: "@* g", mentions: ["*"] })
    const jobs = (await host.dump()).wakeJobs.filter((job) => job.message_id === sent.message.seq)
    expect(jobs).toHaveLength(3)
    await host.flush(sessions["b"]!.agentId, sessions["b"]!.agentId)
    await host.flush(sessions["c"]!.agentId, sessions["c"]!.agentId)
    expect(host.deliveries.map((entry) => entry.nodeId)).toEqual([
      sessions["b"]!.agentId,
      sessions["c"]!.agentId,
    ])
    expect(await host.jobOf(sent.message.seq, sessions["d"]!.agentId)).toMatchObject({ state: "pending" })
    const stages = await host.receiptsOf([sent.message.id], "a")
    expect(stages.get(`${sent.message.id}:${sessions["d"]!.agentId}`)).toBe("queued")
    await host.flush(sessions["d"]!.agentId, sessions["d"]!.agentId)
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${sessions["d"]!.agentId}`)).toBe(
      "delivered",
    )
  })

  it("busy：pending_reason='busy' 且零注入；idle 后才送达（打印时间差）", async () => {
    const host = makeHost("x-busy")
    const sessions = await makeSessions(host, ["a", "b"])
    const b = sessions["b"]!
    await host.setState(b.agentId, "busy")
    const t0 = Date.now()
    const sent = await host.send("a", { to: b.agentId, body: "busy" })
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({
      state: "pending",
      pending_reason: "busy",
    })
    await sleep(150)
    const held = await host.jobOf(sent.message.seq, b.agentId)
    expect({ state: held?.state, reason: held?.pending_reason }).toEqual({ state: "pending", reason: "busy" })
    expect(host.deliveries).toHaveLength(0)
    const tIdle = Date.now()
    expect((await host.setState(b.agentId, "idle")).status).toBe(200)
    await host.flush(b.agentId, b.agentId)
    const tDone = Date.now()
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    console.log(
      `[busy] send→(观察 150ms)→idle ${tIdle - t0}ms 全程 pending；idle→送达 ${tDone - tIdle}ms；净 ${tDone - t0}ms`,
    )
  })

  it("refused：不写 seen（再 flush 仍重投），达 REFUSAL_LIMIT 转终态", async () => {
    const host = makeHost("x-refused")
    const sessions = await makeSessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "no" })
    host.deliver.refuseNext(1)
    await host.flush(b.agentId, b.agentId)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "pending" })
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe("queued")
    host.deliver.refuseNext(1)
    await host.flush(b.agentId, b.agentId)
    expect(host.injectionsOf(b.agentId)).toHaveLength(2)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "refused" })
    await host.flush(b.agentId, b.agentId)
    expect(host.injectionsOf(b.agentId)).toHaveLength(2)
  })

  it("offline：runtime 收件方 offline 仍建 pending job；回 online + flush 补投", async () => {
    const host = makeHost("x-offline")
    await host.registerRoot({ name: "root" })
    const a = await host.registerSession({ taskRef: "a", name: "a" })
    // 子节点不可 offline（409）→ 用"不挂父的 runtime 根"承载 offline。
    const b = await host.registerSession({ taskRef: "b", name: "b", parentRef: null })
    expect((await host.setState(b.agentId, "offline")).status).toBe(200)
    const sent = await host.send("a", { to: b.agentId, body: "off" })
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({
      state: "pending",
      pending_reason: null,
    })
    expect(host.deliveries).toHaveLength(0)
    expect((await host.setState(b.agentId, "online")).status).toBe(200)
    await host.flush(b.agentId, b.agentId)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect(a.agentId).not.toBe(b.agentId)
  })

  it("states：idle 落库 online；子节点 offline 409 child_never_offline；根 offline 200", async () => {
    const host = makeHost("x-states")
    const sessions = await makeSessions(host, ["s"])
    const s = sessions["s"]!
    const root = host.root!
    expect((await host.setState(s.agentId, "online")).status).toBe(200)
    expect((await host.setState(s.agentId, "busy")).status).toBe(200)
    expect((await host.setState(s.agentId, "idle")).status).toBe(200)
    const dump = await host.dump()
    expect(dump.agents.find((agent) => agent.id === s.agentId)?.status).toBe("online")
    const child = await host.setState(s.agentId, "offline")
    expect({ status: child.status, error: child.error }).toEqual({
      status: 409,
      error: "child_never_offline",
    })
    expect((await host.setState(root.agentId, "offline")).status).toBe(200)
    expect((await host.dump()).agents.find((agent) => agent.id === root.agentId)?.status).toBe("offline")
  })
})

/**
 * **P1/task-7 已修**（原缺陷：`adapters/dsh/index.js` 的 `seen` 全局共享 → 同一实例内第二个收件方
 * 被判"已注入"，只补 `delivered` 回执而不注入正文 = 假投递）。
 *
 * 修复形态：`index.js` 改为按**收件方**（Hub 会话节点 id）各持一份 `seen` 视图
 * （`flushFor(nodeId)` + 每节点一个 `createIdleFlush`），语义等价 `${nodeId}:${messageId}`；
 * `lib/flush.js` 未改（与 opencode 共用同一闭环）。本适配器 `host.flush` 早先就按 nodeId 分实例，
 * 故现在与真适配器**同语义**。
 *
 * 本用例锁住修复后的语义：同一条消息对两个收件方都有 job → **两者各注入一次**；
 * 未注入方在真正注入前**不得**出现 `delivered` 回执。
 */
describe("P1/task-7 已修（原为共享 seen 假投递）：seen 按收件方分键", () => {
  it("同一条消息两个收件方各注入一次；未注入方不得假 delivered", async () => {
    const host = makeHost("p1-seen")
    const sessions = await makeSessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const group = await host.createGroup("g", [a.agentId, b.agentId])
    const sent = await host.sendAsHuman(group.conversation.id, "同一条群消息")

    await host.flush(a.agentId, a.agentId)
    // 未注入方（B）此刻必须仍是"排队"：不得因 A 注入过就假报 delivered。
    expect(host.injectedIdsOf(b.agentId)).toEqual([])
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "pending" })
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe("queued")

    await host.flush(b.agentId, b.agentId)
    expect(host.injectedIdsOf(a.agentId)).toEqual([sent.message.id])
    expect(host.injectedIdsOf(b.agentId)).toEqual([sent.message.id])
    const stages = await host.receiptsOf([sent.message.id], "a")
    expect({
      a: stages.get(`${sent.message.id}:${a.agentId}`),
      b: stages.get(`${sent.message.id}:${b.agentId}`),
    }).toEqual({ a: "delivered", b: "delivered" })
  })
})
