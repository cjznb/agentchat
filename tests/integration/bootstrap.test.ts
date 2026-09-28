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
import { bootstrap, type HubHandle } from "../../server/main"

describe("bootstrap 生产入口（C1）", () => {
  let home = ""
  let handle: HubHandle | undefined
  const extras: string[] = []
  /** 测试统一静音启动警告（专测见下方用例）；不改生产行为。 */
  const quiet = (): void => {}

  afterEach(async () => {
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

  it("warns once when no adapters are configured, and stays silent when some are", async () => {
    const warnings: string[] = []
    const collect = (message: string): void => void warnings.push(message)

    home = mkdtempSync(join(tmpdir(), "agentchat-bootstrap-"))
    ;(await bootstrap({ port: 0, home, startDispatcher: false, log: collect })).close()

    const afterEmpty = warnings.filter((message) => message.includes("AGENTCHAT_ADAPTERS"))
    expect(afterEmpty).toHaveLength(1)
    expect(afterEmpty[0]).toContain("排队中")
    expect(afterEmpty[0]).toContain("$env:AGENTCHAT_ADAPTERS") // Windows 示例
    expect(afterEmpty[0]).toContain("AGENTCHAT_ADAPTERS=opencode") // POSIX 示例

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

    expect(warnings.filter((message) => message.includes("AGENTCHAT_ADAPTERS"))).toHaveLength(1)
  })
})
