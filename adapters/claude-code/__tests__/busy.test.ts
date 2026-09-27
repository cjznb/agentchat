/**
 * Task 4 单测：PreToolUse/PostToolUse → busy。
 * 覆盖：根节点 busy、子代理内工具事件按 agent_id 映射到子节点、无映射时跳过。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupHomes, hubEnv, readLog, runHook, startHub, stateBodies, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function seedAgentId(home: string, agentId: string): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "claude-code.id"), agentId)
}

function seedSubs(home: string, map: Record<string, { agentId: string }>): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "claude-code.subs.json"), JSON.stringify(map))
}

describe("busy 上报", () => {
  it("reports busy for the root node on PreToolUse", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedAgentId(home, "agent-root")
    const run = await runHook(
      "busy",
      { hook_event_name: "PreToolUse", session_id: "sess-1", tool_name: "Bash" },
      hubEnv(hub, home),
    )
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([{ agentId: "agent-root", state: "busy" }])
    await hub.close()
  })

  it("maps a subagent tool call to the child node", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedAgentId(home, "agent-root")
    seedSubs(home, { "sub-9": { agentId: "child-1" } })
    const run = await runHook(
      "busy",
      { hook_event_name: "PostToolUse", session_id: "sess-1", agent_id: "sub-9" },
      hubEnv(hub, home),
    )
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([{ agentId: "child-1", state: "busy" }])
    await hub.close()
  })

  it("skips when no node can be resolved", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("busy", { hook_event_name: "PreToolUse" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([])
    expect(readLog(home)).toContain("no mapped agent")
    await hub.close()
  })
})
