/**
 * `/api/test/*`（测试面）的 zod 载荷 schema + **共享支撑**（守卫外壳 / 惰性库解析 / 引用解析）
 * + **节点端点组**（17–20：agents 列表/新建/改名/退役·硬删）。
 *
 * 自 `routes/test.ts` 拆出：本仓硬约束「单文件 ≤ 250 纯行（非空、非注释）」（CONTRIBUTING.md:80）。
 * 三文件分工（合计 ≤750 纯行的硬预算，故三份都承载一部分路由，非按名字严格划界）：
 * - 本文件：schema + 共享 helper + 节点端点（`agentRoutes`）——节点卡片的 schema 与其状态映射
 *   （退役/硬删/改名）本就同源，故就近归属。
 * - `test-seed.ts`：夹具与生命周期端点（1–4 ping/dump/reset/seed + 15/16 拆除类）。
 * - `test.ts`：入口（`testRoutes`/`TestRoutesOptions`）+ 会话与消息端点（5–14）+ 喊话（21）。
 *
 * 安全模型与 `/api/admin/reset` 的语义差异见 `routes/test.ts` 文件头（env 开关
 * `AGENTCHAT_TEST_API` 由 index.ts 决定是否挂载 + 仅回环 + 这是测试面，绝不可对生产库开启）。
 */
import { Hono, type Context } from "hono"
import { z } from "zod"
import { emitAgentTree, retire } from "../core/agents"
import { config } from "../config"
import { openDb, type Db } from "../db"
import {
  agentDisplayName,
  agentRenameSchema,
  AgentHasChildrenError,
  AgentInUseError,
  AgentNameTakenError,
  AgentNotFoundError,
  deleteAgentHard,
  getAgent,
  getAgentByName,
  insertAgent,
  listAgents,
  renameAgent,
} from "../store/agents"
import {
  getConversation,
  getConversationByKey,
  type Conversation,
} from "../store/conversations"

/** 破坏性清库的唯一确认口令（与 `/api/admin/reset` 同款「精确匹配」思路）。 */
export const resetBodySchema = z.object({ confirm: z.literal("RESET") })

export const seedAgentSchema = z.object({
  name: z.string().min(1),
  vendor: z.string().optional(),
  kind: z.enum(["runtime", "logical"]).optional(),
  status: z.enum(["online", "busy", "offline"]).optional(),
  taskRef: z.string().optional(),
  parentId: z.string().optional(),
  roleTag: z.string().optional(),
  purpose: z.string().optional(),
  model: z.string().optional(),
})

export const seedConversationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dm"),
    a: z.string().min(1),
    b: z.string().min(1),
    ref: z.string().optional(),
  }),
  z.object({
    kind: z.literal("group"),
    name: z.string().min(1),
    createdBy: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    ref: z.string().optional(),
  }),
])

export const seedMessageSchema = z
  .object({
    conversationId: z.string().optional(),
    conversationKey: z.string().optional(),
    from: z.string().min(1),
    body: z.string(),
    kind: z.enum(["text", "system"]).optional(),
    idempotencyKey: z.string().optional(),
  })
  // 「二选一」是载荷形状约束（都缺 / 都给都算 body 不合规），不是引用解析失败。
  .refine((value) => (value.conversationId === undefined) !== (value.conversationKey === undefined), {
    message: "exactly one of conversationId / conversationKey is required",
  })

export const seedBodySchema = z.object({
  agents: z.array(seedAgentSchema).optional(),
  conversations: z.array(seedConversationSchema).optional(),
  messages: z.array(seedMessageSchema).optional(),
})
export type SeedBody = z.infer<typeof seedBodySchema>

export const createConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dm"), a: z.string().min(1), b: z.string().min(1) }),
  z.object({
    kind: z.literal("group"),
    name: z.string().min(1),
    memberIds: z.array(z.string()).optional(),
  }),
])

export const sendBodySchema = z.object({
  from: z.string().min(1).optional(),
  body: z.string(),
  mentions: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
})

