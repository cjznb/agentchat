/**
 * Task 4 单测：SubagentStart hook。
 * 覆盖：父回合窗口兜底关联（**须 session 匹配**）、agent_id→task_ref、无 agent_id 时
 * 会话内单调序号 task_ref（唯一）、子映射落盘、子节点 busy；会话不匹配/无活跃根窗口时跳过。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupHomes, hubEnv, readLog, runHook, startHub, stateBodies, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function seedRootWindow(home: string, agentId: string, sessionId: string): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(
    join(home, "agents", "claude-code.root.json"),
    `${JSON.stringify({ agentId, sessionId, at: 1 })}\n`,
  )
}

const subagentPayload = {
  hook_event_name: "SubagentStart",
  session_id: "sess-1",
  agent_id: "sub-9",
  agent_type: "Explore",
}

describe("SubagentStart 子节点注册（父回合窗口兜底）", () => {
  it("registers the child with session-matched parent_ref and task_ref from agent_id, then reports busy", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedRootWindow(home, "agent-root", "sess-1")
    const run = await runHook("subagent-start", subagentPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([
      { vendor: "claude-code", purpose: "Explore", parent_ref: "agent-root", task_ref: "sub-9" },
    ])
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-1", state: "busy" }])
    const subs: unknown = JSON.parse(readFileSync(join(home, "agents", "claude-code.subs.json"), "utf8"))
    expect(subs).toMatchObject({ "sub-9": { agentId: "agent-1", agentType: "Explore", sessionId: "sess-1" } })
    await hub.close()
  })

  it("allocates a unique session-scoped monotonic task_ref when agent_id is absent", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedRootWindow(home, "agent-root", "sess-1")
    const payload = { hook_event_name: "SubagentStart", session_id: "sess-1" }
    const first = await runHook("subagent-start", payload, hubEnv(hub, home))
    const second = await runHook("subagent-start", payload, hubEnv(hub, home))
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    expect(hub.toolCalls).toEqual([
      { vendor: "claude-code", purpose: "subagent", parent_ref: "agent-root", task_ref: "sub-1" },
      { vendor: "claude-code", purpose: "subagent", parent_ref: "agent-root", task_ref: "sub-2" },
    ])
    await hub.close()
  })

  it("skips when the session does not match the root turn window (no cross-session mis-attach)", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedRootWindow(home, "agent-root", "sess-OTHER")
    const run = await runHook("subagent-start", subagentPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([])
    expect(hub.requests).toEqual([])
    expect(readLog(home)).toContain("no matching root turn window")
    await hub.close()
  })

  it("skips without an active root turn window", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("subagent-start", subagentPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([])
    expect(readLog(home)).toContain("no matching root turn window")
    await hub.close()
  })
})
