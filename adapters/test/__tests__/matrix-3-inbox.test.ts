/**
 * T13 矩阵 · 文件 3/6：离线补投 · 幂等键 · 撤回 · 清空 · 读位点（N12、N15–N18）。
 * 时钟容差沿用 `../lib/scenario-kit.mjs` 的 `isDue`/`dueEvidence`（跨进程安全，绝不裸比 `Date.now()`）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { dueEvidence, isDue } from "../lib/scenario-kit.mjs"
import {
  assertInjectionPrefix,
  createMatrixCtx,
  dumpOf,
  jobsOf,
  messagesOf,
  participantIds,
  short,
  type MatrixCtx,
} from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-inbox-")
})

afterEach(async () => {
  await ctx.cleanup()
})

/** 惰性 human 行：`ensureHuman` 认 `name='用户'` 的既有行（这里显式造，免去"先喊话"的噪声）。 */
async function ensureHumanRow(host: ReturnType<MatrixCtx["host"]>): Promise<string> {
  const created = await host.httpJson("/api/test/agents", {
    body: { name: "用户", vendor: "human", kind: "logical", status: "offline" },
  })
  expect(created.status).toBe(200)
  return (created.json as { agent: { id: string } }).agent.id
}

describe("T13-A 正常使用：离线/幂等/撤回/清空/读位点", () => {
  it("N12 离线收件方：消息入库排队（pending_reason=null）、回 online 触发 makeJobsDue 后可取件", async () => {
    const host = ctx.host("n12")
    await host.registerRoot({ name: "n12-root" })
    await host.registerSession({ taskRef: "a", name: "a" })
    // 子节点不可 offline（N04）→ 用"不挂父的 runtime 根"承载离线。
    const b = await host.registerSession({ taskRef: "b", name: "b", parentRef: null })
    expect((await host.setState(b.agentId, "offline")).status).toBe(200)

    const sent = await host.send("a", { to: b.agentId, body: "n12-offline" })
    expect(await host.jobOf(sent.message.seq, b.agentId), "离线也建 job（spec §14.4）").toMatchObject({
      state: "pending",
      pending_reason: null,
    })
    expect(host.deliveries, "离线期间不注入").toHaveLength(0)

    // 人为把 retry_at 推到远期：证明解锁者是 online 上报的 makeJobsDue，而非时间流逝。
    ctx.run(
      "UPDATE wake_jobs SET retry_at = ? WHERE message_id = ? AND agent_id = ?",
      Date.now() + 3_600_000,
      sent.message.seq,
      b.agentId,
    )
    expect(isDue(await host.jobOf(sent.message.seq, b.agentId)), "远未到期").toBe(false)
    expect((await host.setState(b.agentId, "online")).status).toBe(200)
    const due = await host.jobOf(sent.message.seq, b.agentId)
    expect(isDue(due), `online 上报应立即到期（${dueEvidence(due)}）`).toBe(true)

    await host.flush(b.agentId, b.agentId)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect(assertInjectionPrefix(host, b.agentId)).toEqual([sent.message.id])
  })

  it("N15 幂等键：同 (from, idempotencyKey) 重发返回同一条消息、不新增行、不重复建 job", async () => {
    const host = ctx.host("n15")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const args = { to: b.agentId, body: "n15-dup", idempotencyKey: "n15-key" }
    const first = await host.send("a", args)
    const second = await host.send("a", args)
    expect(second.message.seq, `重发必须返回首条（id=${first.message.id}）`).toBe(first.message.seq)
    expect(second.message.id).toBe(first.message.id)
    const dump = await dumpOf(host)
    expect(messagesOf(dump, first.message.conversationId)).toHaveLength(1)
    expect(jobsOf(dump, first.message.seq)).toHaveLength(1)

    const third = await host.send("a", { ...args, idempotencyKey: "n15-key-2" })
    expect(third.message.id, "不同 key → 新消息").not.toBe(first.message.id)
    expect(messagesOf(await dumpOf(host), first.message.conversationId)).toHaveLength(2)
  })

  it("N16 撤回：未投递方绝不注入原文（只投系统提醒）；已投递副本保留原文（尽力撤回口径）", async () => {
    const host = ctx.host("n16")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const humanId = await ensureHumanRow(host)
    const dm = await host.createDm(humanId, b.agentId)
    const gid = dm.conversation.id

    // ① 未投递即撤回：job 取消；b 取件只可能拿到"已撤回"系统提醒。
    const sent = await host.sendAsHuman(gid, "n16 原文")
    const revoked = await host.httpJson(`/api/conversations/${gid}/messages/${sent.message.id}/revoke`)
    expect(revoked.status).toBe(200)
    const afterRevoke = await dumpOf(host)
    expect(afterRevoke.messages.find((row) => row.id === sent.message.id)?.revoked_at).toBeTruthy()
    expect(
      jobsOf(afterRevoke, sent.message.seq).find((job) => job.agent_id === b.agentId)?.state,
      `撤回必须取消未投递 job（msg=${sent.message.id}）`,
    ).toBe("cancelled")

    await host.flush(b.agentId, b.agentId)
    const injected = assertInjectionPrefix(host, b.agentId)
    expect(injected, "原文 messageId 绝不得出现在注入里").not.toContain(sent.message.id)
    expect(host.inboxOf(b.agentId).join("\n")).toContain("已被发送方撤回")

    // ② 已投递副本：a 先收到原文，再撤回 → a 侧读模型仍保留原文（发送方/已投递者不被遮蔽）。
    const dm2 = await host.createDm(humanId, a.agentId)
    const gid2 = dm2.conversation.id
    const sent2 = await host.sendAsHuman(gid2, "n16 已投递原文")
    await host.flush(a.agentId, a.agentId)
    expect(await host.jobOf(sent2.message.seq, a.agentId)).toMatchObject({ state: "accepted" })
    const rev2 = await host.httpJson(`/api/conversations/${gid2}/messages/${sent2.message.id}/revoke`)
    expect(rev2.status).toBe(200)
    const view = (await host.call("a", "conversation", { id: gid2 })) as {
      messages: { id: string; body: string }[]
    }
    expect(
      view.messages.find((message) => message.id === sent2.message.id)?.body,
      "已投递副本保留原文（尽力撤回不抹除已送达内容）",
    ).toBe("n16 已投递原文")
    expect(await host.jobOf(sent2.message.seq, a.agentId)).toMatchObject({ state: "accepted" })
  })

  it("N17 purge：会话消息与 job 清空、会话/成员/读位点保留", async () => {
    const host = ctx.host("n17")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const group = await host.createGroup("n17-g", [sessions["a"]!.agentId, sessions["b"]!.agentId])
    const gid = group.conversation.id
    await host.sendAsHuman(gid, "n17-1")
    await host.sendAsHuman(gid, "n17-2")
    await host.sendAsHuman(gid, "n17-3")
    expect((await host.markRead(gid, sessions["b"]!.agentId)).lastReadSeq).toBeGreaterThan(0)

    const before = await dumpOf(host)
    const seqs = messagesOf(before, gid).map((message) => message.seq)
    expect(seqs, `purge 前应有 3 条消息（gid=${short(gid)}）`).toHaveLength(3)
    expect(before.wakeJobs.filter((job) => seqs.includes(job.message_id)).length).toBeGreaterThan(0)
    expect(before.readStates.filter((row) => row.conversation_id === gid)).toHaveLength(1)

    const purged = await host.httpJson(`/api/test/conversations/${gid}/purge`)
    expect(purged.status).toBe(200)
    expect(purged.json).toMatchObject({ ok: true, deleted: 3 })
    const after = await dumpOf(host)
    expect(messagesOf(after, gid)).toHaveLength(0)
    expect(after.wakeJobs.filter((job) => seqs.includes(job.message_id)), "wake_jobs 必须无残留").toHaveLength(0)
    expect(participantIds(after, gid), "成员保留").toHaveLength(3)
    expect(after.conversations.find((row) => row.id === gid), "会话保留").toBeTruthy()
    // 现状口径：purge 只删 messages + wake_jobs，读位点保留（文档 test-matrix.md 已注明）。
    expect(after.readStates.filter((row) => row.conversation_id === gid)).toHaveLength(1)
  })

  it("N18 读位点与未读：ack 推进 read_states、未读聚合递减；human 超级观察者可读写任意会话", async () => {
    const host = ctx.host("n18")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const dm = await host.createDm(a.agentId, b.agentId)
    const gid = dm.conversation.id
    // human 不是该 DM 的成员，却可直接发言（超级观察者口径）。
    const m1 = await host.sendAsHuman(gid, "n18-1")
    const m2 = await host.sendAsHuman(gid, "n18-2")
    expect(participantIds(await dumpOf(host), gid).sort()).toEqual([a.agentId, b.agentId].sort())

    const inboxBefore = (await host.inbox("b", {})) as { messages: unknown[]; unread: number }
    expect(inboxBefore.unread, `b 的未读应为 2 条（msg=${m1.message.id},${m2.message.id}）`).toBe(2)

    await host.ack("b", [m1.message.id])
    const read = (await dumpOf(host)).readStates.find(
      (row) => row.conversation_id === gid && row.agent_id === b.agentId,
    )
    expect(read?.last_read_seq, "ack 只前进到被确认消息的 seq").toBe(m1.message.seq)
    expect(((await host.inbox("b", {})) as { unread: number }).unread).toBe(1)

    // human 读位点：测试面 read 缺省读者 = human，位点推进到最新 seq。
    const marked = await host.httpJson(`/api/test/conversations/${gid}/read`, { body: {} })
    expect(marked.status).toBe(200)
    const humanId = (await dumpOf(host)).agents.find((agent) => agent.vendor === "human")!.id
    const humanRead = (await dumpOf(host)).readStates.find(
      (row) => row.conversation_id === gid && row.agent_id === humanId,
    )
    expect(humanRead?.last_read_seq).toBe(m2.message.seq)
  })
})
