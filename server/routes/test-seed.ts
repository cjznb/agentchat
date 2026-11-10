/**
 * `/api/test/*` 的**夹具与生命周期端点**（1–4：ping / dump / reset / seed 与两阶段夹具逻辑；
 * 15/16：dissolve 解散群、DELETE 单条消息——与造夹具同属会话/消息的生命周期两端）
 * + seed 两阶段夹具逻辑。
 *
 * 自 `routes/test.ts` 拆出（本仓硬约束「单文件 ≤ 250 纯行」，CONTRIBUTING.md:80）。
 * 安全模型（env 开关 `AGENTCHAT_TEST_API` 由 `server/index.ts` 决定是否挂载 + 仅回环 +
 * 「这是测试面，含破坏性操作，绝不可对生产库开启」）与 `/api/admin/reset` 的差异见
 * `routes/test.ts` 文件头；本模块所有 handler 均由入口传入的 `handle`
 *（`test-schemas.guarded` 外壳）包裹，故同样自守、同样自转 JSON。
 */
import { Hono } from "hono"
import { dissolveGroup } from "../core/group-ops"
import { ensureHuman } from "../core/permissions"
import { clearAllTables, type Db } from "../db"
import { insertAgent } from "../store/agents"
import { createDm, createGroup } from "../store/conversations"
import { deleteMessageById, send } from "../store/messages"
import {
  GROUP_OP_STATUS,
  pathId,
  resetBodySchema,
  resolveAgentRef,
  resolveConversationRef,
  seedBodySchema,
  type SeedBody,
  type TestHandle,
} from "./test-schemas"

/** seed 写入期引用解析失败：写入前已全部预解析，此处是防御性兜底（事务回滚 → 零写入）。 */
class SeedRefNotFound extends Error {
  constructor(readonly ref: string) {
    super(`seed reference not found: ${ref}`)
    this.name = "SeedRefNotFound"
  }
}

/** seed 结果判别联合：路由层只做 HTTP 映射，不重复业务判断（也便于独立测试）。 */
export type SeedOutcome =
  | {
      readonly ok: true
      readonly agents: { name: string; id: string }[]
      readonly conversations: { ref: string; id: string; key: string; kind: string }[]
      readonly messages: { id: string; seq: number }[]
    }
  | { readonly ok: false; readonly error: "invalid_body" }
  | { readonly ok: false; readonly error: "seed_ref_not_found"; readonly detail: string }
  | { readonly ok: false; readonly error: "name_taken" }

/**
 * 造夹具：agents → conversations → messages 一次写完。
 * 引用解析**全部在写入前完成**（含 seed 内的前向父子引用与环检测）；写入整体包一个事务，
 * 任何中途失败都回滚 —— 解析失败或半写都不可能留下脏库。conversations/messages 走 store 直写
 * （不过审批闸门、不触发 wake/publish），专为造夹具。
 */
