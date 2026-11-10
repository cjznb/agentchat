/**
 * T13 矩阵 · 文件 5/8：大批量 · 多会话并发 · 宿主不可用（N21、N22、N23）。
 * N21 是 P2（task-8，取件页饥饿）的**正面验证**：>50 条后必须能推进到取空。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { freePort } from "../lib/hub-process.mjs"
import { sleep, waitFor } from "../lib/scenario-kit.mjs"
import {
  assertInjectionPrefix,
  createMatrixCtx,
  dumpOf,
  jobsOf,
  short,
  type MatrixCtx,
  type TestHost,
} from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-scale-")
})

afterEach(async () => {
  await ctx.cleanup()
})

/** 连续 flush 直到本轮零新增注入（= 取空）；返回轮数；不收敛直接失败。 */
async function drain(host: TestHost, agentId: string): Promise<number> {
  for (let round = 1; round <= 30; round += 1) {
    const before = host.deliveries.length
    expect(await host.flush(agentId, agentId), `第 ${round} 轮 flush 应成功（agent=${short(agentId)}）`).toBe(true)
    if (host.deliveries.length === before) return round
  }
  throw new Error(`取件未收敛：30 轮后仍有新注入（agent=${short(agentId)}）`)
}

describe("T13-A 正常使用：规模与可用性", () => {
  it("N21 大批量：60 条取空后再发 200 条仍能取空（P2 正面验证，无永久 pending）", async () => {
    const host = ctx.host("n21")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const dm = await host.createDm(sessions["a"]!.agentId, b.agentId)
    const gid = dm.conversation.id
    const inject = async (count: number, tag: string): Promise<void> => {
      for (let index = 0; index < count; index += 1) await host.sendAsHuman(gid, `${tag}-${index}`)
    }
    const jobsOfB = async () => (await dumpOf(host)).wakeJobs.filter((job) => job.agent_id === b.agentId)
    const pendingOf = (jobs: { state: string }[]) => jobs.filter((job) => job.state !== "accepted").length

    await inject(60, "n21a")
    const jobs60 = await jobsOfB()
    expect(jobs60, "60 条各一行 job").toHaveLength(60)
    expect(await drain(host, b.agentId), "60 条应在多轮内取空").toBeGreaterThanOrEqual(1)
    expect(pendingOf(await jobsOfB()), "60 条取空后不得有永久 pending").toBe(0)
    expect(assertInjectionPrefix(host, b.agentId), "60 条恰 60 次注入").toHaveLength(60)

    // 关键回归：已有 60 条可见消息之后，新到的 200 条不得被"最旧 50 条"窗口饿死。
    await inject(200, "n21b")
    expect(await jobsOfB(), "60+200 各一行 job").toHaveLength(260)
    await drain(host, b.agentId)
    expect(pendingOf(await jobsOfB()), "200 条取空后不得有永久 pending").toBe(0)
    const injected = assertInjectionPrefix(host, b.agentId)
    expect(injected, "260 条恰 260 次注入、无重复").toHaveLength(260)
    expect(new Set(injected).size).toBe(260)
  })

  it("N22 多会话并发：同进程 3+ 会话同时有消息，各自独立注入、无串扰（P1 正面验证）", async () => {
    const host = ctx.host("n22")
    const sessions = await ctx.sessions(host, ["a", "b", "c", "d"])
    const ids = ["a", "b", "c", "d"].map((key) => sessions[key]!.agentId)
    const group = await host.createGroup("n22-g", ids)
    const sent = await host.sendAsHuman(group.conversation.id, "n22 并发")
    const receivers = ids.slice(1)
    const stops = receivers.map((id) => host.startPolling(id, id, { intervalMs: 50 }))
    try {
      const all = await waitFor(
        () => receivers.every((id) => host.injectedIdsOf(id).includes(sent.message.id)),
        4_000,
      )
      expect(all, `3 个并发会话都应在窗口内收到（msg=${sent.message.id}）`).toBe(true)
    } finally {
      for (const stop of stops) stop()
    }
    for (const id of receivers) {
      expect(host.injectionsOf(id), `agent=${short(id)} 恰 1 次注入`).toHaveLength(1)
      expect(assertInjectionPrefix(host, id)).toEqual([sent.message.id])
    }
    // 未轮询的 a 必须仍是排队：未注入方不得假 delivered。
    const jobs = jobsOf(await dumpOf(host), sent.message.seq)
    expect(jobs.find((job) => job.agent_id === ids[0]), `未注入方（agent=${short(ids[0]!)}）`).toMatchObject({
      state: "pending",
    })
  })

  it("N23 宿主不可用：Hub 不可达 → 零注入、库内无假 delivered、失败退避；恢复后同一 nodeId 可送达", async () => {
    const host = ctx.host("n23")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "n23" })

    const port = await freePort()
    const unreachable = ctx.host("n23-dead", `http://127.0.0.1:${port}`)
    expect(await unreachable.flush(b.agentId, b.agentId), "Hub 不可达时 flush 必须报失败").toBe(false)
    expect(unreachable.deliveries, "不可达时零注入").toHaveLength(0)
    expect(
      await host.jobOf(sent.message.seq, b.agentId),
      "Hub 不可达绝不得被当成 delivered",
    ).toMatchObject({ state: "pending" })
    expect((await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`)).toBe("queued")

    // 退避：失败轮次按指数拉长（真 IdlePoller），不是每 50ms 自旋。
    const stop = unreachable.startPolling(b.agentId, b.agentId, { intervalMs: 50 })
    await sleep(700)
    stop()
    const failures = unreachable.logs.filter((line) => line.includes("wake failed")).length
    expect(failures, `700ms 内失败轮次应受退避限制（实际 ${failures} 次）`).toBeGreaterThanOrEqual(1)
    expect(failures, `700ms 内失败轮次应受退避限制（实际 ${failures} 次）`).toBeLessThanOrEqual(5)

    // 恢复：同一 nodeId 走可达 Hub（真 flush 闭环）→ 正常送达。
    expect(await host.flush(b.agentId, b.agentId)).toBe(true)
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({ state: "accepted" })
    expect(assertInjectionPrefix(host, b.agentId)).toEqual([sent.message.id])
  })
})
