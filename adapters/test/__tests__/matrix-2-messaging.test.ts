/**
 * T13 矩阵 · 文件 2/6：会话与提及（N05–N10 中的 N05/N06/N07/N08/N10）。
 * 夹具见 `./matrix-kit.ts`；ID 与判定口径见 `docs/test-matrix.md`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
  ctx = await createMatrixCtx("agentchat-t13-msg-")
})

afterEach(async () => {
  await ctx.cleanup()
})

describe("T13-A 正常使用：会话与提及", () => {
  it("N05 四级回执逐跳：queued→sending→delivered→read（job 原始行 + message_status 双证）", async () => {
    const host = ctx.host("n05")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "n05" })
    const id = sent.message.id
    const seq = sent.message.seq
    expect(sent.receipts, `send 即 queued 回执：${JSON.stringify(sent.receipts)}`).toEqual([
      { agentId: b.agentId, stage: "queued" },
    ])
    expect(await host.jobOf(seq, b.agentId)).toMatchObject({ state: "pending", attempts: 0 })

    // ② 在途：注入成功但回报执崩掉 → job 停在 sending 租约（绝不直接 accepted）。
    host.deliver.suppressReceiptNext(1)
    expect(await host.flush(b.agentId, b.agentId)).toBe(false)
    expect(await host.jobOf(seq, b.agentId)).toMatchObject({ state: "sending" })
    expect((await host.receiptsOf([id], "a")).get(`${id}:${b.agentId}`)).toBe("sending")

    // ③ 租约未过期：不重复认领、不重复注入；推过租约后重投且 seen 去重只补回执。
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(host.injectionsOf(b.agentId), `租约内不得重复注入（agent=${short(b.agentId)}）`).toHaveLength(1)
    ctx.run(
      "UPDATE wake_jobs SET retry_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'sending'",
      Date.now() - 60_000,
      seq,
      b.agentId,
    )
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(host.injectionsOf(b.agentId)).toHaveLength(1)
    expect(await host.jobOf(seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect((await host.receiptsOf([id], "a")).get(`${id}:${b.agentId}`)).toBe("delivered")

    // ④ read 仅由 ack 触发（回执派生读 read_states）。
    expect((await host.ack("b", [id])).confirmed).toBe(1)
    expect((await host.receiptsOf([id], "a")).get(`${id}:${b.agentId}`)).toBe("read")
    const read = (await dumpOf(host)).readStates.find((row) => row.agent_id === b.agentId)
    expect(read?.last_read_seq).toBe(seq)
    expect(assertInjectionPrefix(host, b.agentId)).toEqual([id])
  })

  it("N06 私聊自动建会话与幂等：to=<agent id> 无既有 DM → 建；二次发送复用同一会话", async () => {
    const host = ctx.host("n06")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const first = await host.send("a", { to: b.agentId, body: "n06-1" })
    const dm = (await dumpOf(host)).conversations[0]!
    expect(dm, `首次发送应自动建 DM（key=dm:<idA>_<idB>）`).toMatchObject({
      kind: "dm",
      key: `dm:${[a.agentId, b.agentId].sort().join("_")}`,
    })
    expect(participantIds(await dumpOf(host), dm.id).sort()).toEqual([a.agentId, b.agentId].sort())

    const second = await host.send("a", { to: b.agentId, body: "n06-2" })
    expect(second.message.conversationId, "二次发送必须复用同一 DM").toBe(first.message.conversationId)
    expect((await dumpOf(host)).conversations).toHaveLength(1)

    await expect(host.call("a", "send", { to: "no-such-agent", body: "x" })).rejects.toMatchObject({
      code: "recipient_not_found",
    })
    expect((await dumpOf(host)).conversations, "解析不到的收件方不得建会话").toHaveLength(1)
  })

  it("N07 群：建群(owner+成员)、human/agent 两种发送者、成员增删、解散后级联清空", async () => {
    const host = ctx.host("n07")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const a = sessions["a"]!
    const c = sessions["c"]!
    const group = await host.createGroup("n07-g", [a.agentId, sessions["b"]!.agentId])
    const gid = group.conversation.id
    const created = await dumpOf(host)
    const human = created.agents.find((agent) => agent.vendor === "human")!
    expect(
      created.participants.find((row) => row.conversation_id === gid && row.agent_id === human.id)?.role,
      "建群者（human）应为 owner",
    ).toBe("owner")
    expect(participantIds(created, gid), `群成员：owner+2 成员（gid=${short(gid)}）`).toHaveLength(3)

    // human 发送：不带 @ → 回落全体参与者。
    const byHuman = await host.sendAsHuman(gid, "n07 human msg")
    expect(jobsOf(await dumpOf(host), byHuman.message.seq).map((job) => job.agent_id).sort()).toEqual(
      [a.agentId, sessions["b"]!.agentId].sort(),
    )
    // agent 发送：成员可发；不带 @ → 0 job（现行规格，详见 D03）。
    const byAgent = await host.send("a", { to: gid, body: "n07 agent msg" })
    expect(jobsOf(await dumpOf(host), byAgent.message.seq)).toHaveLength(0)
    // 非成员 agent 发既有会话 → 403 not_participant（human 超级观察者豁免）。
    await expect(host.call("c", "send", { to: gid, body: "n07 outsider" })).rejects.toMatchObject({
      code: "not_participant",
    })

    // 拉人：写 participants + 入群 system 通知（且 system 不建 job）。
    const added = await host.httpJson(`/api/test/conversations/${gid}/members`, { body: { agentId: c.agentId } })
    expect(added.status).toBe(200)
    const afterAdd = await dumpOf(host)
    expect(participantIds(afterAdd, gid)).toContain(c.agentId)
    const notice = messagesOf(afterAdd, gid).find((message) => String(message.meta).includes("group_add"))
    expect(notice, "入群必须有 group_add 系统通知").toBeTruthy()
    expect(jobsOf(afterAdd, notice!.seq), "system 消息豁免 wake job").toHaveLength(0)

    // 移出：写 system 通知 meta.action=group_remove。
    const removed = await host.httpJson(`/api/test/conversations/${gid}/members/remove`, {
      body: { agentId: c.agentId },
    })
    expect(removed.status).toBe(200)
    const afterRemove = await dumpOf(host)
    expect(participantIds(afterRemove, gid)).not.toContain(c.agentId)
    expect(messagesOf(afterRemove, gid).some((m) => String(m.meta).includes("group_remove"))).toBe(true)

    // 解散：会话 + 消息 + 成员 + 引用其消息的 job 全清。
    const seqs = messagesOf(afterRemove, gid).map((message) => message.seq)
    expect(seqs.length).toBeGreaterThan(0)
    const dissolved = await host.httpJson(`/api/test/conversations/${gid}/dissolve`, { body: {} })
    expect(dissolved.status).toBe(200)
    const afterDissolve = await dumpOf(host)
    expect(afterDissolve.conversations.find((row) => row.id === gid)).toBeUndefined()
    expect(messagesOf(afterDissolve, gid)).toHaveLength(0)
    expect(participantIds(afterDissolve, gid)).toHaveLength(0)
    expect(afterDissolve.wakeJobs.filter((job) => seqs.includes(job.message_id))).toHaveLength(0)
  })

  it("N08 群 @ 提及：命中/未命中/“*”/名字与 id 混写；无人被 @ 时 human 回落全员、agent 0 job", async () => {
    const host = ctx.host("n08")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const c = sessions["c"]!
    const group = await host.createGroup("n08-g", [a.agentId, b.agentId, c.agentId])
    const gid = group.conversation.id
    const jobsFor = async (seq: number) => jobsOf(await dumpOf(host), seq).map((job) => job.agent_id).sort()

    // ① 正文按名字命中：@b 只唤醒 b（发送者 a 恒排除）。
    const byName = await host.send("a", { to: gid, body: "@b 你好" })
    expect(byName.mentions, "群消息必须回 mention 回声").toMatchObject({ scope: "explicit" })
    expect(byName.mentions?.matched.map((m) => m.id)).toEqual([b.agentId])
    expect(await jobsFor(byName.message.seq), "@b 只应唤醒 b").toEqual([b.agentId])

    // ② human 的 @c：只唤醒 c。
    const byHuman = await host.sendAsHuman(gid, "@c 请看")
    expect(await jobsFor(byHuman.message.seq)).toEqual([c.agentId])

    // ③ "*" 全体关键字。
    const byAll = await host.sendAsHuman(gid, "@* 全员")
    expect(byAll.mentions?.scope).toBe("all")
    expect(await jobsFor(byAll.message.seq)).toEqual([a.agentId, b.agentId, c.agentId].sort())

    // ④ 名字与 id 混写（结构化 mentions 与正文并集、同 id 去重）。
    const mixed = await host.send("a", { to: gid, body: "@c 一起", mentions: [b.agentId] })
    expect(await jobsFor(mixed.message.seq)).toEqual([b.agentId, c.agentId].sort())

    // ⑤ 无人被 @：agent 发送 → 0 job；未命中 token 进 unmatched（现行规格 R5）。
    const none = await host.send("a", { to: gid, body: "n08 无提及" })
    expect(none.receipts, "agent 无 @ → 回执集为空（T=∅）").toEqual([])
    expect(await jobsFor(none.message.seq)).toEqual([])
    const miss = await host.send("a", { to: gid, body: "@ghost 在吗" })
    expect(miss.mentions?.unmatched).toContain("ghost")
    expect(await jobsFor(miss.message.seq), "未命中的 @ 不得唤醒任何人").toEqual([])
    // ⑥ 无人被 @ 且发送者是 human → 回落全员（规格）。
    const humanAll = await host.sendAsHuman(gid, "n08 human 无提及")
    expect(await jobsFor(humanAll.message.seq)).toEqual([a.agentId, b.agentId, c.agentId].sort())
  })

  it("N10 多收件方（群 3 人 + shout 多人）：各自独立注入一次、各自回执（P1 正面验证）", async () => {
    const host = ctx.host("n10")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const ids = ["a", "b", "c"].map((key) => sessions[key]!.agentId)
    const group = await host.createGroup("n10-g", ids)
    const gid = group.conversation.id
    const sent = await host.sendAsHuman(gid, "n10 group")
    expect(jobsOf(await dumpOf(host), sent.message.seq), "3 名成员各一行 job").toHaveLength(3)

    // 只 flush a：b/c 必须仍是排队（不得因 a 已注入而假报 delivered —— P1 修复的正面验证）。
    await host.flush(ids[0]!, ids[0]!)
    for (const other of [ids[1]!, ids[2]!]) {
      expect(
        jobsOf(await dumpOf(host), sent.message.seq).find((job) => job.agent_id === other),
        `未注入方必须仍 pending（agent=${short(other)}）`,
      ).toMatchObject({ state: "pending" })
      expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${other}`)).toBe("queued")
    }
    for (const id of ids.slice(1)) await host.flush(id, id)
    for (const id of ids) {
      expect(host.injectionsOf(id), `每个收件方各自注入恰 1 次（agent=${short(id)}）`).toHaveLength(1)
      expect(assertInjectionPrefix(host, id)).toEqual([sent.message.id])
      expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${id}`)).toBe("delivered")
    }

    // shout 多人：同一批人再各收一条，互不串扰（同进程多会话共用一条消息）。
    const shout = await host.shoutAsHuman("n10 shout")
    for (const id of ids) await host.flush(id, id)
    for (const id of ids) {
      expect(host.injectionsOf(id)).toHaveLength(2)
      expect(assertInjectionPrefix(host, id)).toEqual([sent.message.id, shout.message.id])
    }
  })
})