export function runSeed(database: Db, body: SeedBody): SeedOutcome {
  const agents = body.agents ?? []
  const conversations = body.conversations ?? []
  const messages = body.messages ?? []
  const seedNames = new Set(agents.map((agent) => agent.name))
  if (seedNames.size !== agents.length) return { ok: false, error: "name_taken" }

  // —— 阶段一：零写入预解析 ——
  // 4a. seed 内 agents 的父子依赖拓扑（insertAgent 需要父的真实 id，父必须先落库）。
  const deps = new Map<string, string>()
  for (const agent of agents) {
    if (agent.parentId === undefined) continue
    if (resolveAgentRef(database, agent.parentId) !== undefined) continue
    // 父引用既不在库里、又不是 seed 内节点名（或自引用）→ 解析不到。
    if (!seedNames.has(agent.parentId) || agent.parentId === agent.name) {
      return { ok: false, error: "seed_ref_not_found", detail: agent.parentId }
    }
    deps.set(agent.name, agent.parentId)
  }
  const pending = new Map(agents.map((agent) => [agent.name, agent]))
  const orderedAgents: typeof agents = []
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((agent) => {
      const parent = deps.get(agent.name)
      return parent === undefined || !pending.has(parent)
    })
    if (ready.length === 0) {
      // 环（A→B→A）：所有父引用都"存在"但永远无法满足 —— 报第一个卡住的父引用。
      const stuck = [...pending.values()][0]
      return { ok: false, error: "seed_ref_not_found", detail: stuck?.parentId ?? "" }
    }
    for (const agent of ready) {
      pending.delete(agent.name)
      orderedAgents.push(agent)
    }
  }

  // 4b. 会话 / 消息引用：能落到"库里已有节点"或"本请求将创建节点"才算通过。
  const aliasSet = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.ref === undefined) continue
    if (aliasSet.has(conversation.ref)) return { ok: false, error: "invalid_body" }
    aliasSet.add(conversation.ref)
  }
  const knownAgent = (ref: string): boolean =>
    seedNames.has(ref) || resolveAgentRef(database, ref) !== undefined
  /**
   * 引用的**规范标识**：库里已有的按 id、本请求将创建的按名 —— 用于判定两个引用是否同一节点
   * （`a:"甲"` 与 `b:"<甲的 id>"` 是同一人，必须同样被拦）。
   */
  const agentToken = (ref: string): string | undefined => {
    const existing = resolveAgentRef(database, ref)
    if (existing !== undefined) return `db:${existing.id}`
    return seedNames.has(ref) ? `seed:${ref}` : undefined
  }
  for (const conversation of conversations) {
    const refs =
      conversation.kind === "dm"
        ? [conversation.a, conversation.b]
        : [
            ...(conversation.createdBy === undefined ? [] : [conversation.createdBy]),
            ...(conversation.memberIds ?? []),
          ]
    const bad = refs.find((ref) => !knownAgent(ref))
    if (bad !== undefined) return { ok: false, error: "seed_ref_not_found", detail: bad }
    // DM 两端同一节点：`createDm` 会给同一 agent 插两行 participants 撞主键。写前按形状非法
    // 拦成 400（与 `POST /api/test/conversations` 的 DM 分支同码），而不是让它落进写入期的
    // UNIQUE 分支被报成 409 name_taken —— 那是误导性错误码。
    if (conversation.kind === "dm" && agentToken(conversation.a) === agentToken(conversation.b)) {
      return { ok: false, error: "invalid_body" }
    }
  }
  for (const message of messages) {
    if (!knownAgent(message.from)) {
      return { ok: false, error: "seed_ref_not_found", detail: message.from }
    }
    const ref = message.conversationId ?? message.conversationKey ?? ""
    if (!aliasSet.has(ref) && resolveConversationRef(database, ref) === undefined) {
      return { ok: false, error: "seed_ref_not_found", detail: ref }
    }
  }

  // —— 阶段二：写入（单事务）——
  try {
    const created = database.transaction(() => {
      const requireAgent = (ref: string) => {
        const agent = resolveAgentRef(database, ref)
        if (agent === undefined) throw new SeedRefNotFound(ref)
        return agent
      }
      const createdAgents: { name: string; id: string }[] = []
      for (const agent of orderedAgents) {
        const parent = agent.parentId === undefined ? undefined : requireAgent(agent.parentId)
        const record = insertAgent(database, {
          name: agent.name,
          kind: agent.kind ?? "logical",
          status: agent.status ?? "online",
          vendor: agent.vendor ?? "opencode",
          ...(parent === undefined ? {} : { parentId: parent.id }),
          ...(agent.taskRef === undefined ? {} : { taskRef: agent.taskRef }),
          ...(agent.roleTag === undefined ? {} : { roleTag: agent.roleTag }),
          ...(agent.purpose === undefined ? {} : { purpose: agent.purpose }),
          ...(agent.model === undefined ? {} : { model: agent.model }),
        })
        createdAgents.push({ name: record.name, id: record.id })
      }
      const aliasMap = new Map<string, string>()
      const createdConversations: { ref: string; id: string; key: string; kind: string }[] = []
      for (const conversation of conversations) {
        const record =
          conversation.kind === "dm"
            ? createDm(database, requireAgent(conversation.a).id, requireAgent(conversation.b).id)
            : createGroup(database, {
                name: conversation.name,
                createdBy:
                  conversation.createdBy === undefined
                    ? ensureHuman(database).id
                    : requireAgent(conversation.createdBy).id,
                memberIds: (conversation.memberIds ?? []).map((ref) => requireAgent(ref).id),
              })
        if (conversation.ref !== undefined) aliasMap.set(conversation.ref, record.id)
        createdConversations.push({
          ref: conversation.ref ?? record.key,
          id: record.id,
          key: record.key,
          kind: record.kind,
        })
      }
      const createdMessages: { id: string; seq: number }[] = []
      for (const message of messages) {
        const ref = message.conversationId ?? message.conversationKey ?? ""
        const conversationId = aliasMap.get(ref) ?? resolveConversationRef(database, ref)?.id
        if (conversationId === undefined) throw new SeedRefNotFound(ref)
        // store.send 直写：**不**触发 wake/publish（造夹具不该惊动调度器）。
        const record = send(database, {
          conversationId,
          fromAgentId: requireAgent(message.from).id,
          body: message.body,
          ...(message.kind === undefined ? {} : { kind: message.kind }),
          ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
        })
        createdMessages.push({ id: record.id, seq: record.seq })
      }
      return { createdAgents, createdConversations, createdMessages }
    })()
    return {
      ok: true,
      agents: created.createdAgents,
      conversations: created.createdConversations,
      messages: created.createdMessages,
    }
  } catch (error) {
    if (error instanceof SeedRefNotFound) {
      return { ok: false, error: "seed_ref_not_found", detail: error.ref }
    }
    // 重名（UNIQUE）走与端点 18 同款稳定码，而不是裸 500。
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return { ok: false, error: "name_taken" }
    }
    throw error
  }
}

