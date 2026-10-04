/**
 * MCP 桥的不变量（真子进程 + 假 Hub）：
 * ① stdout **只允许** JSON-RPC 帧（诊断必须走文件日志，否则污染宿主协议流）；
 * ② `tools/call` 入参里的会话提示**必被剥离**并转成请求头（Hub 绝不能看到该键）；
 * ③ 会话提示变化 → **重建** Hub 会话（Hub 只在 `initialize` 认身份）；
 * ④ Hub 不可达/401 → 以 JSON-RPC error 回给宿主，**进程保持存活**（不拖垮宿主）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { SESSION_ARG } from "../lib/session-hint.mjs"
import { writeText } from "../lib/token.mjs"
import { adapterPaths } from "../lib/paths.mjs"
import { cleanupHomes, hubEnv, isRecord, readLog, runBridge, startHub, tempHome } from "./harness"
import type { Hub } from "./harness"

/**
 * 本文件只放宽**自己的**等待上限，不动仓库共享的 `vitest.config.ts`。
 * 桥是**长驻**子进程，每个用例都含多轮 `waitFor`（各自 8s 上限）；整仓并行时 node 冷启动 + 前后端
 * 往返会明显变慢。这只放宽"等到什么时候算失败"，**不放宽任何断言**。
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

afterEach(() => cleanupHomes())

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "0" } } }

function initializeCount(hub: Hub): number {
  return hub.requests.filter((request) => isRecord(request.json) && request.json["method"] === "initialize").length
}

function mcpRequests(hub: Hub) {
  return hub.requests.filter((request) => request.path === "/mcp")
}

async function connected(): Promise<{ hub: Hub; home: string; env: Record<string, string> }> {
  const hub = await startHub({ toolCall: () => ({ text: JSON.stringify({ ok: true }) }) })
  const home = tempHome()
  writeText(join(adapterPaths(home).home, "agents", "workbuddy.id"), "container-1\n")
  return { hub, home, env: hubEnv(hub, home) }
}

describe("MCP 桥", () => {
  it("剥离会话提示并转成请求头；stdout 全是 JSON-RPC 帧", async () => {
    const { hub, env } = await connected()
    const bridge = runBridge(env)
    try {
      bridge.send(INIT)
      await bridge.waitFor(1)
      bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { to: "agent-9", [SESSION_ARG]: "session-1" } },
      })
      const reply = await bridge.waitFor(2)
      expect(reply?.["error"]).toBeUndefined()

      // ① Hub 侧看不到提示键（否则会撞 MCP 入参严格校验）
      const args = hub.toolCalls[0] as Record<string, unknown>
      expect(args["to"]).toBe("agent-9")
      expect(Object.prototype.hasOwnProperty.call(args, SESSION_ARG)).toBe(false)

      // ② 逐请求头带上了会话值 + initialize 侧的身份头
      const calls = mcpRequests(hub)
      const last = calls[calls.length - 1]
      expect(last?.headers[SESSION_ARG]).toBe("session-1")
      expect(calls[0]?.headers["x-agent-id"]).toBe("container-1")

      // ③ stdout 纯净性
      expect(bridge.lines.length).toBeGreaterThan(0)
      for (const line of bridge.lines) {
        expect(isRecord(line)).toBe(true)
        if (isRecord(line)) expect(line["jsonrpc"]).toBe("2.0")
      }
    } finally {
      bridge.close()
      await hub.close()
    }
  })

  it("会话提示**变化**才重建 Hub 会话（同值不重复 initialize）", async () => {
    const { hub, env } = await connected()
    const bridge = runBridge(env)
    const call = (id: number, hint: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "send", arguments: { to: "a", [SESSION_ARG]: hint } },
    })
    try {
      bridge.send(INIT)
      await bridge.waitFor(1)
      bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      bridge.send(call(2, "s-1"))
      await bridge.waitFor(2)
      const afterFirst = initializeCount(hub)
      bridge.send(call(3, "s-1"))
      await bridge.waitFor(3)
      expect(initializeCount(hub)).toBe(afterFirst) // 同值 → 不重建
      bridge.send(call(4, "s-2"))
      await bridge.waitFor(4)
      expect(initializeCount(hub)).toBe(afterFirst + 1) // 变化 → 重建一次
      expect(mcpRequests(hub).at(-1)?.headers[SESSION_ARG]).toBe("s-2")
    } finally {
      bridge.close()
      await hub.close()
    }
  })

  it("容忍非法输入且不污染 stdout（非法行只落日志）", async () => {
    const { hub, home, env } = await connected()
    const bridge = runBridge(env)
    try {
      bridge.sendRaw("this is not json")
      bridge.send(INIT)
      await bridge.waitFor(1)
      expect(bridge.lines.every((line) => isRecord(line) && line["jsonrpc"] === "2.0")).toBe(true)
      expect(readLog(home)).toContain("ignore invalid JSON")
    } finally {
      bridge.close()
      await hub.close()
    }
  })

  it("Hub 不可达 → JSON-RPC error 回给宿主且进程存活（不拖垮宿主）", async () => {
    const hub = await startHub()
    const deadUrl = hub.baseUrl
    await hub.close()
    const home = tempHome()
    writeText(join(adapterPaths(home).home, "agents", "workbuddy.id"), "container-1\n")
    const bridge = runBridge({ AGENTCHAT_HOME: home, HUB_TOKEN: "t", AGENTCHAT_URL: deadUrl })
    try {
      bridge.send(INIT)
      const first = await bridge.waitFor(1)
      expect(first?.["error"]).toBeDefined()
      // 进程仍存活：再发一条仍能收到回复（而不是 EOF）
      bridge.send({ jsonrpc: "2.0", id: 9, method: "tools/list" })
      const second = await bridge.waitFor(9)
      expect(second?.["error"]).toBeDefined()
    } finally {
      bridge.close()
    }
  })

  it("401 给出可诊断的 token 提示（而不是静默失败）", async () => {
    const hub = await startHub({ alwaysUnauthorized: true })
    const home = tempHome()
    const bridge = runBridge(hubEnv(hub, home))
    try {
      bridge.send(INIT)
      const reply = await bridge.waitFor(1)
      expect(String((reply?.["error"] as Record<string, unknown> | undefined)?.["message"])).toContain("401")
      expect(readLog(home)).toContain("401")
    } finally {
      bridge.close()
      await hub.close()
    }
  })
})