export const memberBodySchema = z.object({ agentId: z.string().min(1) })

export const addMemberBodySchema = z.object({
  agentId: z.string().min(1),
  role: z.enum(["owner", "member"]).optional(),
})

export const readBodySchema = z.object({ agentId: z.string().min(1).optional() })

export const createAgentBodySchema = z.object({
  name: z.string().min(1),
  vendor: z.string().optional(),
  kind: z.enum(["runtime", "logical"]).optional(),
  // 显式只允许三态：`retired` 属退役流程（端点 20 `mode=retire`），不作出生状态。
  status: z.enum(["online", "busy", "offline"]).optional(),
  taskRef: z.string().optional(),
  parentId: z.string().optional(),
  roleTag: z.string().optional(),
  purpose: z.string().optional(),
  model: z.string().optional(),
})

export const shoutBodySchema = z.object({ from: z.string().min(1).optional(), body: z.string() })

// —— 共享支撑（纯 helper，无路由注册；`agentRoutes` 除外）——

/** 生产缺省连接：同 `routes/ui.ts` 模式（首个请求按 `config.dbPath` 打开并复用，进程单例）。 */
let defaultDb: Db | undefined

export function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 路径参数：本模块所有带参路由的参数名都是 `id`（Hono 路由已保证其存在）。
 * 裸 `Context`（不带 path 字面量泛型）下 `c.req.param()` 被推成 `string | undefined`，
 * 此处统一收窄；真的缺失时取空串 → 后续一律落 404 not_found（安全侧）。
 */
export function pathId(c: Context): string {
  return c.req.param("id") ?? ""
}

/** 引用解析：节点按 id 或**系统名**（展示名不参与——改名后旧名不再是身份）。 */
export function resolveAgentRef(db: Db, ref: string) {
  return getAgent(db, ref) ?? getAgentByName(db, ref)
}

/** 会话引用解析：按会话 id 或 `key`（`dm:<a>_<b>` / `group:<id>` / `shout`）。 */
export function resolveConversationRef(db: Db, ref: string) {
  return getConversation(db, ref) ?? getConversationByKey(db, ref)
}

/** group-ops 错误码 → HTTP 状态（与现 `routes/groups.ts` 的守卫序/码逐字一致）。 */
export const GROUP_OP_STATUS = {
  conversation_not_found: 404,
  not_group: 400,
  not_in_group: 404,
  cannot_remove_last_member: 409,
} as const

/** handler 主体：拿已注入的库（`db` 缺省时由外壳惰性解析）。 */
export type TestHandler = (c: Context, db: Db) => Response | Promise<Response>
/** 已包壳的 handler：可直接注册进 Hono 路由表。 */
export type TestWrapped = (c: Context) => Promise<Response>
/** handler 包装器（由入口以 `guarded()` 闭包生成）。 */
export type TestHandle = (handler: TestHandler) => TestWrapped

/**
 * 统一 handler 外壳：回环守卫 → 惰性库解析 → 主体 try/catch（一切异常转 JSON）。
 * 三条不变式收敛在一处，避免 21 个 handler 各自漏写 catch 而落出非 JSON 500；
 * 语义与 `routes/admin.ts` 每个 handler 手写的守卫完全一致。
 */
export function guarded(
  db: Db | undefined,
  isLoopback: (c: Context) => boolean,
  handler: TestHandler,
): TestWrapped {
  return async (c: Context): Promise<Response> => {
    if (!isLoopback(c)) return c.json({ ok: false, error: "forbidden" }, 403)
    let database: Db
    try {
      database = resolveDb(db)
    } catch (error) {
      return c.json({ ok: false, error: "db_open_failed", detail: errorText(error) }, 500)
    }
    try {
      return await handler(c, database)
    } catch (error) {
      return c.json({ ok: false, error: "internal_error", detail: errorText(error) }, 500)
    }
  }
}

