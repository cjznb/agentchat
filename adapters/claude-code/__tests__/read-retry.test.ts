/**
 * `readTextWithRetry` 单测 —— 锁定 flake 根因修复：
 *
 * 旧 `readText` 把**一切异常**（含 Windows Defender 瞬时扫描导致的 `EPERM`/`EACCES`）与
 * 「未注册」混为一谈 → 读 `<home>/agents/claude-code.id` 瞬时失败即静默 `skip`，**丢弃一次投递**。
 *
 * 断言新语义：`ENOENT` 不重试直接 `undefined`（保持未注册静默）；其它错误有限重试；
 * 重试耗尽 → `undefined` 且日志含错误码。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// 直接 import 生产 `.mjs`（与 hook 同源；vitest/Vite 原生支持 ESM）
import { readTextWithRetry } from "../token.mjs"
import { cleanupHomes, readLog, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: fake fs error`) as NodeJS.ErrnoException
  error.code = code
  return error
}

function agentIdPath(home: string): string {
  return join(home, "agents", "claude-code.id")
}

describe("readTextWithRetry（瞬时 fs 错误鲁棒性）", () => {
  it("retries transient EPERM and returns the content (2 retries before success)", () => {
    const home = tempHome()
    let calls = 0
    const read = (): string => {
      calls += 1
      if (calls < 3) throw fsError("EPERM")
      return "agent-root\n"
    }
    expect(readTextWithRetry(agentIdPath(home), { read, delayMs: 0 })).toBe("agent-root")
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
    expect(readTextWithRetry(agentIdPath(home), { read, delayMs: 0 })).toBeUndefined()
    expect(calls).toBe(3)
    const log = readLog(home)
    expect(log).toContain("EACCES")
    expect(log).toContain("claude-code.id")
  })

  it("does not retry on ENOENT (unregistered stays a silent skip)", () => {
    const home = tempHome()
    let calls = 0
    const read = (): string => {
      calls += 1
      throw fsError("ENOENT")
    }
    expect(readTextWithRetry(agentIdPath(home), { read, delayMs: 0 })).toBeUndefined()
    expect(calls).toBe(1)
    expect(readLog(home)).toBe("")
  })

  it("treats blank content as undefined", () => {
    const home = tempHome()
    expect(readTextWithRetry(agentIdPath(home), { read: () => " \n", delayMs: 0 })).toBeUndefined()
  })

  it("reads a real file through the default reader (production path)", () => {
    const home = tempHome()
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(agentIdPath(home), "agent-root\n")
    expect(readTextWithRetry(agentIdPath(home))).toBe("agent-root")
  })
})
