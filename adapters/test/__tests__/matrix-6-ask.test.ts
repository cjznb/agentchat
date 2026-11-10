/**
 * T13 矩阵 · 文件 6/8：ask/respond_ask · 审批 · 容器语义（N19、N19b、N20、N24）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { waitFor } from "../lib/scenario-kit.mjs"
import { createMatrixCtx, dumpOf, participantIds, short, toolFailed, toolText, type MatrixCtx } from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-ask-")
})

afterEach(async () => {
  await ctx.cleanup()
})

type AskView = { ask: { id: string; status: string; result?: { choice?: string; text?: string } } }

describe("T13-A 正常使用：批示 / 审批 / 容器", () => {
  it("N19 ask/respond_ask：选项单、自由文本、首答生效、超时", async () => {
    const host = ctx.host("n19")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    await host.createDm(a.agentId, b.agentId) // ask 到 agent 需要既有可沟通会话（不自动建）

    const created = (await host.call("a", "ask", {
      to: b.agentId,
      question: "n19 选项单",
      options: ["yes", "no"],
    })) as AskView
    const askId = created.ask.id
    expect(created.ask.status).toBe("pending")
    const card = (await dumpOf(host)).approvals.find((row) => row.id === askId)
    expect(card, `ask 必须落 approvals 行（ask=${short(askId)}）`).toMatchObject({
      kind: "ask",
      status: "pending",
      target: b.agentId,
    })

    // 非法选项 → invalid_choice（不消耗首答）。
    await expect(
      host.call("b", "respond_ask", { ask_id: askId, choice: "maybe" }),
    ).rejects.toMatchObject({ code: "invalid_choice" })
    // 合法选项 → answered；首答生效，二次答复被拒。
    const answered = (await host.call("b", "respond_ask", { ask_id: askId, choice: "yes" })) as {
      status: string
      result: { choice: string }
    }
    expect(answered).toMatchObject({ status: "answered", result: { choice: "yes" } })
    await expect(
      host.call("b", "respond_ask", { ask_id: askId, choice: "no" }),
    ).rejects.toMatchObject({ code: "ask_already_answered" })

    // 自由文本（allow_custom 缺省 true）。
    const free = (await host.call("a", "ask", {
      to: b.agentId,
      question: "n19 自由文本",
      options: [],
    })) as AskView
    const textAnswer = (await host.call("b", "respond_ask", {
      ask_id: free.ask.id,
      text: "自由答复内容",
    })) as { status: string; result: { text: string } }
    expect(textAnswer).toMatchObject({ status: "answered", result: { text: "自由答复内容" } })

    // 超时：无人答复 → timedOut（卡仍 pending）。
    const timed = (await host.call("a", "ask", {
      to: b.agentId,
      question: "n19 超时",
      options: ["y"],
      wait: { until: "either", timeoutMs: 300 },
    })) as AskView & { reply: { timedOut: boolean } }
    expect(timed.reply.timedOut).toBe(true)
    expect((await dumpOf(host)).approvals.find((row) => row.id === timed.ask.id)?.status).toBe("pending")
  })

  it("N19b 群 ask：mentions 必填、一目标一卡、scope=any 任一先回即返回", async () => {
    const host = ctx.host("n19b")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const c = sessions["c"]!
    const group = await host.createGroup("n19b-g", [a.agentId, b.agentId, c.agentId])
    const gid = group.conversation.id

    await expect(host.call("a", "ask", { to: gid, question: "n19b 无 mentions", options: ["y"] })).rejects.toMatchObject(
      { code: "mentions_required" },
    )

    const async2 = (await host.call("a", "ask", {
      to: gid,
      question: "n19b 异步群问",
      options: ["y", "n"],
      mentions: [b.agentId, c.agentId],
    })) as { asks: { id: string; target: string }[] }
    expect(async2.asks, "一目标一卡").toHaveLength(2)
    expect(async2.asks.map((ask) => ask.target).sort()).toEqual([b.agentId, c.agentId].sort())

    // scope=any：阻塞等待中先答一卡即返回（用 dump 在阻塞期间取卡 id）。
    const pendingCall = host.call("a", "ask", {
      to: gid,
      question: "n19b scope=any",
      options: ["y", "n"],
      mentions: [b.agentId, c.agentId],
      wait: { until: "either", timeoutMs: 4_000, scope: "any" },
    }) as Promise<{ asks: { id: string }[]; reply: { timedOut: boolean; replies: unknown[] } }>
    const ready = await waitFor(async () => {
      const rows = (await dumpOf(host)).approvals.filter(
        (row) => row.kind === "ask" && row.status === "pending" && String(row.payload).includes("n19b scope=any"),
      )
      return rows.length === 2
    }, 3_000)
    expect(ready, "阻塞期间应已落两张卡").toBe(true)
    const pendingRows = (await dumpOf(host)).approvals.filter(
      (row) => row.kind === "ask" && row.status === "pending" && String(row.payload).includes("n19b scope=any"),
    )
    // 并发应答必须走**另一条 MCP 会话**：`adapters/dsh/lib/mcp.js` 的 `rpc()` 每条调用都用
    // 硬编码 `id: 2`，同一会话上并发 tools/call 会撞 JSON-RPC id（应答被错投给挂起的 ask）。
    // 真实世界里"等待方"与"应答方"本就是不同进程/不同连接，故这里建独立连接（已上报 lead）。
    const responder = await ctx.mcp({ "x-agentchat-session": "b" })
    const respondResult = await responder.callTool({
      name: "respond_ask",
      arguments: { ask_id: pendingRows[0]!.id, choice: "y" },
    })
    expect(toolFailed(respondResult), `并发应答应成功：${toolText(respondResult)}`).toBe(false)
    const settled = await pendingCall
    expect(settled.reply.timedOut, "scope=any：任一先回即返回（不等待另一卡）").toBe(false)
    expect(settled.reply.replies).toHaveLength(1)
    expect(settled.asks).toHaveLength(2)
  })

  it("N20 审批：root agent 发起受限动作落审批单 → 批准执行 / 拒绝不执行 + 审批卡与回执", async () => {
    const host = ctx.host("n20")
    // 非容器 root（`role_tag:null`）：gate 对"持 agent_keys 的 runtime 根"才落审批单。
    const root = await host.registerRoot({ name: "n20-root", roleTag: null })
    await host.registerSession({ taskRef: "a", name: "a" })
    const rootId = root.agentId

    const first = (await host.httpJson("/api/test/shout", {
      body: { from: rootId, body: "n20 shout-1" },
    })) as { status: number; json: { approval: { id: string; action: string; status: string } } }
    expect(first.status).toBe(200)
    const approval = first.json.approval
    expect(approval, `root 喊话应落审批单（root=${short(rootId)}）`).toMatchObject({
      action: "shout",
      status: "pending",
    })
    const afterCard = await dumpOf(host)
    expect(afterCard.approvals.find((row) => row.id === approval.id)).toMatchObject({
      action: "shout",
      status: "pending",
      requester_agent_id: rootId,
    })
    expect(
      afterCard.messages.some((m) => m.kind === "system" && String(m.meta).includes(approval.id)),
      "审批卡必须落发起方↔用户 DM（system 消息）",
    ).toBe(true)
    expect(afterCard.messages.filter((m) => m.body === "n20 shout-1"), "未批准前不得执行").toHaveLength(0)

    const approved = await host.httpJson(`/api/approvals/${approval.id}`, { body: { decision: "approve" } })
    expect(approved.status).toBe(200)
    const afterApprove = await dumpOf(host)
    const shoutConv = afterApprove.conversations.find((row) => row.key === "shout")!
    expect(
      afterApprove.messages.filter((m) => m.conversation_id === shoutConv.id && m.body === "n20 shout-1"),
      "批准后必须执行喊话",
    ).toHaveLength(1)
    expect(
      afterApprove.messages.some((m) => String(m.meta).includes('"result":"approved"')),
      "批准必须有回执（meta.result=approved）",
    ).toBe(true)

    const second = (await host.httpJson("/api/test/shout", {
      body: { from: rootId, body: "n20 shout-2" },
    })) as { json: { approval: { id: string } } }
    const rejected = await host.httpJson(`/api/approvals/${second.json.approval.id}`, {
      body: { decision: "reject" },
    })
    expect(rejected.status).toBe(200)
    const afterReject = await dumpOf(host)
    expect(
      afterReject.messages.filter((m) => m.conversation_id === shoutConv.id && m.body === "n20 shout-2"),
      "拒绝后不得执行",
    ).toHaveLength(0)
    expect(afterReject.messages.some((m) => String(m.meta).includes('"result":"rejected"'))).toBe(true)
  })

  it("N24 容器语义：不可入群/作发送方/DM 收件方；x-agent-id 无身份；仍可心跳上报", async () => {
    const host = ctx.host("n24")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const container = host.root!.agentId

    const created = await host.httpJson("/api/test/conversations", {
      body: { kind: "group", name: "n24-g", memberIds: [container] },
    })
    expect({ status: created.status, error: (created.json as { error?: string }).error }).toEqual({
      status: 409,
      error: "container_not_group_member",
    })

    const group = await host.createGroup("n24-g2", [a.agentId])
    const gid = group.conversation.id
    const added = await host.httpJson(`/api/test/conversations/${gid}/members`, { body: { agentId: container } })
    expect({ status: added.status, error: (added.json as { error?: string }).error }).toEqual({
      status: 409,
      error: "container_not_group_member",
    })
    expect(participantIds(await dumpOf(host), gid)).not.toContain(container)

    const sent = await host.httpJson(`/api/test/conversations/${gid}/messages`, {
      body: { from: container, body: "n24 by container" },
    })
    expect({ status: sent.status, error: (sent.json as { error?: string }).error }).toEqual({
      status: 409,
      error: "container_cannot_send",
    })

    await expect(host.call("a", "send", { to: container, body: "n24 dm-new" })).rejects.toMatchObject({
      code: "container_not_chat_target",
    })
    const poisoned = await host.createDm(a.agentId, container) // 历史毒化数据形状（store 直写）
    await expect(
      host.call("a", "send", { to: poisoned.conversation.id, body: "n24 dm-existing" }),
    ).rejects.toMatchObject({ code: "container_not_chat_target" })

    const dump = await dumpOf(host)
    expect(dump.messages.some((m) => m.from_agent_id === container), "零容器署名消息").toBe(false)
    // 容器仍可心跳与状态上报（/internal/* 不受 P5 守卫影响）。
    expect((await host.setState(container, "busy")).status).toBe(200)
    expect((await dumpOf(host)).agents.find((row) => row.id === container)?.status).toBe("busy")
  })
})
