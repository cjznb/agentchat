/**
 * 缺陷 #3/#4 单测：SubagentStop hook。
 * 覆盖：子代理完成 → 子节点 idle + wake + 注入（与根 Stop 同格式：decision block + reason +
 * hookSpecificOutput.additionalContext，hookEventName=SubagentStop）+ result delivered；
 * 有积压时**不退役**（子代理续跑，节点保留）；无积压时**退役子节点并清除本地映射**；
 * subs.json 无映射 → 跳过（不误伤根）；Hub 不可达/超时 → 静默退出 0。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bodyOf, cleanupHomes, hubEnv, isRecord, readLog, runHook, startHub, stateBodies, tempHome } from "./hook-harness"

afterEach(cleanupHomes)

function seedSubs(home: string, map: Record<string, unknown>): void {
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "claude-code.subs.json"), `${JSON.stringify(map)}\n`)
}

function readSubs(home: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(home, "agents", "claude-code.subs.json"), "utf8"))
  if (!isRecord(value)) throw new Error("subs is not an object")
  return value
}

const child = { agentId: "child-1", agentType: "Explore", sessionId: "sess-1", at: 1 }
const payload = {
  hook_event_name: "SubagentStop",
  session_id: "sess-1",
  agent_id: "sub-9",
  agent_type: "Explore",
  stop_hook_active: false,
}

function wakeWith(messages: unknown[]) {
  return {
    internal: (path: string) =>
      path === "/internal/wake" ? { status: 200, body: { messages, receipts: [] } } : undefined,
  }
}

describe("SubagentStop 子节点注入与退役", () => {
  it("injects backlog to the mapped child, reports delivered, and keeps the child (no retire)", async () => {
    const hub = await startHub(
      wakeWith([{ id: "m1", fromAgentId: "peer", conversationId: "c1", body: "hi child" }]),
    )
    const home = tempHome()
    seedSubs(home, { "sub-9": child })
    const run = await runHook("subagent-stop", payload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(stateBodies(hub)).toEqual([{ agentId: "child-1", state: "idle" }])
    expect(bodyOf(hub, "/internal/wake")).toEqual({ agentId: "child-1" })
    const output: unknown = JSON.parse(run.stdout)
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { hookEventName: "SubagentStop" },
    })
    expect(run.stdout).toContain("hi child")
    expect(bodyOf(hub, "/internal/result")).toEqual({
      agentId: "child-1",
      items: [{ messageId: "m1", result: "delivered" }],
    })
    expect(hub.requests.some((r) => r.path === "/internal/retire")).toBe(false)
    expect(readSubs(home)["sub-9"]).toBeDefined()
    await hub.close()
  })

  it("retires the child and clears the mapping when the subagent finishes with no backlog", async () => {
    const hub = await startHub()
    const home = tempHome()
    seedSubs(home, { "sub-9": child })
    const run = await runHook("subagent-stop", payload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe("")
    expect(bodyOf(hub, "/internal/retire")).toEqual({ agentId: "child-1" })
    expect(readSubs(home)).toEqual({})
    await hub.close()
  })

  it("skips without any hub call when the payload agent_id has no mapping", async () => {
    const hub = await startHub()
    const home = tempHome()
    const run = await runHook("subagent-stop", { ...payload, agent_id: "unknown" }, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(hub.requests).toEqual([])
    expect(readLog(home)).toContain("no mapped child")
    await hub.close()
  })

  it("stays honest on retire failure: logs it, still exits 0", async () => {
    const hub = await startHub({
      internal: (path) => (path === "/internal/retire" ? { status: 500, body: { ok: false } } : undefined),
    })
    const home = tempHome()
    seedSubs(home, { "sub-9": child })
    const run = await runHook("subagent-stop", payload, hubEnv(hub, home))
    expect(run.code).toBe(0)
    expect(readLog(home)).toContain("retire failed")
    await hub.close()
  })
})