/** 夹具与生命周期路由组（由 `testRoutes` 以 `.route("/", seedRoutes(handle))` 接线）。 */
export function seedRoutes(handle: TestHandle): Hono {
  return new Hono()
    // 1. 探活（真机冒烟第一步：确认开关生效且回环可达）。
    .get("/api/test/ping", handle((c) => c.json({ ok: true, enabled: true })))
    // 2. 全库快照：八张表原始行（列名 snake_case，不做域对象映射）——测试直接断言的真相源。
    //    固定排序（rowid / messages 按 seq）以免 SQLite 返回顺序漂移导致断言抖动。
    .get(
      "/api/test/dump",
      handle((c, database) => {
        const natural = (table: string): unknown[] =>
          database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        return c.json({
          ok: true,
          agents: natural("agents"),
          conversations: natural("conversations"),
          participants: natural("participants"),
          messages: database.prepare("SELECT * FROM messages ORDER BY seq ASC").all(),
          approvals: natural("approvals"),
          wakeJobs: natural("wake_jobs"),
          readStates: natural("read_states"),
          agentKeys: natural("agent_keys"),
        })
      }),
    )
    // 3. 清库（测试面重置）：只 clearAllTables，无快照、不碰适配器文件（差异见 test.ts 文件头）。
    .post(
      "/api/test/reset",
      handle(async (c, database) => {
        const parsed = resetBodySchema.safeParse(await c.req.json().catch(() => undefined))
        if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
        clearAllTables(database)
        return c.json({ ok: true })
      }),
    )
    // 4. 造夹具（两阶段逻辑见 runSeed）。
    .post(
      "/api/test/seed",
      handle(async (c, database) => {
        const parsed = seedBodySchema.safeParse(await c.req.json().catch(() => undefined))
        if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
        const outcome = runSeed(database, parsed.data)
        if (outcome.ok) {
          return c.json({
            ok: true,
            agents: outcome.agents,
            conversations: outcome.conversations,
            messages: outcome.messages,
          })
        }
        if (outcome.error === "name_taken") return c.json({ ok: false, error: outcome.error }, 409)
        if (outcome.error === "invalid_body") return c.json({ ok: false, error: outcome.error }, 400)
        return c.json({ ok: false, error: outcome.error, detail: outcome.detail }, 400)
      }),
    )
    // 15. 解散群：唯一实现是 `core/group-ops.dissolveGroup`（与生产群路由同源）。
    .post(
      "/api/test/conversations/:id/dissolve",
      handle((c, database) => {
        const outcome = dissolveGroup(database, { conversationId: pathId(c) })
        return outcome.ok
          ? c.json({ ok: true })
          : c.json({ ok: false, error: outcome.error }, GROUP_OP_STATUS[outcome.error])
      }),
    )
    // 16. 删单条消息（同事务清掉引用它的 wake_jobs）。
    .delete(
      "/api/test/messages/:id",
      handle((c, database) =>
        deleteMessageById(database, pathId(c))
          ? c.json({ ok: true })
          : c.json({ ok: false, error: "message_not_found" }, 404),
      ),
    )
}
