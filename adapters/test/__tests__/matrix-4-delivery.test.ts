/**
 * T13 矩阵 · 文件 4/8：喊话 · 拒收 · 在途租约 · 长跑稳定性（N09、N13、N14、N30）。
 * 常量（CLAIM_TIMEOUT_MS / REFUSAL_LIMIT）取自 `../lib/scenario-kit.mjs`（生产冻结值镜像）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CLAIM_TIMEOUT_MS, REFUSAL_LIMIT, waitFor } from "../lib/scenario-kit.mjs"
import {
  assertInjectionPrefix,
  createMatrixCtx,
  dumpOf,
  jobsOf,
  short,
  span,
  type MatrixCtx,
} from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-deliver-")
})

afterEach(async () => {
  await ctx.cleanup()
})

describe("T13-A 正常使用：喊话/拒收/租约/长跑", () => {
  it("N09 喊话广播：无 participants 的广播会话、容器被排除、逻辑节点不建 job、逐节点送达", async () => {
    const host = ctx.host("n09")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const containerId = host.root!.agentId
    const logical = await host.registerLogical({ name: "n09-logical" })

    const sent = await host.shoutAsHuman("n09 shout")
    const dump = await dumpOf(host)
    const shout = dump.conversations.find((row) => row.key === "shout")!
    expect(shout, "喊话会话 key='shout'").toBeTruthy()
    expect(
      dump.participants.filter((row) => row.conversation_id === shout.id),
      "广播会话不得有 participants 行",
    ).toHaveLength(0)

    const jobs = jobsOf(dump, sent.message.seq)
    expect(jobs.map((job) => job.agent_id).sort(), "只给 runtime 收件方建 job").toEqual(
      [a.agentId, b.agentId].sort(),
    )
    expect(jobs.some((job) => job.agent_id === containerId), "容器恒排除出收件方").toBe(false)
    expect(jobs.some((job) => job.agent_id === logical.agentId), "logical 不建 job").toBe(false)

    await host.flush(a.agentId, a.agentId)
    await host.flush(b.agentId, b.agentId)
    expect(assertInjectionPrefix(host, a.agentId)).toEqual([sent.message.id])
    expect(assertInjectionPrefix(host, b.agentId)).toEqual([sent.message.id])
    // logical 只取件（无门控），且事后仍无 job 行。
    const pulled = await host.hub.wake(logical.agentId)
    expect(pulled.map((message) => message.id)).toContain(sent.message.id)
    expect(
      (await dumpOf(host)).wakeJobs.filter((job) => job.agent_id === logical.agentId),
    ).toHaveLength(0)
  })

  it("N13 注入被拒：不写 seen、不置 accepted、后续重投；连续 REFUSAL_LIMIT 次转终态", async () => {
    const host = ctx.host("n13")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "n13" })
    const stage = async () =>
      (await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)

    host.deliver.refuseNext(1)
    await host.flush(b.agentId, b.agentId)
    expect(host.injectionsOf(b.agentId), "refused 也留一条注入录音").toHaveLength(1)
    expect(host.injectionsOf(b.agentId)[0]?.outcome).toBe("refused")
    expect(await host.jobOf(sent.message.seq, b.agentId), "refused 不得置 accepted").toMatchObject({
      state: "pending",
    })
    expect(await stage()).toBe("queued")

    host.deliver.refuseNext(1)
    await host.flush(b.agentId, b.agentId)
    expect(host.injectionsOf(b.agentId), "refused 不写 seen → 必须重投").toHaveLength(2)
    expect(
      await host.jobOf(sent.message.seq, b.agentId),
      `连续 ${REFUSAL_LIMIT} 次拒收 → 终态 refused（msg=${sent.message.id}）`,
    ).toMatchObject({ state: "refused" })

    await host.flush(b.agentId, b.agentId)
    expect(host.injectionsOf(b.agentId), "终态后不再重投").toHaveLength(2)
    expect(await stage(), "失败态回执口径：仍 queued（不新增阶段）").toBe("queued")
  })

  it("N14 在途租约：认领未回执 → 租约内不重复认领 → 过期重投且只补回执不重复注入", async () => {
    const host = ctx.host("n14")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "n14" })

    host.deliver.suppressReceiptNext(1)
    expect(await host.flush(b.agentId, b.agentId), "回报执失败 → 本轮失败").toBe(false)
    const claimed = await host.jobOf(sent.message.seq, b.agentId)
    expect(claimed).toMatchObject({ state: "sending", attempts: 1 })
    const lease = (claimed?.retry_at ?? 0) - Date.now()
    expect(
      lease,
      `认领应置 CLAIM_TIMEOUT_MS(${CLAIM_TIMEOUT_MS}) 在途租约 —— ${span(lease, 20_000, 40_000, "租约")}`,
    ).toBeGreaterThan(20_000)
    expect(lease).toBeLessThan(40_000)

    // 租约内：不重复认领、不重复注入。
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "sending", attempts: 1 })
    expect(host.injectionsOf(b.agentId)).toHaveLength(1)

    // 推过租约（-60s，远大于任何跨进程时钟偏斜）→ 重投：seen 去重，只补回执。
    ctx.run(
      "UPDATE wake_jobs SET retry_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'sending'",
      Date.now() - 60_000,
      sent.message.seq,
      b.agentId,
    )
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(host.injectionsOf(b.agentId), "重投不得重复注入已注入内容").toHaveLength(1)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe(
      "delivered",
    )
  })

  it("N30 长跑稳定性：30 个投递周期无重复注入、无泄漏、轮询器不重叠执行", async () => {
    const host = ctx.host("n30")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    // 注入加 20ms 延迟：若 IdlePoller 重叠执行，两次注入的起始时刻会挤在一起（poll.js 纪律）。
    host.deliver.setDelay(20)
    const stop = host.startPolling(b.agentId, b.agentId, { intervalMs: 40 })
    const sentIds: string[] = []
    try {
      for (let cycle = 0; cycle < 30; cycle += 1) {
        const sent = await host.send("a", { to: b.agentId, body: `n30-${cycle}` })
        sentIds.push(sent.message.id)
        const arrived = await waitFor(() => host.injectedIdsOf(b.agentId).includes(sent.message.id), 3_000)
        expect(arrived, `第 ${cycle} 周期未在窗口内送达（msg=${sent.message.id}）`).toBe(true)
      }
    } finally {
      stop()
    }

    const injected = assertInjectionPrefix(host, b.agentId)
    expect(injected, "30 周期恰 30 次注入（seen 去重无重复）").toHaveLength(30)
    expect(new Set(injected).size, "无重复注入").toBe(30)
    expect([...injected].sort()).toEqual([...sentIds].sort())
    const stamps = host.deliveries.map((entry) => entry.at).sort((left, right) => left - right)
    let minGap = Number.POSITIVE_INFINITY
    for (let index = 1; index < stamps.length; index += 1) {
      minGap = Math.min(minGap, stamps[index]! - stamps[index - 1]!)
    }
    expect(
      minGap,
      `轮询器不得重叠执行（delay=20ms，最小注入间隔 ${minGap}ms 应 ≥15ms）`,
    ).toBeGreaterThanOrEqual(15)
    const jobs = (await dumpOf(host)).wakeJobs.filter((job) => job.agent_id === b.agentId)
    expect(jobs, "每周期一行 job，无泄漏").toHaveLength(30)
    expect(jobs.filter((job) => job.state !== "accepted"), `不得有非终态残留（${short(b.agentId)}）`).toHaveLength(0)
  })
})
