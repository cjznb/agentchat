/**
 * Task 4 单测：SubagentStart hook。
 * 覆盖：父回合窗口兜底关联、agent_id→task_ref、子映射落盘、子节点 busy；
 * 无活跃根窗口时跳过（不误挂）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupHomes, hubEnv, readLog, runHook, startHub, stateBodies, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function seedRootWindow(home: string, agentId: string): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(
    join(home, "agents", "claude-code.root.json"),
    `${JSON.stringify({ agentId, sessionId: "sess-1", at: 1 })}\n`,
  )
}

const subagentPayload = {
  hook_event_name: "SubagentStart",
  session_id: "sess-1",
  agent_id: "sub-9",
  agent_type: "Explore",
}

describe("SubagentStart 子节点注册（父回合窗口兜底）", () => {
  it("registers the child with parent_ref from the root window and task_ref from agent_id, then reports busy", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedRootWindow(home, "agent-root")
    const run = await runHook("subagent-start", subagentPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([
      { vendor: "claude-code", purpose: "Explore", parent_ref: "agent-root", task_ref: "sub-9" },
    ])
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-1", state: "busy" }])
    const subs: unknown = JSON.parse(readFileSync(join(home, "agents", "claude-code.subs.json"), "utf8"))
    expect(subs).toMatchObject({ "sub-9": { agentId: "agent-1", agentType: "Explore" } })
    await hub.close()
  })

  it("falls back to session_id as task_ref when agent_id is absent", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedRootWindow(home, "agent-root")
    const run = await runHook(
      "subagent-start",
      { hook_event_name: "SubagentStart", session_id: "sess-7" },
      hubEnv(hub, home),
    )
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([
      { vendor: "claude-code", purpose: "subagent", parent_ref: "agent-root", task_ref: "sess-7" },
    ])
    await hub.close()
  })

  it("skips without an active root turn window instead of mis-attaching", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("subagent-start", subagentPayload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.toolCalls).toEqual([])
    expect(hub.requests).toEqual([])
    expect(readLog(home)).toContain("no active root turn window")
    await hub.close()
  })
})
