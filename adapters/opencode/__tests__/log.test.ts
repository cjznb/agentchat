/**
 * OpenCode 适配器日志单测：默认日志**落文件**（`<AGENTCHAT_HOME>/logs/opencode-adapter.log`，
 * 绝不碰宿主 console/stderr）、超阈值轮转到 `.1`（只保留一份）、`AGENTCHAT_LOG=console` 调试回退、
 * 路径不可写时静默，以及**插件失败路径不泄露 hub_token / join_token 值**（硬要求）。
 *
 * 隔离：一律用临时 `AGENTCHAT_HOME`，绝不触碰用户真实 `~/.agentchat`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileLog } from "../log"
import { createPluginHandle, type PluginDeps, type PluginHandle } from "../plugin"
import type { OpencodeClient, OpencodeEvent, PluginInput } from "../types"

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-oc-log-"))
  homes.push(home)
  return home
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function logPath(home: string): string {
  return join(home, "logs", "opencode-adapter.log")
}

function spyHostConsole(): { readonly error: ReturnType<typeof vi.spyOn>; readonly log: ReturnType<typeof vi.spyOn> } {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  }
}

describe("createFileLog 默认落文件", () => {
  it("appends <ISO> [tag] lines under <home>/logs/opencode-adapter.log and never calls the host console", () => {
    const home = tempHome()
    const spies = spyHostConsole()
    const write = createFileLog({ AGENTCHAT_HOME: home }, "plugin")

    write("hello world")
    write("second line")

    const lines = readFileSync(logPath(home), "utf8").split("\n").filter((line) => line !== "")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[plugin\] hello world$/)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[plugin\] second line$/)
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.log).not.toHaveBeenCalled()
  })

  it("rotates to <file>.1 past the injected threshold and keeps only one rotated copy", () => {
    const home = tempHome()
    const write = createFileLog({ AGENTCHAT_HOME: home }, "plugin", 64)

    write("A".repeat(100)) // 写前无文件 → 不轮转，但本行已超阈值
    expect(existsSync(`${logPath(home)}.1`)).toBe(false)

    write("after-rotate") // 写前 >64 → 旧内容整体改名为 `.1`，主文件重置
    expect(readFileSync(`${logPath(home)}.1`, "utf8")).toContain("A".repeat(100))
    const current = readFileSync(logPath(home), "utf8")
    expect(current).toContain("[plugin] after-rotate")
    expect(current).not.toContain("A".repeat(100))

    write("B".repeat(100)) // 主文件再次超阈值
    write("third") // → 覆盖旧 `.1`（只保留一份）
    const rotated = readFileSync(`${logPath(home)}.1`, "utf8")
    expect(rotated).toContain("B".repeat(100))
    expect(rotated).toContain("after-rotate")
    expect(rotated).not.toContain("A".repeat(100))
  })

  it("routes to console.error (stderr) instead of the file when AGENTCHAT_LOG=console", () => {
    const home = tempHome()
    const spies = spyHostConsole()
    const write = createFileLog({ AGENTCHAT_HOME: home, AGENTCHAT_LOG: "console" }, "plugin")

    write("console-mode probe")

    expect(spies.error).toHaveBeenCalledTimes(1)
    expect(spies.error.mock.calls[0]?.[0]).toMatch(/\[plugin\] console-mode probe$/)
    expect(existsSync(logPath(home))).toBe(false)
  })

  it("stays silent when the log path cannot be written (log failure must not affect the host)", () => {
    const blocker = join(tempHome(), "blocker")
    writeFileSync(blocker, "a plain file, not a directory")
    const spies = spyHostConsole()
    const write = createFileLog({ AGENTCHAT_HOME: join(blocker, "home") }, "plugin")

    expect(() => write("cannot be written")).not.toThrow()
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.log).not.toHaveBeenCalled()
  })
})

// ── 插件集成：默认 log（deps.log 未注入）──

/** 最小宿主 client：本组测试只走 `session.created`（根），list 供启动枚举用。 */
function stubClient(): OpencodeClient {
  return {
    session: {
      promptAsync: async () => undefined,
      list: async () => [],
      get: async () => undefined,
    },
  }
}

/** 一切 HTTP 都连不上（确定性失败路径，配合注入的即时 sleep 快速耗尽重试）。 */
const unreachableFetch: typeof fetch = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:9")
}

async function emitRootSession(handle: PluginHandle): Promise<void> {
  const input: PluginInput = { client: stubClient(), directory: "/", worktree: "/" }
  const hooks = await handle.plugin(input)
  const event: OpencodeEvent = {
    type: "session.created",
    properties: { info: { id: "sess-1", title: "日志测试会话" } },
  }
  await hooks.event?.({ event })
  await handle.flush()
}

/** 带假密钥的失败场景：hub_token 与 join_token 都在盘上，但注册必然失败。 */
function failingDeps(home: string, extra: Partial<PluginDeps> = {}): { deps: PluginDeps; hubToken: string; joinToken: string } {
  const hubToken = "SECRET-HUB-TOKEN-VALUE-DO-NOT-LOG"
  const joinToken = "SECRET-JOIN-TOKEN-VALUE-DO-NOT-LOG"
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "hub_token"), hubToken)
  writeFileSync(join(home, "agents", "opencode.token"), joinToken)
  const deps: PluginDeps = {
    env: { AGENTCHAT_HOME: home, AGENTCHAT_URL: "http://127.0.0.1:9" },
    fetch: unreachableFetch,
    sleep: async () => undefined,
    random: () => 0,
    ...extra,
  }
  return { deps, hubToken, joinToken }
}

describe("插件默认日志（未注入 deps.log）", () => {
  it("writes failures to the adapter log file, never the host console, and never leaks token values", async () => {
    const home = tempHome()
    const { deps, hubToken, joinToken } = failingDeps(home)
    const spies = spyHostConsole()

    await emitRootSession(createPluginHandle(deps))

    const text = readFileSync(logPath(home), "utf8")
    expect(text).toContain("root register failed")
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[plugin\] /m)
    expect(text).not.toContain(hubToken)
    expect(text).not.toContain(joinToken)
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.log).not.toHaveBeenCalled()
  })

  it("prefers an injected deps.log and leaves the log file untouched", async () => {
    const home = tempHome()
    const injected: string[] = []
    const { deps } = failingDeps(home, { log: (message: string) => injected.push(message) })
    const spies = spyHostConsole()

    await emitRootSession(createPluginHandle(deps))

    expect(injected.some((message) => message.includes("root register failed"))).toBe(true)
    expect(existsSync(logPath(home))).toBe(false)
    expect(spies.error).not.toHaveBeenCalled()
  })
})
