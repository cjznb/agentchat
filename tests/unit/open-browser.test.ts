/**
 * `server/open-browser.ts` 单测：
 * - `browserCommand` 纯决策矩阵（三平台 × 两个守卫）——不触达真实进程；
 * - `openBrowser` 副作用：`detached + stdio:ignore + unref`，失败仅 warn 一次。
 * 本文件 mock `node:child_process` 的 `spawn`，不会真的打开浏览器。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { spawnMock, onceMock, unrefMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  onceMock: vi.fn(),
  unrefMock: vi.fn(),
}))

vi.mock("node:child_process", () => ({ spawn: spawnMock }))

import { browserCommand, openBrowser } from "../../server/open-browser"

const URL = "http://localhost:4646"

describe("browserCommand（纯决策）", () => {
  const allowed = { openBrowser: true, isTTY: true }

  it("builds the win32 command with an empty window title", () => {
    expect(browserCommand({ platform: "win32", url: URL, ...allowed })).toEqual({
      command: "cmd",
      args: ["/c", "start", "", URL],
    })
  })

  it("builds the darwin command", () => {
    expect(browserCommand({ platform: "darwin", url: URL, ...allowed })).toEqual({
      command: "open",
      args: [URL],
    })
  })

  it("falls back to xdg-open for linux and other platforms", () => {
    expect(browserCommand({ platform: "linux", url: URL, ...allowed })).toEqual({
      command: "xdg-open",
      args: [URL],
    })
    expect(browserCommand({ platform: "freebsd", url: URL, ...allowed })).toEqual({
      command: "xdg-open",
      args: [URL],
    })
  })

  it("returns undefined when the guard blocks (platform × guard matrix)", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(browserCommand({ platform, url: URL, openBrowser: false, isTTY: true })).toBeUndefined()
      expect(browserCommand({ platform, url: URL, openBrowser: true, isTTY: false })).toBeUndefined()
      expect(browserCommand({ platform, url: URL, openBrowser: false, isTTY: false })).toBeUndefined()
    }
  })
})

describe("openBrowser（副作用）", () => {
  beforeEach(() => {
    spawnMock.mockReset()
    onceMock.mockReset()
    unrefMock.mockReset()
    spawnMock.mockReturnValue({ once: onceMock, unref: unrefMock })
  })

  it("spawns detached, ignores stdio, and unrefs", () => {
    openBrowser({ command: "xdg-open", args: [URL] })
    expect(spawnMock).toHaveBeenCalledWith("xdg-open", [URL], { detached: true, stdio: "ignore" })
    expect(unrefMock).toHaveBeenCalledTimes(1)
    expect(onceMock).toHaveBeenCalledWith("error", expect.any(Function))
  })

  it("warns exactly once on an async error event, without throwing", () => {
    const warn = vi.fn()
    openBrowser({ command: "xdg-open", args: [URL] }, warn)
    const handler = onceMock.mock.calls[0]?.[1]
    handler?.(new Error("spawn xdg-open ENOENT"))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("自动打开浏览器失败")
    expect(warn.mock.calls[0]?.[0]).toContain("不影响 Hub 运行")
  })

  it("warns exactly once when spawn throws synchronously", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("boom")
    })
    const warn = vi.fn()
    expect(() => openBrowser({ command: "open", args: [URL] }, warn)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("boom")
  })
})
