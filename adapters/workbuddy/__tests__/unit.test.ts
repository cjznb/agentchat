/**
 * 纯函数单测：命名/短标识（§7 坑 1）、环境开关、会话提示注入与剥离、取件闭环的去重语义、
 * Hub 传输层的错误码解析与 401 自愈。
 */
import { afterEach, describe, expect, it } from "vitest"
import { HubToolError, hubConfig, mcpCall, parseRegisterReply, reportState } from "../lib/hub.mjs"
import { formatMessages, loadSeen, rememberSeen, refusedItems } from "../lib/flush.mjs"
import { aliasedName, injectSessionHint, isOurTool, SESSION_ARG, takeSessionHint } from "../lib/session-hint.mjs"
import { sessionNodeName } from "../lib/register.mjs"
import { adapterPaths } from "../lib/paths.mjs"
import { writeToken } from "../lib/token.mjs"
import { baseNameOf, envFlag, envInt, shortSessionId } from "../lib/util.mjs"
import { cleanupHomes, startHub, tempHome } from "./harness"

afterEach(() => cleanupHomes())

describe("命名纪律（指南 §7 坑 1）", () => {
  it("剥掉宿主 id 的固定前缀再截断，避免同目录多会话撞名", () => {
    // 宿主 id 形如 `session-<uuid>`，前缀恰好 8 字符 —— 直接截前 8 位会让所有会话同名。
    const a = "session-aaaaaaaa-1111-2222-3333-444444444444"
    const b = "session-bbbbbbbb-1111-2222-3333-444444444444"
    expect(shortSessionId(a)).not.toBe(shortSessionId(b))
    expect(shortSessionId(a)).toBe("aaaaaaaa")
    expect(shortSessionId("ses_zzz")).toBe("zzz")
    expect(shortSessionId("plain-id-123")).toBe("plain-id")
    expect(sessionNodeName("D:\\work\\proj", a)).toBe("proj-aaaaaaaa")
    expect(sessionNodeName("D:\\work\\proj", b)).toBe("proj-bbbbbbbb")
  })

  it("目录名取最后一段，`/` 与 `\\` 双分隔符兼容", () => {
    expect(baseNameOf("D:\\projects\\agent\\agentchat")).toBe("agentchat")
    expect(baseNameOf("/home/me/proj")).toBe("proj")
    expect(baseNameOf("")).toBe("workbuddy")
  })

  it("撞名时用**稳定**别名重试（同一会话每次得到同一别名，重复事件幂等）", () => {
    const id = "session-abcdefgh-0000"
    expect(aliasedName("proj-abcdefgh", id)).toBe("proj-abcdefgh~sess")
    expect(aliasedName("proj-abcdefgh", id)).toBe(aliasedName("proj-abcdefgh", id))
  })
})

describe("环境开关", () => {
  it("envInt 钳制区间且 0 是合法值", () => {
    expect(envInt({ A: "5000" }, "A", 10, 0, 120000)).toBe(5000)
    expect(envInt({ A: "0" }, "A", 10, 0, 120000)).toBe(0)
    expect(envInt({ A: "999999" }, "A", 10, 0, 120000)).toBe(120000)
    expect(envInt({}, "A", 10, 0, 120000)).toBe(10)
    expect(envInt({ A: "abc" }, "A", 10, 0, 120000)).toBe(10)
  })

  it("envFlag 接受常见真值/假值，缺省回落", () => {
    expect(envFlag({ A: "1" }, "A", false)).toBe(true)
    expect(envFlag({ A: "TRUE" }, "A", false)).toBe(true)
    expect(envFlag({ A: "off" }, "A", true)).toBe(false)
    expect(envFlag({}, "A", true)).toBe(true)
    expect(envFlag({ A: "maybe" }, "A", true)).toBe(true)
  })
})

describe("逐会话出站身份（指南 §5）", () => {
  it("只对**本适配器**工具生效（不触碰用户其它 MCP server）", () => {
    expect(isOurTool("mcp__agentchat__send")).toBe(true)
    expect(isOurTool("agentchat_inbox")).toBe(true)
    expect(isOurTool("mcp__other__send")).toBe(false)
    expect(isOurTool("Bash")).toBe(false)
    expect(injectSessionHint("Bash", { command: "ls" }, "s1")).toBeUndefined()
  })

  it("回传**完整**入参（宿主整体替换 modifiedInput，增量子集会让原字段丢失）", () => {
    const input = { to: "agent-9", body: "hi" }
    const out = injectSessionHint("mcp__agentchat__send", input, "session-1")
    expect(out).toEqual({ to: "agent-9", body: "hi", [SESSION_ARG]: "session-1" })
    expect(input).toEqual({ to: "agent-9", body: "hi" }) // 原对象不被就地污染
  })

  it("桥侧剥离：提示键**必被删除**（Hub 绝不能看到），并回传其值", () => {
    const message = { method: "tools/call", params: { name: "send", arguments: { to: "a", [SESSION_ARG]: "session-1" } } }
    const { args, hint } = takeSessionHint(message)
    expect(hint).toBe("session-1")
    expect(args).toEqual({ to: "a" })
    expect(JSON.stringify(message)).not.toContain(SESSION_ARG)
  })

  it("非 tools/call / 无提示键 → 不改动入参且不产生头值", () => {
    const other = { method: "tools/list", params: {} }
    expect(takeSessionHint(other)).toEqual({ args: undefined, hint: undefined })
    const noKey = { method: "tools/call", params: { name: "send", arguments: { to: "a" } } }
    expect(takeSessionHint(noKey)).toEqual({ args: { to: "a" }, hint: undefined })
    const blank = { method: "tools/call", params: { name: "send", arguments: { [SESSION_ARG]: "  " } } }
    expect(takeSessionHint(blank).hint).toBeUndefined()
  })
})

