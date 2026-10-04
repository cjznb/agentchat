/**
 * 六个 hook 的不变量（真子进程 + 假 Hub，不联网）。
 *
 * 覆盖指南 §9.1 与本适配器专有项：注册顺序与层级、兜底拉取、Stop 注入的 JSON 形状与防自激、
 * 通知只上报不取件、SessionEnd 绝不 retire、PreToolUse 只碰自家工具且未注册会话不塞身份头。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { adapterPaths } from "../lib/paths.mjs"
import { readJson, readText, writeJson, writeToken } from "../lib/token.mjs"
import { SESSION_ARG } from "../lib/session-hint.mjs"
import { cleanupHomes, hubEnv, message, readLog, resultBodies, runHook, startHub, stateBodies, tempHome } from "./harness"
import type { Hub, HubOptions } from "./harness"

/**
 * 本文件只放宽**自己的**等待上限，不动仓库共享的 `vitest.config.ts`。
 *
 * 每个用例都要冷启动多次 `node <hook>.mjs`；在**整仓并行**运行时（本机 83 个测试文件同时起 worker，
 * node 冷启动从 ~1.2s 涨到十几秒），链式 Stop 那类用例（5 次 spawn）会越过默认 30s，
 * `afterEach` 的临时目录递归删除也会越过默认 `hookTimeout` 10s。
 * 这只放宽"等到什么时候算失败"，**不放宽任何断言**。
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const SESSION = "session-abcdefgh-1111-2222-3333-444444444444"
const CWD = "D:\\work\\proj"

afterEach(() => cleanupHomes())

interface Fixture {
  readonly hub: Hub
  readonly home: string
  readonly env: Record<string, string>
}

async function setup(options: HubOptions = {}): Promise<Fixture> {
  const hub = await startHub(options)
  const home = tempHome()
  return { hub, home, env: hubEnv(hub, home) }
}

function startPayload() {
  return { session_id: SESSION, cwd: CWD, hook_event_name: "SessionStart", source: "startup" }
}

function stopPayload(stopHookActive: boolean) {
  return { session_id: SESSION, cwd: CWD, hook_event_name: "Stop", stop_hook_active: stopHookActive }
}

async function sessionStart(env: Record<string, string>): Promise<void> {
  await runHook("session-start.mjs", startPayload(), env)
}

/**
 * 每次 wake 返回一批消息（按调用序号；越界后固定取最后一批）。
 *
 * ⚠️ 批次表的**第一个元素是 SessionStart 的兜底拉取**（指南 §7 坑 3：登记成功即拉一次），
 * 而不是 Stop 的。凡「验证 Stop 注入」的用例都必须让首元素为 `[]`（建模"会话开启时无积压"），
 * 否则那条消息会被 SessionStart 抢先投递并写入去重集合，Stop 侧只剩重复 → 永远静默。
 */
function wakeBatches(batches: readonly (readonly unknown[])[]): HubOptions {
  let index = 0
  return {
    internal: (path) => {
      if (path !== "/internal/wake") return undefined
      const batch = batches[Math.min(index, batches.length - 1)] ?? []
      index += 1
      return { status: 200, body: { messages: batch } }
    },
  }
}

