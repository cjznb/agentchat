/**
 * T13 矩阵 · 文件 8/8：暴露问题回归 B（D07–D12、N11、N26）。
 *
 * P3（task-9：忙时取件 + 心跳状态）与 P4（task-10：工具可发现性）在本矩阵定稿时**正在并发落地**，
 * 故这里一律**先按"修好后的正确行为"断言**；跑测时若某项尚未落地，用例会红，届时按那一刻的实际
 * 状态改标 `it.fails` + 任务号（并在 `docs/test-matrix.md` 标注"待 P#/task-# 修复后翻转"）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { REFUSAL_LIMIT, jobText } from "../lib/scenario-kit.mjs"
import { createMatrixCtx, dumpOf, short, toolFailed, toolText, type MatrixCtx } from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-db-")
})

afterEach(async () => {
  await ctx.cleanup()
})

type ToolLike = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }

/** 取工具某个入参的 description（缺/空 → undefined）。 */
function propDescription(tool: ToolLike | undefined, field: string): string | undefined {
  const prop = tool?.inputSchema?.properties?.[field]
  if (typeof prop !== "object" || prop === null) return undefined
  const description = (prop as { description?: unknown }).description
  return typeof description === "string" && description !== "" ? description : undefined
}

describe("T13-B 暴露问题回归 B（R9/P3/P4/P6 与工具面）", () => {
  it("D07 （R9）refused×2 终态 + 发送方系统通知（真 Dispatcher 失败扫描，幂等不重发）", async () => {
    const host = ctx.host("d07")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "d07" })
    host.deliver.refuseNext(2)
    await host.flush(b.agentId, b.agentId)
    await host.flush(b.agentId, b.agentId)
    const job = await host.jobOf(sent.message.seq, b.agentId)
    expect(job, `连续 ${REFUSAL_LIMIT} 次拒收 → 终态 refused（${jobText(job)}）`).toMatchObject({
      state: "refused",
    })

    await ctx.dispatcher().tick()
    const dump = await dumpOf(host)
    const notice = dump.messages.find(
      (message) => message.from_agent_id === b.agentId && String(message.meta).includes("wake_failed"),
    )
    expect(notice, "发送方必须收到 wake_failed 系统通知").toBeTruthy()
    expect(notice?.kind).toBe("system")
    expect(notice?.conversation_id, "通知必须落在原会话").toBe(sent.message.conversationId)
    expect(notice?.body).toContain("拒收")
    expect((await host.jobOf(sent.message.seq, b.agentId))?.notified_at).toBeTypeOf("number")

    await ctx.dispatcher().tick()
    expect(
      (await dumpOf(host)).messages.filter((message) => String(message.meta).includes("wake_failed")),
      "失败通知必须幂等（条件更新 notified_at，不重复发）",
    ).toHaveLength(1)
  })

  it("D08 （P5/task-11 已修）容器入群不再静默假成功：409 container_not_group_member 且零 participant", async () => {
    const host = ctx.host("d08")
    const sessions = await ctx.sessions(host, ["a"])
    const container = host.root!.agentId
    const group = await host.createGroup("d08-g", [sessions["a"]!.agentId])
    const added = await host.httpJson(`/api/test/conversations/${group.conversation.id}/members`, {
      body: { agentId: container },
    })
    expect({ status: added.status, error: (added.json as { error?: string }).error }).toEqual({
      status: 409,
      error: "container_not_group_member",
    })
    const dump = await dumpOf(host)
    expect(
      dump.participants.filter((row) => row.conversation_id === group.conversation.id && row.agent_id === container),
      "容器一行 participant 都不得写入",
    ).toHaveLength(0)
    expect(
      dump.messages.some((message) => String(message.meta).includes("group_add")),
      "被拒的拉人不得留入群通知（零半写）",
    ).toBe(false)
  })

  it("D09 （P5/task-11 已修）容器 x-agent-id 视为无身份：identity_required 且零容器署名消息；register 免身份", async () => {
    const host = ctx.host("d09")
    const sessions = await ctx.sessions(host, ["b"])
    const client = await ctx.mcp({ "x-agent-id": host.root!.agentId })
    const send = await client.callTool({
      name: "send",
      arguments: { to: sessions["b"]!.agentId, body: "d09 容器发言" },
    })
    expect(toolFailed(send), "容器身份不得能发送").toBe(true)
    expect(toolText(send)).toContain("identity_required")
    const shout = await client.callTool({ name: "shout", arguments: { body: "d09 全员" } })
    expect(toolText(shout)).toContain("identity_required")

    const dump = await dumpOf(host)
    expect(dump.messages, "零消息（含零容器署名）").toHaveLength(0)
    expect(dump.conversations, "不得自动建 DM 毒化会话").toHaveLength(0)
    const registered = await client.callTool({
      name: "register",
      arguments: { name: "d09-free-register", kind: "runtime", vendor: host.vendor },
    })
    expect(toolFailed(registered), `register 不需要身份：${toolText(registered)}`).toBe(false)
  })

  it("D10 （P3/task-9）忙时取件：busy 下仍可认领并回报 delivered，状态全程保持 busy", async () => {
    const host = ctx.host("d10")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    expect((await host.setState(b.agentId, "busy")).status).toBe(200)
    const sent = await host.send("a", { to: b.agentId, body: "d10" })
    expect(await host.jobOf(sent.message.seq, b.agentId), "忙时先排队").toMatchObject({
      state: "pending",
      pending_reason: "busy",
    })

    // P3 核心契约：忙时**继续取件**（DSH 是 pull 厂商，停了就没人投）。这里按协议层驱动：
    // 认领 → 注入 → 回报执，全程不发送 idle 心跳。
    const wake = await host.httpJson("/internal/wake", { body: { agentId: b.agentId } })
    expect(wake.status).toBe(200)
    const claimed = (wake.json as { messages: { id: string }[] }).messages.map((message) => message.id)
    expect(claimed, `busy 期间必须能认领（msg=${sent.message.id}）`).toContain(sent.message.id)
    const result = await host.httpJson("/internal/result", {
      body: { agentId: b.agentId, items: [{ messageId: sent.message.id, result: "delivered" }] },
    })
    expect(result.status).toBe(200)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect(
      (await dumpOf(host)).agents.find((row) => row.id === b.agentId)?.status,
      `忙时不得被回退为 online（agent=${short(b.agentId)}）`,
    ).toBe("busy")
  })

  it("D11 （P3/task-9）忙时心跳不得把 Hub 的 busy 翻成 online（Hub 侧不变量）", async () => {
    const host = ctx.host("d11")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    expect((await host.setState(b.agentId, "busy")).status).toBe(200)
    // P3 要求忙时心跳上报 busy（`flush` 的 heartbeat 已参数化 state: "idle"|"busy"）：
    // Hub 侧必须保持 busy（同态上报 = 心跳触碰，绝不回退）。
    expect((await host.setState(b.agentId, "busy")).status).toBe(200)
    expect((await dumpOf(host)).agents.find((row) => row.id === b.agentId)?.status).toBe("busy")
    // 状态回退的反例（旧实现：忙时发 idle → online）必须被 Hub 拒绝吗？不——Hub 白名单允许
    // busy→online（这是"重激活"语义）。因此**适配器必须发 busy**这件事由 task-9 的
    // `adapters/dsh/__tests__`（真插件 harness）覆盖；L0 假宿主的心跳模型恒 idle，
    // 不能用来验证适配器行为（见 docs/test-matrix.md「未覆盖/近似」）。
    expect(true).toBe(true)
  })

  it.fails("D12 （P4/task-10，待修 → 落地后翻转）注入头必须含会话 id 与「要回复就用 send」指引", async () => {
    const host = ctx.host("d12")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "d12 body" })
    await host.flush(b.agentId, b.agentId)
    const text = host.inboxOf(b.agentId).join("\n")
    // 现状（task-13 跑测时）：`adapters/dsh/lib/flush.js` 的 `formatMessages` 仍只有两行头部 +
    // 消息行，**不渲染会话 id、也没有 send 指引** → 本用例失败即"待 P4/task-10 修复"的证据。
    // 该文件在 task-10 的写域内（`adapters/dsh/lib/flush.js`），本任务不改生产码。
    expect(text, "注入头必须渲染会话 id（否则 agent 不知回给哪个会话）").toContain(
      sent.message.conversationId,
    )
    expect(text, "注入头必须给出「要回复就用 send」指引").toContain("send")
  })

  it("D12b 错误文案 code 仍在行尾（`lib/mcp.js` 解析契约，恒须成立）", async () => {
    const host = ctx.host("d12b")
    await ctx.sessions(host, ["a"])
    await expect(host.call("a", "send", { to: "no-such-agent", body: "x" })).rejects.toThrow(
      /\[[a-z_]+\]\s*$/,
    )
  })

  it("N11 忙碌中投递：busy 期间排队、取件即送达（P3/task-9）；urgency 档位待 P6/task-12", async () => {
    const host = ctx.host("n11")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    expect((await host.setState(b.agentId, "busy")).status).toBe(200)
    const sent = await host.send("a", { to: b.agentId, body: "n11" })
    expect(await host.jobOf(sent.message.seq, b.agentId), "忙时只能排队").toMatchObject({
      state: "pending",
      pending_reason: "busy",
    })
    expect(host.deliveries, "没有取件触发者时零注入").toHaveLength(0)

    // 忙时取件（P3）：报 busy 心跳 + wake + 回报执，Hub 保持 busy。
    expect((await host.setState(b.agentId, "busy")).status).toBe(200)
    const wake = await host.httpJson("/internal/wake", { body: { agentId: b.agentId } })
    const ids = (wake.json as { messages: { id: string }[] }).messages.map((message) => message.id)
    expect(ids).toContain(sent.message.id)
    await host.httpJson("/internal/result", {
      body: { agentId: b.agentId, items: [{ messageId: sent.message.id, result: "delivered" }] },
    })
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })

    // P6/task-12（urgency 三档 + 插队/打断映射）尚未落地：`urgency` 不是契约字段，
    // 经 zod 静默剥离 → 库内无痕迹。本断言锁"现状"，待 P6 落地后**翻转为正向断言**。
    const urgent = await host.send("a", { to: b.agentId, body: "n11 urgent", urgency: "urgent" })
    const row = (await dumpOf(host)).messages.find((message) => message.seq === urgent.message.seq)
    const meta = JSON.parse(row?.meta ?? "{}") as { urgency?: unknown }
    expect(meta.urgency, "P6/task-12 未落地：urgency 尚未进 meta").toBeUndefined()
  })

  it("N26 （P4/task-10）instructions 非空含关键约束；12 条描述含何时/常见错误；关键字段有 description", async () => {
    const client = await ctx.mcp()
    const instructions = client.getInstructions()
    expect(instructions, "MCP instructions 必须非空（DSH 只消费这一条全局说明通道）").toBeTruthy()
    for (const keyword of ["register", "inbox", "ack", "send", "容器", "identity_required"]) {
      expect(instructions ?? "", `instructions 必须含关键约束「${keyword}」`).toContain(keyword)
    }

    const tools = (await client.listTools()).tools as unknown as ToolLike[]
    expect(tools, "MCP_TOOLS 恒为 12").toHaveLength(12)
    for (const tool of tools) {
      expect(tool.description, `${tool.name} 缺 description`).toBeTruthy()
      expect(tool.description ?? "", `${tool.name} 的描述缺「何时」`).toContain("何时")
      expect(tool.description ?? "", `${tool.name} 的描述缺「常见错误」`).toContain("常见错误")
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const send = byName.get("send")
    for (const field of ["to", "mentions", "wait"]) {
      expect(propDescription(send, field), `send.${field} 缺参数级 description`).toBeTruthy()
    }
    for (const field of ["task_ref", "parent_ref"]) {
      expect(propDescription(byName.get("register"), field), `register.${field} 缺 description`).toBeTruthy()
    }
    for (const field of ["op", "name", "member_ids", "group", "member"]) {
      expect(propDescription(byName.get("group"), field), `group.${field} 缺 description`).toBeTruthy()
    }
    expect(propDescription(byName.get("ask"), "mentions"), "ask.mentions 缺 description").toBeTruthy()
    expect(propDescription(byName.get("ask"), "allow_custom"), "ask.allow_custom 缺 description").toBeTruthy()
  })
})
