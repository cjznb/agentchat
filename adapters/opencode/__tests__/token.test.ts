/**
 * `readToken` 单测（与 Claude 侧 `readTextWithRetry` **同构**）：
 *
 * `ENOENT` 不重试直接 `undefined`（未注册/无 token 保持既有静默语义）；`EPERM` 类瞬时错误有限重试；
 * 重试耗尽 → `undefined` 且日志含错误码；默认失败日志落 `<home>/logs/opencode-adapter.log`，且
 * `<home>/agents/x` 与 `<home>/hub_token` **两种路径布局**都能正确反推 `<home>`。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readToken } from "../token"

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-oc-token-"))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: fake fs error`) as NodeJS.ErrnoException
  error.code = code
  return error
}

function readLog(home: string): string {
  try {
    return readFileSync(join(home, "logs", "opencode-adapter.log"), "utf8")
  } catch {
    return ""
  }
}

describe("readToken 鲁棒性", () => {
  it("retries transient EPERM and returns the content (2 retries before success)", () => {
    const home = tempHome()
    let calls = 0
    const read = (): string => {
      calls += 1
      if (calls < 3) throw fsError("EPERM")
      return "agent-1\n"
    }
    expect(readToken(join(home, "agents", "opencode.id"), { read, delayMs: 0 })).toBe("agent-1")
    expect(calls).toBe(3)
    expect(readLog(home)).toBe("")
  })

  it("returns undefined and logs the error code after retries are exhausted", () => {
    const home = tempHome()
    let calls = 0
    const read = (): string => {
      calls += 1
      throw fsError("EACCES")
    }
    expect(readToken(join(home, "agents", "opencode.id"), { read, delayMs: 0 })).toBeUndefined()
    expect(calls).toBe(3)
    expect(readLog(home)).toContain("EACCES")
  })

  it("derives <home> from a hub_token path too (log never escapes to <home>/../logs)", () => {
    const home = tempHome()
    const read = (): string => {
      throw fsError("EPERM")
    }
    expect(readToken(join(home, "hub_token"), { read, delayMs: 0 })).toBeUndefined()
    expect(readLog(home)).toContain("EPERM")
  })

  it("does not retry on ENOENT", () => {
    const home = tempHome()
    let calls = 0
    const read = (): string => {
      calls += 1
      throw fsError("ENOENT")
    }
    expect(readToken(join(home, "agents", "opencode.token"), { read, delayMs: 0 })).toBeUndefined()
    expect(calls).toBe(1)
    expect(readLog(home)).toBe("")
  })

  it("uses an injected log sink instead of the file when provided", () => {
    const home = tempHome()
    const logged: string[] = []
    const read = (): string => {
      throw fsError("EBUSY")
    }
    expect(
      readToken(join(home, "agents", "opencode.id"), { read, delayMs: 0, log: (message) => logged.push(message) }),
    ).toBeUndefined()
    expect(logged.some((message) => message.includes("EBUSY"))).toBe(true)
    expect(readLog(home)).toBe("")
  })

  it("reads a real file through the default reader and treats blank as undefined", () => {
    const home = tempHome()
    const path = join(home, "agents", "opencode.token")
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(path, "jt-1\n")
    expect(readToken(path)).toBe("jt-1")
    writeFileSync(path, "   \n")
    expect(readToken(path)).toBeUndefined()
  })
})
