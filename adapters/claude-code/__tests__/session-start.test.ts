/**
 * Task 4 单测：SessionStart hook（真子进程 + 假 stdin + mock Hub）。
 * 覆盖：无 token 首注册（并落盘 token/id/online）、有 token 认领、陈旧 token 自愈、
 * token 写失败仍继续、Hub 不可达静默退出 0。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  bodyOf,
  cleanupHomes,
  hubEnv,
  readLog,
  runHook,
  startHub,
  stateBodies,
  tempHome,
} from "./hook-harness"

afterEach(cleanupHomes)

const sessionStartPayload = { hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" }

function tokenFile(home: string): string {
  return join(home, "agents", "claude-code.token")
}

function idFile(home: string): string {
  return join(home, "agents", "claude-code.id")
}

describe("SessionStart 注册与重连", () => {
  it("first root session registers without join_token, persists token/id, and reports online", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("session-start", sessionStartPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([{ vendor: "claude-code", purpose: "coding-agent" }])
    expect(readFileSync(tokenFile(home), "utf8")).toBe("jt-1")
    expect(readFileSync(idFile(home), "utf8")).toBe("agent-1")
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-1", state: "online" }])
    expect(bodyOf(hub, "/internal/state")).toBeDefined()
    expect(hub.requests.every((r) => r.headers["authorization"] === "Bearer hub-token")).toBe(true)
    expect(hub.requests.some((r) => r.path === "/mcp" && r.method === "POST")).toBe(true)
    await hub.close()
  })

  it("reconnect with an existing token claims via join_token and keeps the file when the reply omits it", async () => {
    const home = tempHome()
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(tokenFile(home), "old-token")
    const hub = await startHub({
      register: () => ({ text: JSON.stringify({ agent: { id: "agent-7" }, unread: 0 }) }),
    })
    const run = await runHook("session-start", sessionStartPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([
      { vendor: "claude-code", purpose: "coding-agent", join_token: "old-token" },
    ])
    expect(readFileSync(tokenFile(home), "utf8")).toBe("old-token")
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-7", state: "online" }])
    await hub.close()
  })

  it("recovers from a stale join_token by clearing it and re-registering as root", async () => {
    const home = tempHome()
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(tokenFile(home), "stale-token")
    const hub = await startHub({
      register: (_args, index) =>
        index === 0
          ? { text: "RegistrationError: unknown join_token [invalid_join_token]", isError: true }
          : { text: JSON.stringify({ agent: { id: "agent-new" }, join_token: "jt-new" }) },
    })
    const run = await runHook("session-start", sessionStartPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls[0]).toEqual({
      vendor: "claude-code",
      purpose: "coding-agent",
      join_token: "stale-token",
    })
    expect(hub.toolCalls[1]).toEqual({ vendor: "claude-code", purpose: "coding-agent" })
    expect(readFileSync(tokenFile(home), "utf8")).toBe("jt-new")
    expect(readFileSync(idFile(home), "utf8")).toBe("agent-new")
    expect(readLog(home)).toContain("stale join_token rejected")
    await hub.close()
  })

  it("reports a token/id write failure but still registers and reports online", async () => {
    const home = join(tempHome(), "not-a-dir")
    writeFileSync(home, "file")
    const hub = await startHub()
    const run = await runHook("session-start", sessionStartPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toHaveLength(1)
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-1", state: "online" }])
    await hub.close()
  })

  it("exits 0 silently when the hub is unreachable", async () => {
    const home = tempHome()
    const run = await runHook("session-start", sessionStartPayload, {
      AGENTCHAT_HOME: home,
      HUB_TOKEN: "hub-token",
      AGENTCHAT_URL: "http://127.0.0.1:1",
      AGENTCHAT_HOOK_TIMEOUT_MS: "800",
    })
    expect(run.code).toBe(0)
    expect(readLog(home)).toContain("SessionStart failed")
  })

  it("skips when HUB_TOKEN is missing", async () => {
    const home = tempHome()
    const run = await runHook("session-start", sessionStartPayload, { AGENTCHAT_HOME: home })
    expect(run.code).toBe(0)
    expect(readLog(home)).toContain("HUB_TOKEN missing")
  })

  it("pulls backlog at session start as the fallback injection path", async () => {
    const hub = await startHub({
      internal: (path) =>
        path === "/internal/wake"
          ? {
              status: 200,
              body: {
                messages: [{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi there" }],
                receipts: [],
              },
            }
          : undefined,
    })
    const home = tempHome()
    const run = await runHook("session-start", sessionStartPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    const output: unknown = JSON.parse(run.stdout)
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    })
    expect(run.stdout).toContain("hi there")
    expect(bodyOf(hub, "/internal/result")).toEqual({
      agentId: "agent-1",
      items: [{ messageId: "m1", result: "delivered" }],
    })
    await hub.close()
  })
})
