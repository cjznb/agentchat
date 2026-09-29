/**
 * Claude Code 适配器 `appendLog` 轮转单测（真子进程，生产同构）：
 * 日志在**下一次追加前**超过 1 MiB 时整体改名 `<log>.1`（覆盖旧 `.1`，只保留一份），
 * 主文件重置为新行；路径 / `<ISO> <message>` 格式 / 失败静默语义保持不变。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupHomes, runHook, tempHome } from "./hook-harness"

afterEach(() => cleanupHomes())

describe("appendLog 轮转", () => {
  it("rotates a >1MiB log to <log>.1 before the next append and keeps only one rotated copy", async () => {
    const home = tempHome()
    const logFile = join(home, "logs", "claude-code-adapter.log")
    const rotatedFile = `${logFile}.1`
    mkdirSync(join(home, "logs"), { recursive: true })
    const filler = "old-log-line ".repeat(90_000) // ≈1.17 MiB > 1 MiB
    expect(Buffer.byteLength(filler)).toBeGreaterThan(1024 * 1024)
    writeFileSync(logFile, filler)

    // busy 在缺 HUB_TOKEN 时仅记日志并以 0 退出 → 触发一次 appendLog（阈值为生产默认 1 MiB）。
    const run = await runHook("busy", {}, { AGENTCHAT_HOME: home, HUB_TOKEN: "" })
    expect(run.code).toBe(0)

    expect(existsSync(rotatedFile)).toBe(true)
    expect(readFileSync(rotatedFile, "utf8")).toBe(filler)
    const current = readFileSync(logFile, "utf8")
    expect(current).not.toContain("old-log-line")
    expect(current).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ busy: HUB_TOKEN missing; skip\n$/)
  })
})
