/**
 * T13 矩阵 · 文件 1/6：注册 · 状态机 · 身份（N01–N04、N27、N28）。
 *
 * 运行：`npx vitest run adapters/test/__tests__`（矩阵统一入口）。
 * 夹具见 `./matrix-kit.ts`（真 Hub + T6 无头假宿主 + 真 MCP SDK 客户端）；ID 与判定口径见
 * `docs/test-matrix.md`。每条断言都带 agentId/messageId 短码，失败信息可直接定位。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertInjectionPrefix,
  collectIds,
  createMatrixCtx,
  dumpOf,
  jobsOf,
  participantIds,
  short,
  toolText,
  type MatrixCtx,
} from "./matrix-kit"

let ctx: MatrixCtx

beforeEach(async () => {
  ctx = await createMatrixCtx("agentchat-t13-reg-")
})

afterEach(async () => {
  await ctx.cleanup()
})

describe("T13-A 正常使用：注册与身份", () => {
  it("N01 首次注册根节点：join_token 重注册认领同一行（不新增行）；裸重名 409 name_taken", async () => {
    const host = ctx.host("n01")
    const first = await host.registerRoot({ name: "n01-root" })
    expect((await dumpOf(host)).agents.filter((agent) => agent.name === "n01-root")).toHaveLength(1)

    const claimed = await host.registerRoot({ name: "n01-root", joinToken: first.joinToken })
    expect(
      claimed.agentId,
      `join_token 重注册应认领同一节点：first=${short(first.agentId)} claimed=${short(claimed.agentId)}`,
    ).toBe(first.agentId)
    expect((await dumpOf(host)).agents).toHaveLength(1)

    // 不带 token 的裸重名是**另一条**语义：Hub 拒绝而非收养（幂等只由 join_token 提供）。
    await expect(
      host.hub.register({ vendor: host.vendor, name: "n01-root" }),
    ).rejects.toMatchObject({ code: "name_taken" })
    expect((await dumpOf(host)).agents).toHaveLength(1)
  })

  it("N02 子会话注册：同 task_ref 重连认领同一节点且 parent 不改写；缺 task_ref 报 task_ref_required", async () => {
    const host = ctx.host("n02")
    await host.registerRoot({ name: "n02-root" })
    const rootId = host.root!.agentId
    const args = { vendor: host.vendor, parent_ref: rootId, task_ref: "n02-a" }
    const first = await host.hub.register({ ...args, name: "n02-sess" })
    const again = await host.hub.register({ ...args, name: "n02-renamed" })
    expect(
      again.agentId,
      `同 task_ref 重连必须认领同一节点：first=${short(first.agentId)} again=${short(again.agentId)}`,
    ).toBe(first.agentId)

    const rows = (await dumpOf(host)).agents.filter((agent) => agent.task_ref === "n02-a")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parent_id, "parent_ref 幂等重连不得改写父节点").toBe(rootId)
    expect(rows[0]?.name, "已提供 name 时幂等重注册可更新卡片字段").toBe("n02-renamed")

    await expect(
      host.hub.register({ vendor: host.vendor, name: "n02-bad", parent_ref: rootId }),
    ).rejects.toMatchObject({ code: "task_ref_required" })
  })

  it("N03 逻辑节点：kind=logical/status=offline、roster 可见、可入群但只取件不建 job", async () => {
    const host = ctx.host("n03")
    await ctx.sessions(host, ["a"])
    const logical = await host.registerLogical({ name: "n03-logical" })
    const row = (await dumpOf(host)).agents.find((agent) => agent.id === logical.agentId)
    expect({ kind: row?.kind, status: row?.status }).toEqual({ kind: "logical", status: "offline" })

    const tree: unknown = await host.call("a", "roster", {})
    expect(collectIds(tree), "roster（真 MCP 工具）应含逻辑节点").toContain(logical.agentId)

    // P5 的入群守卫只拦容器 → 逻辑节点可入群（可见、可取件）。
    const group = await host.createGroup("n03-g", [logical.agentId])
    const gid = group.conversation.id
    expect(participantIds(await dumpOf(host), gid)).toContain(logical.agentId)

    const sent = await host.sendAsHuman(gid, "n03 group")
    const jobs = jobsOf(await dumpOf(host), sent.message.seq)
    expect(jobs.some((job) => job.agent_id === logical.agentId), "logical 不建 wake job（spec §14.4）").toBe(false)
    // 但逻辑节点**无门控**：仍能在 /internal/wake 取到该消息。
    const pulled = await host.hub.wake(logical.agentId)
    expect(pulled.map((message) => message.id)).toContain(sent.message.id)
  })

  it("N04 状态机：online→busy→idle(落库 online)；子节点 offline 409 child_never_offline；根 offline 200", async () => {
    const host = ctx.host("n04")
    const sessions = await ctx.sessions(host, ["a"])
    const a = sessions["a"]!
    expect((await host.setState(a.agentId, "online")).status).toBe(200)
    expect((await host.setState(a.agentId, "busy")).status).toBe(200)
    expect((await host.setState(a.agentId, "idle")).status).toBe(200)
    const row = (await dumpOf(host)).agents.find((agent) => agent.id === a.agentId)
    expect(row?.status, `idle 是适配器上报值，Hub 落库必须为 online（agent=${short(a.agentId)}）`).toBe("online")

    const child = await host.setState(a.agentId, "offline")
    expect(
      { status: child.status, error: child.error },
      `子节点永不置 offline（agent=${short(a.agentId)}）`,
    ).toEqual({ status: 409, error: "child_never_offline" })

    const rootId = host.root!.agentId
    expect((await host.setState(rootId, "offline")).status).toBe(200)
    expect((await dumpOf(host)).agents.find((agent) => agent.id === rootId)?.status).toBe("offline")
    // 有意裁决（勿扩矩阵）：展示态 offline 后必须先回 online/idle，busy 会被 409 transition_rejected。
    const revived = await host.setState(rootId, "busy")
    expect({ status: revived.status, error: revived.error }).toEqual({
      status: 409,
      error: "transition_rejected",
    })
    expect((await host.setState(rootId, "online")).status).toBe(200)
  })

  it("N27 身份：会话头命中即该会话身份、未命中→identity_required、绝不回落容器；register 免身份", async () => {
    const host = ctx.host("n27")
    const sessions = await ctx.sessions(host, ["a", "b"])
    const a = sessions["a"]!
    const b = sessions["b"]!
    const sent = await host.send("a", { to: b.agentId, body: "n27" })
    expect(sent.message.fromAgentId, `命中会话头 → 身份=该会话节点（a=${short(a.agentId)}）`).toBe(a.agentId)

    // 未命中：省略身份（不 400、不回落到容器），非 register 工具报 identity_required。
    await expect(
      host.call("no-such-task-ref", "send", { to: b.agentId, body: "n27-unresolved" }),
    ).rejects.toMatchObject({ code: "identity_required" })
    expect((await dumpOf(host)).messages.some((m) => m.body === "n27-unresolved")).toBe(false)

    // P5 fail-closed：x-agent-id=容器 + 未命中会话头 → 仍无身份，且零容器署名消息。
    const client = await ctx.mcp({
      "x-agent-id": host.root!.agentId,
      "x-agentchat-session": "no-such-ref",
    })
    const result = await client.callTool({ name: "send", arguments: { to: b.agentId, body: "n27-toxin" } })
    expect(toolText(result), "容器 x-agent-id 视为无身份（P5）").toContain("identity_required")
    const dump = await dumpOf(host)
    expect(dump.messages.some((m) => m.body === "n27-toxin")).toBe(false)
    expect(dump.messages.some((m) => m.from_agent_id === host.root!.agentId)).toBe(false)

    // register 不需要身份（影响面只限"需要身份"的工具）。
    const registered = (await host.call("no-such-task-ref", "register", {
      name: "n27-free-register",
      kind: "runtime",
      vendor: host.vendor,
    })) as { agent?: { id?: string } }
    expect(registered.agent?.id, "register 无身份也必须可用").toBeTruthy()
  })

  it("N28 换库/重置后重注册自愈（Hub 侧）：清库后新客户端以同 task_ref 重注册 → 新节点并可继续收发", async () => {
    const host = ctx.host("n28")
    const sessions = await ctx.sessions(host, ["a"])
    const staleId = sessions["a"]!.agentId
    await host.reset()
    expect((await dumpOf(host)).agents).toHaveLength(0)
    // 陈旧 nodeId 已不存在：/internal/wake 404 → 真 flush 闭环返回 false（不误报成功）。
    expect(
      await host.flush(staleId, staleId),
      `陈旧 nodeId 取件应失败（agent=${short(staleId)}），绝不假装成功`,
    ).toBe(false)

    // "清 sessions/陈旧 nodeId"后重新注册（新客户端 = 会话表清空）：Hub 侧自愈成立。
    const fresh = ctx.host("n28-b")
    await fresh.registerRoot({ name: "n28-root" })
    const again = await fresh.registerSession({ taskRef: "a", name: "a" })
    expect(again.agentId, "换库后重注册必须得到新节点").not.toBe(staleId)
    const dump = await dumpOf(fresh)
    expect(dump.agents.filter((agent) => agent.task_ref === "a")).toHaveLength(1)
    expect(dump.agents.find((agent) => agent.id === again.agentId)?.task_ref).toBe("a")

    const peer = await fresh.registerSession({ taskRef: "b", name: "b" })
    const sent = await fresh.send("a", { to: peer.agentId, body: "n28-after-reset" })
    expect(await fresh.jobOf(sent.message.seq, peer.agentId)).toMatchObject({ state: "pending" })
    await fresh.flush(peer.agentId, peer.agentId)
    expect(await fresh.jobOf(sent.message.seq, peer.agentId)).toMatchObject({ state: "accepted" })
    expect(assertInjectionPrefix(fresh, peer.agentId)).toEqual([sent.message.id])
  })
})