describe("SessionStart", () => {
  it("先注册容器（role_tag=container）再注册会话节点（parent_ref + task_ref），并落盘 token/id", async () => {
    const { hub, home, env } = await setup()
    const result = await runHook("session-start.mjs", startPayload(), env)
    expect(result.code).toBe(0)
    expect(hub.toolCalls).toHaveLength(2)
    const [root, child] = hub.toolCalls as [Record<string, unknown>, Record<string, unknown>]
    expect(root["role_tag"]).toBe("container")
    expect(root["vendor"]).toBe("workbuddy")
    expect(String(root["name"])).toMatch(/^workbuddy@/)
    expect(child["parent_ref"]).toBe("agent-1")
    expect(child["task_ref"]).toBe(SESSION)
    expect(child["name"]).toBe("proj-abcdefgh") // 剥前缀再截断（坑 1）

    const paths = adapterPaths(home)
    expect(readText(paths.agentId)).toBe("agent-1")
    expect(readText(paths.token)).toBe("jt-1")
    expect(readJson(paths.sessions)?.[SESSION]).toBeDefined()

    const states = stateBodies(hub) as Array<Record<string, string>>
    expect(states.some((state) => state["state"] === "online")).toBe(true)
    expect(readLog(home)).not.toContain("failed")
    await hub.close()
  })

  it("兜底拉取：SessionStart 就能把排队消息投出去（坑 3）", async () => {
    const { hub, env } = await setup(wakeBatches([[message("m-start")]]))
    const result = await runHook("session-start.mjs", startPayload(), env)
    const payload = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: Record<string, string> }
    expect(payload.hookSpecificOutput["hookEventName"]).toBe("SessionStart")
    expect(payload.hookSpecificOutput["additionalContext"]).toContain("m-start")
    const results = resultBodies(hub) as Array<{ items: Array<{ messageId: string; result: string }> }>
    expect(results[0]?.items).toEqual([{ messageId: "m-start", result: "delivered" }])
    await hub.close()
  })

  it("没有 Hub token 时跳过注册且不阻塞（退出码 0 + 可诊断日志）", async () => {
    const { hub, home } = await setup()
    const result = await runHook("session-start.mjs", startPayload(), {
      AGENTCHAT_HOME: home,
      HUB_TOKEN: "",
      AGENTCHAT_URL: hub.baseUrl,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect(hub.requests).toHaveLength(0)
    expect(readLog(home)).toContain("hub token missing")
    await hub.close()
  })

  it("根节点撞名 → 生成**持久化**后缀并只重试一次", async () => {
    const { hub, home, env } = await setup({
      toolCall: (_args, index) =>
        index === 0
          ? { text: "agent name already taken: workbuddy@h [name_taken]", isError: true }
          : { text: JSON.stringify({ agent: { id: "a-ok" }, join_token: "jt-ok" }) },
    })
    const result = await runHook("session-start.mjs", startPayload(), env)
    expect(result.code).toBe(0)
    const calls = hub.toolCalls as Array<Record<string, unknown>>
    expect(String(calls[0]?.["name"])).toMatch(/^workbuddy@/)
    expect(String(calls[1]?.["name"])).toMatch(/^workbuddy@.+#[0-9a-f]{6}$/)
    expect(readText(adapterPaths(home).instance)).toMatch(/^[0-9a-f]{6}$/)
    await hub.close()
  })

  it("陈旧 join_token → 清 token 按首次注册重来，并写回新 token", async () => {
    const { hub, home, env } = await setup({
      toolCall: (_args, index) =>
        index === 0
          ? { text: "invalid join token [invalid_join_token]", isError: true }
          : { text: JSON.stringify({ agent: { id: "a2" }, join_token: "jt-2" }) },
    })
    const paths = adapterPaths(home)
    writeToken(paths.token, "stale")
    await runHook("session-start.mjs", startPayload(), env)
    expect(readLog(home)).toContain("token rejected")
    expect(readText(paths.token)).toBe("jt-2")
    await hub.close()
  })
})

describe("Stop（入站唤醒主入口）", () => {
  it("有新消息 → continue:false + 双通道同文，并回执 delivered", async () => {
    const { hub, home, env } = await setup(wakeBatches([[], [message("m-stop", "任务更新")]]))
    await sessionStart(env)
    const result = await runHook("stop.mjs", stopPayload(false), env)
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    expect(payload["continue"]).toBe(false)
    const output = payload["hookSpecificOutput"] as Record<string, string>
    expect(payload["stopReason"]).toBe(output["additionalContext"])
    expect(String(payload["stopReason"])).toContain("m-stop")
    expect(String(payload["stopReason"])).toContain("[AgentChat]")
    const items = (resultBodies(hub) as Array<{ items: Array<{ messageId: string; result: string }> }>).flatMap(
      (entry) => entry.items,
    )
    expect(items).toContainEqual({ messageId: "m-stop", result: "delivered" })
    expect(readText(join(home, "agents", "workbuddy.seen.json"))).toContain("m-stop")
    await hub.close()
  })

  it("租约重投（同一 messageId）→ 绝不重复注入，只补回执", async () => {
    // 第 1 批归 SessionStart（空）；第 2、3 批是**同一 messageId 的租约重投**。
    const { hub, env } = await setup(wakeBatches([[], [message("m-dup")], [message("m-dup")]]))
    await sessionStart(env)
    const first = await runHook("stop.mjs", stopPayload(false), env)
    expect(first.stdout.trim()).not.toBe("")
    const second = await runHook("stop.mjs", stopPayload(true), env)
    expect(second.stdout.trim()).toBe("")
    const items = (resultBodies(hub) as Array<{ items: Array<{ messageId: string; result: string }> }>).flatMap(
      (entry) => entry.items,
    )
    expect(items.filter((item) => item.messageId === "m-dup" && item.result === "delivered")).toHaveLength(2)
    await hub.close()
  })

  it("无新件 → 静默退出（stdout 为空）", async () => {
    const { hub, env } = await setup(wakeBatches([[]]))
    await sessionStart(env)
    const result = await runHook("stop.mjs", stopPayload(false), env)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    await hub.close()
  })

  it("链内达上限 → 放行；滚动窗口过期后新链可再次被唤醒", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"]
    const { hub, home, env } = await setup(wakeBatches(ids.map((id) => [message(id)])))
    await sessionStart(env) // 会消耗第一批（c1）
    const runs = [
      ["c2", true],
      ["c3", true],
      ["c4", true],
    ] as const
    for (const [id, active] of runs) {
      const result = await runHook("stop.mjs", stopPayload(active), env)
      expect(result.stdout).toContain(id)
    }
    const capped = await runHook("stop.mjs", stopPayload(true), env)
    expect(capped.stdout.trim()).toBe("") // 第 4 次达上限 → 放行
    // 模拟"距上次注入已超过滚动窗口"→ 新链应可再次注入
    writeJson(adapterPaths(home).stop, { sessionId: SESSION, count: 3, at: Date.now() - 10 * 60_000 })
    const revived = await runHook("stop.mjs", stopPayload(false), env)
    expect(revived.stdout).toContain("c5")
    await hub.close()
  })
})

describe("Notification / SessionEnd", () => {
  it("idle_prompt → 只上报 idle 心跳（不 wake、不注入）", async () => {
    const { hub, env } = await setup(wakeBatches([[message("m-notify")]]))
    await sessionStart(env)
    const before = hub.requests.filter((r) => r.path === "/internal/wake").length
    const result = await runHook(
      "notification.mjs",
      { session_id: SESSION, cwd: CWD, hook_event_name: "Notification", notification_type: "idle_prompt" },
      env,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect((stateBodies(hub) as Array<Record<string, string>>).some((state) => state["state"] === "idle")).toBe(true)
    expect(hub.requests.filter((r) => r.path === "/internal/wake").length).toBe(before)
    await hub.close()
  })

  it("非 idle_prompt 通知 → 完全忽略（不产生任何请求）", async () => {
    const { hub, env } = await setup()
    const result = await runHook(
      "notification.mjs",
      { session_id: SESSION, hook_event_name: "Notification", notification_type: "permission_request" },
      env,
    )
    expect(result.stdout).toBe("")
    expect(hub.requests).toHaveLength(0)
    await hub.close()
  })

  it("SessionEnd → 绝不 retire（单向门），退出码 0", async () => {
    const { hub, home, env } = await setup()
    await sessionStart(env)
    for (const reason of ["clear", "logout", "other"]) {
      const result = await runHook("session-end.mjs", { session_id: SESSION, cwd: CWD, hook_event_name: "SessionEnd", reason }, env)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe("")
    }
    expect(hub.requests.filter((r) => r.path === "/internal/retire")).toHaveLength(0)
    expect(readLog(home)).toContain("reason=clear")
    await hub.close()
  })
})

describe("PreToolUse（逐会话出站身份）", () => {
  it("自家工具 + 已注册会话 → 完整 modifiedInput + 会话提示 + permissionDecision=allow", async () => {
    const { hub, env } = await setup()
    await sessionStart(env)
    const toolInput = { to: "agent-9", body: "hi", mentions: ["x"] }
    const result = await runHook(
      "pre-tool-use.mjs",
      { session_id: SESSION, cwd: CWD, hook_event_name: "PreToolUse", tool_name: "mcp__agentchat__send", tool_input: toolInput },
      env,
    )
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: Record<string, unknown> }
    expect(payload.hookSpecificOutput["hookEventName"]).toBe("PreToolUse")
    expect(payload.hookSpecificOutput["permissionDecision"]).toBe("allow")
    const modified = payload.hookSpecificOutput["modifiedInput"] as Record<string, unknown>
    expect(modified[SESSION_ARG]).toBe(SESSION)
    expect(modified["to"]).toBe("agent-9")
    expect(modified["mentions"]).toEqual(["x"])
    await hub.close()
  })

  it("未注册会话 → **不塞身份头**（否则 Hub 会 identity_required，工具直接不可用）", async () => {
    const { hub, env } = await setup()
    const result = await runHook(
      "pre-tool-use.mjs",
      { session_id: SESSION, cwd: CWD, hook_event_name: "PreToolUse", tool_name: "mcp__agentchat__send", tool_input: { to: "a" } },
      env,
    )
    expect(result.stdout).toBe("")
    await hub.close()
  })

  it("非自家工具 → 静默（绝不触碰用户其它工具与权限）", async () => {
    const { hub, env } = await setup()
    await sessionStart(env)
    const result = await runHook(
      "pre-tool-use.mjs",
      { session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      env,
    )
    expect(result.stdout).toBe("")
    expect(result.code).toBe(0)
    await hub.close()
  })
})

describe("UserPromptSubmit", () => {
  it("懒注册兜底 + 心跳 busy + 有待投内容时注入 additionalContext", async () => {
    const { hub, home, env } = await setup(wakeBatches([[message("m-ups")]]))
    const result = await runHook(
      "user-prompt-submit.mjs",
      { session_id: SESSION, cwd: CWD, hook_event_name: "UserPromptSubmit", prompt: "[AgentChat] poll" },
      env,
    )
    expect(result.code).toBe(0)
    // 未先跑 SessionStart：本 hook 自己把节点注册起来（坑 4）
    expect(readJson(adapterPaths(home).sessions)?.[SESSION]).toBeDefined()
    const payload = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: Record<string, string> }
    expect(payload.hookSpecificOutput["hookEventName"]).toBe("UserPromptSubmit")
    expect(payload.hookSpecificOutput["additionalContext"]).toContain("m-ups")
    expect((stateBodies(hub) as Array<Record<string, string>>).some((state) => state["state"] === "busy")).toBe(true)
    await hub.close()
  })

  it("无待投内容 → 只心跳、stdout 为空（cron 哨兵回合可快速空跑）", async () => {
    const { hub, env } = await setup(wakeBatches([[]]))
    const result = await runHook(
      "user-prompt-submit.mjs",
      { session_id: SESSION, cwd: CWD, hook_event_name: "UserPromptSubmit", prompt: "[AgentChat] poll" },
      env,
    )
    expect(result.stdout).toBe("")
    expect(result.code).toBe(0)
    expect(stateBodies(hub).length).toBeGreaterThan(0)
    await hub.close()
  })
})
