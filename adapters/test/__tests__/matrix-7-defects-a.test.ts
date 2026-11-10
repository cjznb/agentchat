/**
 * T13 矩阵 · 文件 7/8：暴露问题回归 A（D01–D06、N29）。
 *
 * ⚠️ `it.fails` 的语义：该用例断言的是**修好后的正确行为**，当前实现不满足 → 用例"失败"被
 * vitest 记为通过；一旦修复落地，它会变成"意外通过"而报红，**强制**下一个人把它改回普通 `it`。
 * 每条 `it.fails` 的标题与注释都写了归属任务号，绝不静默跳过。
 *
 * D06/N29 是**适配器侧**缺陷（R8/R10），修复点在 `adapters/**`（不在本任务写域），且 L0 假宿主
 * 无法驱动 DSH 插件 → 本文件的这两条是**显式标注的 L0 近似**，真机行为未直驱（见 docs/test-matrix.md
 * 的「未覆盖/近似」一节）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRegistrationRetry } from "../../dsh/lib/retry.js"
import { jobText, sleep } from "../lib/scenario-kit.mjs"
import {
  assertInjectionPrefix,
  createMatrixCtx,
  dumpOf,
  jobsOf,
  short,
  type MatrixCtx,
} from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-da-")
})

afterEach(async () => {
  await ctx.cleanup()
})

describe("T13-B 暴露问题回归 A（P1/P2/R5/R6/R7/R8/R10）", () => {
  it("D01 （P1/task-7 已修）同进程两会话共享一条消息：两者都注入、未注入方不得假 delivered", async () => {
    const host = ctx.host("d01")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const group = await host.createGroup("d01-g", [a.agentId, b.agentId])
    const sent = await host.sendAsHuman(group.conversation.id, "d01 同一条群消息")

    await host.flush(a.agentId, a.agentId)
    expect(host.injectedIdsOf(b.agentId), "未注入方此刻必须零注入").toEqual([])
    expect(await host.jobOf(sent.message.seq, b.agentId), "未注入方必须仍 pending").toMatchObject({
      state: "pending",
    })
    expect(
      (await host.receiptsOf([sent.message.id], "a")).get(`${sent.message.id}:${b.agentId}`),
      `未注入方不得出现 delivered（agent=${short(b.agentId)}）`,
    ).toBe("queued")

    await host.flush(b.agentId, b.agentId)
    expect(assertInjectionPrefix(host, a.agentId)).toEqual([sent.message.id])
    expect(assertInjectionPrefix(host, b.agentId)).toEqual([sent.message.id])
    const stages = await host.receiptsOf([sent.message.id], "a")
    expect({
      a: stages.get(`${sent.message.id}:${a.agentId}`),
      b: stages.get(`${sent.message.id}:${b.agentId}`),
    }).toEqual({ a: "delivered", b: "delivered" })
  })

  it("D02 （P2/task-8 已修）50 条取件页饥饿：60 条连续 wake 直到取空，无永久 pending", async () => {
    const host = ctx.host("d02")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const b = sessions["b"]!
    const dm = await host.createDm(sessions["a"]!.agentId, b.agentId)
    for (let index = 0; index < 60; index += 1) await host.sendAsHuman(dm.conversation.id, `d02-${index}`)

    let rounds = 0
    for (; rounds < 10; rounds += 1) {
      const before = host.deliveries.length
      expect(await host.flush(b.agentId, b.agentId)).toBe(true)
      if (host.deliveries.length === before) break
    }
    const jobs = (await dumpOf(host)).wakeJobs.filter((job) => job.agent_id === b.agentId)
    expect(jobs, "60 条各一行 job").toHaveLength(60)
    const stuck = jobs.filter((job) => job.state !== "accepted")
    expect(stuck, `取空后不得有永久 pending（${stuck.map((job) => jobText(job)).join(" / ")}）`).toHaveLength(0)
    expect(assertInjectionPrefix(host, b.agentId), "60 条恰 60 次注入").toHaveLength(60)
    expect(rounds).toBeLessThanOrEqual(10)
  })

  it("D03 （R5／现行规格）群聊 agent 非 @ 消息 0 job —— 按规格断言，非缺陷", async () => {
    const host = ctx.host("d03")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const group = await host.createGroup("d03-g", [
      sessions["a"]!.agentId,
      sessions["b"]!.agentId,
      sessions["c"]!.agentId,
    ])
    const sent = await host.send("a", { to: group.conversation.id, body: "d03 agent 无 @" })
    expect(
      jobsOf(await dumpOf(host), sent.message.seq),
      "现行规格：agent 在群里不发 @ 即 0 wake job（要改全员投递须先改规格）",
    ).toHaveLength(0)
    expect(sent.receipts, "回执集与 wake 集同源 → 空").toEqual([])
    // 对照：human 同场景回落全员（规格的另一半）。
    const human = await host.sendAsHuman(group.conversation.id, "d03 human 无 @")
    expect(jobsOf(await dumpOf(host), human.message.seq)).toHaveLength(3)
  })

  it("D04 （R6）@ 名字漂移：改名后按旧名 @ 不匹配（进 unmatched），且不误唤醒他人", async () => {
    const host = ctx.host("d04")
    const sessions = await ctx.sessions(host, ["a", "b", "c"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const group = await host.createGroup("d04-g", [
      a.agentId,
      b.agentId,
      sessions["c"]!.agentId,
    ])
    const renamed = await host.httpJson(`/api/test/agents/${b.agentId}`, {
      method: "PATCH",
      body: { name: "b-新名" },
    })
    expect(renamed.status).toBe(200)
    expect((await dumpOf(host)).agents.find((row) => row.id === b.agentId)?.custom_name).toBe("b-新名")

    const stale = await host.send("a", { to: group.conversation.id, body: "@b 旧名还在吗" })
    expect(stale.mentions?.matched, "旧名不得再命中").toEqual([])
    expect(stale.mentions?.unmatched, "旧名应进 unmatched（可诊断，不静默）").toContain("b")
    expect(
      jobsOf(await dumpOf(host), stale.message.seq),
      `失配不得误唤醒任何人（msg=${stale.message.id}）`,
    ).toHaveLength(0)

    const fresh = await host.send("a", { to: group.conversation.id, body: "@b-新名 在吗" })
    expect(fresh.mentions?.matched.map((mention) => mention.id), "新名必须命中").toEqual([b.agentId])
    expect(jobsOf(await dumpOf(host), fresh.message.seq).map((job) => job.agent_id)).toEqual([b.agentId])
  })

  it("D05 现状（R7 未修）：pending_reason=NULL 的积压永不过期、发送方永不收失败通知", async () => {
    const host = ctx.host("d05")
    await host.registerRoot({ name: "d05-root" })
    await host.registerSession({ taskRef: "a", name: "a" })
    const b = await host.registerSession({ taskRef: "b", name: "b", parentRef: null })
    expect((await host.setState(b.agentId, "offline")).status).toBe(200)
    const sent = await host.send("a", { to: b.agentId, body: "d05-offline" })
    expect(await host.jobOf(sent.message.seq, b.agentId)).toMatchObject({
      state: "pending",
      pending_reason: null,
      notified_at: null,
    })

    // 把时钟推过任何"看起来该超时"的窗口（48h ≫ busy TTL 24h）并跑真 dispatcher。
    await ctx.dispatcher().tick(Date.now() + 48 * 3_600_000)
    const job = await host.jobOf(sent.message.seq, b.agentId)
    // dispatcher 的退避会把 NULL 改写成 `offline`（见 deferWakeJob）；**两者都没有 TTL**。
    expect(job?.state, `现状：48h 后仍 pending（${jobText(job)}）`).toBe("pending")
    expect(job?.notified_at, "现状：notified_at 恒为 NULL").toBeNull()
    expect(
      job?.pending_reason === null || job?.pending_reason === "offline",
      `R7：NULL 与 offline 两类 pending_reason 都没有超时窗口（实际 ${String(job?.pending_reason)}）`,
    ).toBe(true)
    expect(
      (await dumpOf(host)).messages.some((message) => String(message.meta).includes("wake_failed")),
      "现状：发送方收不到失败通知",
    ).toBe(false)
  })

  it.fails("D05-期望（R7 待修）：pending_reason=NULL 的积压应最终过期并通知发送方", async () => {
    const host = ctx.host("d05x")
    await host.registerRoot({ name: "d05x-root" })
    await host.registerSession({ taskRef: "a", name: "a" })
    const b = await host.registerSession({ taskRef: "b", name: "b", parentRef: null })
    expect((await host.setState(b.agentId, "offline")).status).toBe(200)
    const sent = await host.send("a", { to: b.agentId, body: "d05x-offline" })

    await ctx.dispatcher().tick(Date.now() + 48 * 3_600_000)
    const job = await host.jobOf(sent.message.seq, b.agentId)
    expect(job?.state, `R7：NULL 原因积压应有超时终态（实际 ${jobText(job)}）`).toBe("expired")
  })

  it("D06 现状（R8 未修；L0 近似、真机行为未直驱）：陈旧 nodeId 取件只报失败，不自动补注册", async () => {
    const host = ctx.host("d06")
    const sessions = await ctx.sessions(host, ["a"])
    const staleId = sessions["a"]!.agentId
    await host.reset()
    expect(
      await host.flush(staleId, staleId),
      `L0 近似：真 flush 闭环在 404 下返回 false（agent=${short(staleId)}）`,
    ).toBe(false)
    expect(host.injectionsOf(staleId)).toHaveLength(0)
    expect((await dumpOf(host)).agents, "现状：不会发生任何补注册（R8）").toHaveLength(0)
  })

  it.fails("D06-期望（R8 待修；归属 task-14/P7 或独立任务；L0 近似、真机未直驱）：陈旧 nodeId 应自愈补注册", async () => {
    const host = ctx.host("d06x")
    const sessions = await ctx.sessions(host, ["a"])
    const staleId = sessions["a"]!.agentId
    await host.reset()
    await host.flush(staleId, staleId)
    // L0 近似：期望适配器在 404 后自动以原 task_ref 补注册（真机由 DSH 插件完成，本层无法直驱）。
    expect(
      (await dumpOf(host)).agents.map((agent) => agent.task_ref),
      "期望：旧 task_ref 被自动补注册",
    ).toContain("a")
  })

  it("N29 （R10 部分覆盖）补注册重试走真 IdlePoller：失败指数退避、不每轮自旋", async () => {
    // 真生产模块（`adapters/dsh/lib/retry.js`，task-9 依赖）：Hub 长期不可达时，
    // 补注册轮次必须受退避限制（IdlePoller 失败 doubling，上限 60s），而不是"每会话每轮一次"。
    const agent = { session: { header: { id: "n29-session" } } }
    const ctxLike = {
      get: (name: string) => (name === "agents" ? { list: () => [agent] } : undefined),
    }
    let attempts = 0
    const stop = createRegistrationRetry({
      intervalMs: 40,
      ctx: ctxLike,
      known: new Map<string, unknown>(),
      sessions: new Map<string, unknown>(),
      ensure: async () => {
        attempts += 1
        return undefined
      },
      log: () => undefined,
    })
    await sleep(700)
    stop()
    expect(attempts, `700ms 内补注册尝试应 ≥1（实际 ${attempts}）`).toBeGreaterThanOrEqual(1)
    expect(
      attempts,
      `700ms 内补注册尝试应受退避限制（40ms 基线无退避会 ≥10 次，实际 ${attempts} 次）`,
    ).toBeLessThanOrEqual(5)
  })
})
