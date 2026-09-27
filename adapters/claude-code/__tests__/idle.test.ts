/**
 * Task 4 单测：Stop / Notification(idle_prompt)。
 * 覆盖：Stop → idle + wake + 注入（decision block + reason 正文 + additionalContext JSON）+ result delivered；
 * reason 双通道保底；空积压不 block/不投递；链内 block 上限 3 + 链边界（stop_hook_active）重置；
 * 租约重投按 messageId 去重不重复注入；Notification 仅 idle 且不 wake；超时/不可达静默退出 0。
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

/** 每次 wake 返回**新** messageId 的积压（避免触发去重，专测 block 链计数）。 */
function wakeFresh() {
  let n = 0
  return {
    internal: (path: string) => {
      if (path !== "/internal/wake") return undefined
      n += 1
      return {
        status: 200,
        body: {
          messages: [{ id: `m${n}`, fromAgentId: "peer", conversationId: "c1", body: `msg-${n}` }],
          receipts: [],
        },
      }
    },
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

describe("Stop 稳健性（链内 block 上限 + 链边界重置）", () => {
  it("caps blocks within one chain at 3, then passes the 4th without waking (same chain)", async () => {
    const hub = await startHub(wakeFresh())
    const home = tempHome()
    seedAgentId(home, "agent-root")
    // 新链首停：block（计数 1）。
    const first = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    expect(first.stdout.trim()).not.toBe("")
    // 同链续跑（stop_hook_active=true）：再 block 两次（计数 2、3），第 4 次达上限放行。
    const continues: HookRun[] = []
    for (let i = 0; i < 3; i += 1) {
      continues.push(
        await runHook(
          "idle",
          { hook_event_name: "Stop", session_id: "sess-1", stop_hook_active: true },
          hubEnv(hub, home),
        ),
      )
    }
    expect(continues[0]?.stdout.trim()).not.toBe("")
    expect(continues[1]?.stdout.trim()).not.toBe("")
    expect(continues[2]?.stdout.trim()).toBe("")
    expect(hub.requests.filter((r) => r.path === "/internal/wake")).toHaveLength(3)
    expect(readStopState(home)).toMatchObject({ sessionId: "sess-1", count: 3 })
    expect(readLog(home)).toContain("block cap 3 reached")
    await hub.close()
  })

  it("never blocks again within the same chain after the cap (no infinite loop)", async () => {
    const hub = await startHub(wakeFresh())
    const home = tempHome()
    seedAgentId(home, "agent-root")
    await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    const payload = { hook_event_name: "Stop", session_id: "sess-1", stop_hook_active: true }
    const runs: HookRun[] = []
    for (let i = 0; i < 6; i += 1) runs.push(await runHook("idle", payload, hubEnv(hub, home)))
    // 链内首停 + 2 次续 block = 共 3 次 wake；此后 4 次同链停全放行且不再 wake。
    expect(hub.requests.filter((r) => r.path === "/internal/wake")).toHaveLength(3)
    expect(runs.filter((r) => r.stdout.trim() !== "")).toHaveLength(2)
    await hub.close()
  })

  it("resets the counter at a chain boundary (stop_hook_active absent/false) so a new chain can block again", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    // 预置一个已达上限的链计数（同 session），模拟上一链已放行。
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(stopStatePath(home), `${JSON.stringify({ sessionId: "sess-1", count: 3, at: 1 })}\n`)
    // 新回合（无 stop_hook_active）→ 计数归零、可再次 block（旧实现会永久放行）。
    const run = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).not.toBe("")
    expect(readStopState(home)).toMatchObject({ sessionId: "sess-1", count: 1 })
    await hub.close()
  })

  it("does not re-inject a message id redelivered by the wake lease; reports delivered instead", async () => {
    const hub = await startHub(wakeWith(twoMessages))
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const first = await runHook("idle", { hook_event_name: "Stop", session_id: "sess-1" }, hubEnv(hub, home))
    // 租约重投：同一批 messageId 再次返回 → 绝不重复注入，仅补回执。
    const second = await runHook(
      "idle",
      { hook_event_name: "Stop", session_id: "sess-1", stop_hook_active: true },
      hubEnv(hub, home),
    )
    expect(first.stdout).toContain("hello")
    expect(second.stdout.trim()).toBe("") // 无新消息 → 不 block
    const results = hub.requests.filter((r) => r.path === "/internal/result")
    expect(results).toHaveLength(2)
    expect(bodyOf(hub, "/internal/result")).toEqual({
      agentId: "agent-root",
      items: [
        { messageId: "m1", result: "delivered" },
        { messageId: "m2", result: "delivered" },
      ],
    })
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