describe("取件闭环去重集合（有界）", () => {
  it("记住并读回 messageId；超上限 FIFO 淘汰", () => {
    const paths = adapterPaths(tempHome())
    rememberSeen(paths, ["m1", "m2"])
    expect([...loadSeen(paths)]).toEqual(["m1", "m2"])
    const many = Array.from({ length: 250 }, (_value, index) => `x${index}`)
    rememberSeen(paths, many)
    const seen = loadSeen(paths)
    expect(seen.size).toBe(200)
    expect(seen.has("x249")).toBe(true)
    expect(seen.has("m1")).toBe(false)
  })

  it("注入正文带稳定前缀 + messageId（便于回执对账）", () => {
    const text = formatMessages([{ id: "m-77", fromAgentId: "agent-x", body: "需求变更" } as never])
    expect(text.startsWith("[AgentChat]")).toBe(true)
    expect(text).toContain("[m-77]")
    expect(text).toContain("agent-x")
  })

  it("注入头带 R1/R2 两条沟通规则：无观众不重发、回人类不复述工具输出", () => {
    const text = formatMessages([{ id: "m-88", fromAgentId: "agent-y", body: "hello" } as never])
    expect(text).toContain("没有观众")
    expect(text).toContain("复述一遍")
  })

  it("refused 项的 result 值必须与 delivered 不同（refused 不计入去重集合）", () => {
    expect(refusedItems([{ id: "m-1" } as never])).toEqual([{ messageId: "m-1", result: "refused" }])
  })
})

describe("Hub MCP 回复解析", () => {
  it("支持裸 JSON 与 SSE 两种回复体", () => {
    const body = JSON.stringify({ agent: { id: "a1" }, join_token: "jt" })
    const inner = JSON.stringify({ result: { content: [{ type: "text", text: body }] } })
    expect(parseRegisterReply(inner)).toEqual({ agentId: "a1", joinToken: "jt" })
    expect(parseRegisterReply(`data: ${inner}\n\n`)).toEqual({ agentId: "a1", joinToken: "jt" })
  })

  it("isError → 抛带**稳定 code** 的 HubToolError（供降级分流）", () => {
    const inner = JSON.stringify({
      result: { isError: true, content: [{ type: "text", text: "agent name already taken: x [name_taken]" }] },
    })
    try {
      parseRegisterReply(`data: ${inner}\n\n`)
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(HubToolError)
      expect((error as HubToolError).code).toBe("name_taken")
    }
  })
})

describe("传输层：401 自愈与 5xx 退避（指南 §4.1）", () => {
  it("401 且磁盘 token 已更新 → 用**新值**重试一次", async () => {
    const hub = await startHub({ alwaysUnauthorized: true })
    const home = tempHome()
    writeToken(`${home}/hub_token`, "fresh-token")
    const config = { ...hubConfig({ AGENTCHAT_URL: hub.baseUrl, HUB_TOKEN: "stale-token" }, home), attempts: 1 }
    await expect(reportState(config, "a1", "idle")).rejects.toThrow()
    // 第一次（401）+ 自愈重试一次（仍 401）→ 恰好 2 次，绝不循环。
    expect(hub.requests.length).toBe(2)
    expect(hub.requests[1]?.headers["authorization"]).toBe("Bearer fresh-token")
    await hub.close()
  })

  it("401 且磁盘无新值 → 不重试", async () => {
    const hub = await startHub({ alwaysUnauthorized: true })
    const home = tempHome()
    const config = { ...hubConfig({ AGENTCHAT_URL: hub.baseUrl, HUB_TOKEN: "same" }, home), attempts: 1 }
    await expect(reportState(config, "a1", "idle")).rejects.toThrow()
    expect(hub.requests.length).toBe(1)
    await hub.close()
  })

  it("5xx 退避重试后成功；4xx 立即返回不重试", async () => {
    const flaky = await startHub({ failInternalTimes: 2 })
    const home = tempHome()
    await reportState({ ...hubConfig({ AGENTCHAT_URL: flaky.baseUrl, HUB_TOKEN: "t" }, home), attempts: 4 }, "a1", "idle")
    expect(flaky.requests.filter((r) => r.path === "/internal/state").length).toBe(3)
    await flaky.close()

    const deterministic = await startHub({ internal: () => ({ status: 400, body: { error: "bad" } }) })
    await expect(reportState({ ...hubConfig({ AGENTCHAT_URL: deterministic.baseUrl, HUB_TOKEN: "t" }, home), attempts: 4 }, "a1", "idle")).rejects.toThrow()
    expect(deterministic.requests.length).toBe(1)
    await deterministic.close()
  })
})

describe("mcpCall：身份头只在 initialize 生效", () => {
  it("把手写身份与逐请求会话提示分别放进 initialize 头与 tools/call 头", async () => {
    const hub = await startHub({ toolCall: () => ({ text: JSON.stringify({ message: { id: "m1", fromAgentId: "s-1" } }) }) })
    const home = tempHome()
    const config = { ...hubConfig({ AGENTCHAT_URL: hub.baseUrl, HUB_TOKEN: "t" }, home), attempts: 1 }
    const out = await mcpCall(config, "send", { to: "a" }, "container-id", "session-1")
    expect((out as { message: { fromAgentId: string } }).message.fromAgentId).toBe("s-1")
    const mcpRequests = hub.requests.filter((r) => r.path === "/mcp")
    expect(mcpRequests[0]?.headers["x-agent-id"]).toBe("container-id")
    const call = mcpRequests[mcpRequests.length - 1]
    expect(call?.headers[SESSION_ARG]).toBe("session-1")
    await hub.close()
  })
})
