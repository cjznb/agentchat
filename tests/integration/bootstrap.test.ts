/**
 * C1 —— 生产启动入口测试（brief 必修项）：
 * `bootstrap({port:0, home:临时})` 必须同时拉起 HTTP 服务与 dispatcher（否则审批过期清扫、
 * 每日备份、唤醒循环在生产中永不发生）；`GET /api/health` 200；关停后 dispatcher 停止、
 * 端口释放、DB 句柄关闭（无泄漏）。dispatcher 不在 `start()`/`createApp()` 内部。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { clearAdapters } from "../../server/adapters/types"
import { openDb } from "../../server/db"
import { bootstrap, type HubHandle } from "../../server/main"
import { insertAgent } from "../../server/store/agents"
import { sendMessage } from "../../server/core/messaging"

describe("bootstrap 生产入口（C1）", () => {
  let home = ""
  let handle: HubHandle | undefined
  const extras: string[] = []
  /** 测试统一静音启动警告（专测见下方用例）；不改生产行为。 */
  const quiet = (): void => {}

  afterEach(async () => {
    clearAdapters()
    await handle?.close()
    handle = undefined
    if (home !== "") rmSync(home, { recursive: true, force: true })
    for (const extra of extras.splice(0)) rmSync(extra, { recursive: true, force: true })
  })

  it("starts the dispatcher, serves GET /api/health, then shuts down cleanly", async () => {
    home = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    handle = await bootstrap({ port: 0, home, log: quiet })

    // dispatcher 在真实运行中被拉起（C1 核心）
    expect(handle.dispatcher).toBeDefined()
    expect(handle.dispatcher?.isRunning).toBe(true)

    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })

    await handle.close()
    // 关停：dispatcher 停、重复 close 幂等
    expect(handle.dispatcher?.isRunning).toBe(false)
    await expect(handle.close()).resolves.toBeUndefined()
  })

  it("skips the dispatcher when asked, without breaking the HTTP surface", async () => {
    home = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    handle = await bootstrap({ port: 0, home, startDispatcher: false, log: quiet })

    expect(handle.dispatcher).toBeUndefined()
    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(200)
  })

  it("warns only when adapters are empty AND an eligible job has no adapter", async () => {
    clearAdapters() // 隔离：更早用例可能已按开发者真实 config.json 注册过适配器（进程级注册表）
    const warnings: string[] = []
    const collect = (message: string): void => void warnings.push(message)
    const warns = (): string[] => warnings.filter((message) => message.includes("有界退避重试"))

    // ① 无适配器、无合格 job → 不输出警告
    home = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    ;(await bootstrap({ port: 0, home, startDispatcher: false, adapters: [], log: collect })).close()
    expect(warns()).toHaveLength(0)

    // ② 无适配器 + 存在「收件方 vendor 无适配器」的到期 pending job → 精确警告一次
    const withJob = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    extras.push(withJob)
    const db = openDb(join(withJob, "agentchat.db"))
    const sender = insertAgent(db, { name: "warn-sender", kind: "runtime", status: "online", vendor: "opencode" })
    const node = insertAgent(db, { name: "warn-node", kind: "runtime", status: "online", vendor: "opencode" })
    sendMessage(db, { from: sender.id, to: node.id, body: "待投递" })
    db.prepare("UPDATE wake_jobs SET retry_at = 0").run() // 使 job 立即到期
    await (
      await bootstrap({ port: 0, home: withJob, db, startDispatcher: false, adapters: [], log: collect })
    ).close()
    db.close()

    const emitted = warns()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain("AGENTCHAT_ADAPTERS") // 提示可声明处
    expect(emitted[0]).toContain("config.json")
    expect(emitted[0]).not.toContain("不会被投递") // 旧文案的错误后果必须消失
    expect(emitted[0]).not.toContain("排队中")

    // ③ 有适配器 → 不新增警告
    const withAdapters = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    extras.push(withAdapters)
    await (
      await bootstrap({
        port: 0,
        home: withAdapters,
        startDispatcher: false,
        adapters: ["opencode"],
        log: collect,
      })
    ).close()
    expect(warns()).toHaveLength(1)
  })
})
