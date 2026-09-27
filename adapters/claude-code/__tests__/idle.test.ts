/**
 * Task 4 单测：Stop / Notification(idle_prompt)。
 * 覆盖：Stop → idle + wake + 注入（decision block + reason 正文 + additionalContext JSON）+ result delivered；
 * reason 双通道保底；空积压不 block/不投递；stop_hook_active 放行；每会话 block 上限后放行且不再 wake；
 * 无消息时计数归零；Notification 仅 idle 且不 wake；超时/不可达静默退出 0。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bodyOf, cleanupHomes, hubEnv, isRecord, readLog, runHook, startHub, stateBodies, tempHome, type HookRun } from "./hook-harness"

afterEach(cleanupHomes)

function seedAgentId(home: string, agentId: string): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "claude-code.id"), agentId)
}

function stopStatePath(home: string): string {
  return join(home, "agents", "claude-code.stop.json")
}

function readStopState(home: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(stopStatePath(home), "utf8"))
  if (!isRecord(value)) throw new Error("bad stop state")
  return value
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
  it("reports idle, wakes, injects bodies via both reason and additionalContext, and reports delivered", async () => {
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
    if (!isRecord(output)) throw new Error("no output object")
    const reason = output["reason"]
    expect(typeof reason).toBe("string")
    expect(reason).toContain("2 条")
    expect(reason).toContain("hello")
    expect(reason).toContain("world")
    expect(bodyOf(hub, "/internal/result")).toEqual({
      agentId: "agent-root",
      items: [
        { messageId: "m1", result: "delivered" },
        { messageId: "m2", result: "delivered" },
      ],
    })
    expect(readStopState(home)).toMatchObject({ sessionId: "sess-1", count: 1 })
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

describe("Stop 稳健性（stop_hook_active / block 上限）", () => {
  it("passes without wake or block when stop_hook_active is true", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook(
      "idle",
      { hook_event_name: "Stop", session_id: "sess-1", stop_hook_active: true },
      hubEnv(hub, home),
    )
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe("")
    expect(hub.requests.some((r) => r.path === "/internal/wake")).toBe(false)
    expect(hub.requests.some((r) => r.path === "/internal/result")).toBe(false)
    expect(readLog(home)).toContain("stop_hook_active")
    await hub.close()
  })

  it("caps consecutive blocks per session, then passes without waking", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const payload = { hook_event_name: "Stop", session_id: "sess-1" }
    const runs: HookRun[] = []
    for (let i = 0; i < 4; i += 1) runs.push(await runHook("idle", payload, hubEnv(hub, home)))
    expect(runs.every((r) => r.code === 0)).toBe(true)
    expect(runs.filter((r) => r.stdout.trim() !== "")).toHaveLength(3)
    expect(runs[3]?.stdout.trim()).toBe("")
    expect(hub.requests.filter((r) => r.path === "/internal/wake")).toHaveLength(3)
    expect(stateBodies(hub)).toHaveLength(4)
    expect(readLog(home)).toContain("block cap 3 reached")
    await hub.close()
  })

  it("resets the block counter when the backlog is empty", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedAgentId(home, "agent-root")
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(stopStatePath(home), `${JSON.stringify({ sessionId: "sess-1", count: 2, at: 1 })}\n`)
    const run = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(readStopState(home)).toMatchObject({ sessionId: "sess-1", count: 0 })
    await hub.close()
  })
})

describe("Notification(idle_prompt)", () => {
  it("reports idle only and never wakes or reports delivered", async () => {
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
