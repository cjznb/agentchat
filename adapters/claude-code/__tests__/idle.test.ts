/**
 * Task 4 单测：Stop / Notification(idle_prompt)。
 * 覆盖：Stop → idle + wake + 注入（decision block + additionalContext JSON）+ result delivered；
 * 空积压不输出不投递；Notification 仅 idle 且不 wake；wake 超时/不可达静默退出 0。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bodyOf, cleanupHomes, hubEnv, readLog, runHook, startHub, stateBodies, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function seedAgentId(home: string, agentId: string): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "claude-code.id"), agentId)
}

const twoMessages = [
  { id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hello" },
  { id: "m2", fromAgentId: "peer", conversationId: "c1", body: "world" },
]

function wakeWith(messages: unknown[]) {
  return {
    internal: (path: string) =>
      path === "/internal/wake" ? { status: 200, body: { messages, receipts: [] } } : undefined,
  }
}

describe("Stop 取件注入", () => {
  it("reports idle, wakes, injects via decision block + additionalContext, and reports delivered", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-root", state: "idle" }])
    expect(bodyOf(hub, "/internal/wake")).toEqual({ agentId: "agent-root" })
    const output: unknown = JSON.parse(run.stdout)
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { hookEventName: "Stop" },
    })
    expect(run.stdout).toContain("hello")
    expect(run.stdout).toContain("world")
    expect(bodyOf(hub, "/internal/result")).toEqual({
      agentId: "agent-root",
      items: [
        { messageId: "m1", result: "delivered" },
        { messageId: "m2", result: "delivered" },
      ],
    })
    await hub.close()
  })

  it("emits nothing and reports no result when the backlog is empty", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe("")
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-root", state: "idle" }])
    expect(hub.requests.some((r) => r.path === "/internal/result")).toBe(false)
    await hub.close()
  })
})

describe("Notification(idle_prompt)", () => {
  it("reports idle only and never wakes (injection delegated to Stop)", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook(
      "idle",
      { hook_event_name: "Notification", notification_type: "idle_prompt" },
      hubEnv(hub, home),
    )
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-root", state: "idle" }])
    expect(hub.requests.some((r) => r.path === "/internal/wake")).toBe(false)
    expect(hub.requests.some((r) => r.path === "/internal/result")).toBe(false)
    expect(run.stdout.trim()).toBe("")
    expect(readLog(home)).toContain("injection delegated to Stop hook")
    await hub.close()
  })
})

describe("idle 健壮性", () => {
  it("silently exits 0 when wake times out", async () => {
    const hub = await startHub({ hangPaths: ["/internal/wake"] })
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook("idle", { hook_event_name: "Stop" }, hubEnv(hub, home, {
      AGENTCHAT_HOOK_TIMEOUT_MS: "300",
    }))
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe("")
    expect(readLog(home)).toContain("wake failed")
    await hub.close()
  })

  it("silently exits 0 when the hub is unreachable", async () => {
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook("idle", { hook_event_name: "Stop" }, {
      AGENTCHAT_HOME: home,
      HUB_TOKEN: "hub-token",
      AGENTCHAT_URL: "http://127.0.0.1:1",
      AGENTCHAT_HOOK_TIMEOUT_MS: "800",
    })
    expect(run.code).toBe(0)
    expect(readLog(home)).toContain("idle(Stop)")
  })

  it("skips when no agent id is on disk", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("idle", { hook_event_name: "Stop" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.requests).toEqual([])
    expect(readLog(home)).toContain("no registered agent")
    await hub.close()
  })
})