/** 会话存在性守卫：未知 → 404 `conversation_not_found`；存在则把会话交给 `run`。 */
export function withConversation(
  c: Context,
  db: Db,
  run: (conversation: Conversation) => Response,
): Response {
  const conversation = getConversation(db, pathId(c))
  return conversation === undefined
    ? c.json({ ok: false, error: "conversation_not_found" }, 404)
    : run(conversation)
}

/** 节点与广播端点组（17–21；由 `testRoutes` 以 `.route("/", agentRoutes(handle))` 接线）。 */
export function agentRoutes(handle: TestHandle): Hono {
  return new Hono()
    // 17. 节点列表。
    .get(
      "/api/test/agents",
      handle((c, database) => c.json({ ok: true, agents: listAgents(database) })),
    )
    // 18. 造节点：默认 vendor=opencode / kind=logical / status=online（与 seed 同口径）。
    .post(
      "/api/test/agents",
      handle(async (c, database) => {
        const parsed = createAgentBodySchema.safeParse(await c.req.json().catch(() => undefined))
        if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
        const input = parsed.data
        const parent = input.parentId === undefined ? undefined : resolveAgentRef(database, input.parentId)
        if (input.parentId !== undefined && parent === undefined) {
          return c.json({ ok: false, error: "agent_not_found" }, 404)
        }
        try {
          const agent = insertAgent(database, {
            name: input.name,
            kind: input.kind ?? "logical",
            status: input.status ?? "online",
            vendor: input.vendor ?? "opencode",
            ...(parent === undefined ? {} : { parentId: parent.id }),
            ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
            ...(input.roleTag === undefined ? {} : { roleTag: input.roleTag }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            ...(input.model === undefined ? {} : { model: input.model }),
          })
          return c.json({ ok: true, agent })
        } catch (error) {
          // SQLite UNIQUE（agents.name / task_ref / 展示名索引）→ 稳定 409，而不是裸 500。
          if (error instanceof Error && error.message.includes("UNIQUE")) {
            return c.json({ ok: false, error: "name_taken" }, 409)
          }
          throw error
        }
      }),
    )
    // 19. 节点改名：与 `routes/agent-rename.ts` 同语义（store 校验 + 广播 agent 树事件）。
    .patch(
      "/api/test/agents/:id",
      handle(async (c, database) => {
        const parsed = agentRenameSchema.safeParse(await c.req.json().catch(() => undefined))
        if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
        try {
          const agent = renameAgent(database, pathId(c), parsed.data.name)
          emitAgentTree(database)
          return c.json({ ok: true, name: agentDisplayName(agent) })
        } catch (error) {
          if (error instanceof AgentNotFoundError) {
            return c.json({ ok: false, error: "agent_not_found" }, 404)
          }
          if (error instanceof AgentNameTakenError) return c.json({ ok: false, error: error.code }, 409)
          throw error
        }
      }),
    )
    // 20. 删节点：`mode` 缺省 retire（可恢复，树上灰显保留）；hard 不可恢复，`force=1` 才连带清引用。
    .delete(
      "/api/test/agents/:id",
      handle((c, database) => {
        const mode = c.req.query("mode") ?? "retire"
        if (mode !== "retire" && mode !== "hard") {
          return c.json({ ok: false, error: "invalid_body" }, 400)
        }
        const id = pathId(c)
        const force = c.req.query("force")
        try {
          if (mode === "hard") {
            const report = deleteAgentHard(database, id, { force: force === "1" || force === "true" })
            return c.json({ ok: true, mode: "hard", report })
          }
          return c.json({ ok: true, mode: "retire", agent: retire(database, id) })
        } catch (error) {
          if (error instanceof AgentNotFoundError) {
            return c.json({ ok: false, error: "agent_not_found" }, 404)
          }
          // 拒删原因随 body 回传（count / refs），测试无需再查 dump 即知为何被拦。
          if (error instanceof AgentHasChildrenError) {
            return c.json({ ok: false, error: error.code, count: error.count }, 409)
          }
          if (error instanceof AgentInUseError) {
            return c.json({ ok: false, error: error.code, refs: error.refs }, 409)
          }
          throw error
        }
      }),
    )
}
