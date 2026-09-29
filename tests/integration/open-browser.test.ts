/**
 * 回归：`bootstrap()` 路径**不会**打开浏览器——自动开浏览器的副作用只在 `server/main.ts`
 * 的真实执行入口（`runForeground`）触发，测试 import/调用 `bootstrap` 不得弹窗。
 * 手法：mock `node:child_process` 的 `spawn`，跑真实 bootstrap 后断言 `spawn` 从未被调用。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: spawnMock }
})

import { bootstrap, type HubHandle } from "../../server/main"

describe("bootstrap 不触发开浏览器", () => {
  let home = ""
  let handle: HubHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
    if (home !== "") rmSync(home, { recursive: true, force: true })
    spawnMock.mockClear()
  })

  it("serves HTTP without spawning a browser process", async () => {
    home = mkdtempSync(join(tmpdir(), "agentchat-no-browser-"))
    handle = await bootstrap({ port: 0, home, startDispatcher: false, log: () => {} })

    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(200)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
