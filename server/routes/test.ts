/**
 * 测试专用 HTTP 接口（`/api/test/*`）入口 —— 21 组端点的 HTTP 编排层：供真机/自动化测试
 * **驱动真实业务路径**并**直接断言库内真实状态**（`GET /api/test/dump` 返回原始行）。
 *
 * 安全模型（三重，缺一不可）：
 * 1. **默认关闭**：只有 `AGENTCHAT_TEST_API` 为真时 `server/index.ts` 才挂载本模块；
 *    默认启动下这些路径根本不存在（404）。
 * 2. **仅回环**：每个 handler 先过回环守卫（非回环 → 403 `forbidden`，与 `/api/admin/*` 同款）；
 *    即使本模块被别处直接 `app.route` 挂上，仍自守（不依赖「反正只绑 127.0.0.1」）。
 * 3. **自转 JSON**：`server/index.ts` **没有** `app.onError`，故所有异常都在 `guarded()` 外壳里
 *    转成 JSON（兜底 500 `internal_error` + `detail`），绝不落出非 JSON 500。
 *
 * ⚠️ 这是**测试面**：`/api/test/reset` 就地清空全部业务表、`/api/test/seed` 直写 store
 * （不过审批闸门，专为造夹具）、`DELETE /api/test/agents/:id?mode=hard` 不可恢复地硬删节点。
 * **绝不可对生产库开启**——只对一次性临时 `AGENTCHAT_HOME` 开启。
 *
 * 与 `/api/admin/reset` 的差异（两个「重置」语义不同，勿混用）：
 * - `POST /api/test/reset`：只 `clearAllTables` —— 快、零副产物；**不**做 `VACUUM INTO` 快照备份、
 *   **不**删适配器侧文件（hub_token/tokens/agents/logs/backups/config.json）。
 * - `POST /api/admin/reset`：先快照到 `<home>.bak-<ts>/` 再清库，随后删适配器侧出厂态条目
 *   —— 面向人的「恢复出厂设置」。
 *
 * 文件分工（本仓硬约束「单文件 ≤ 250 纯行」，CONTRIBUTING.md:80）：本文件 = 入口
 * （`testRoutes`/`TestRoutesOptions` 导出 + 会话与消息端点 5–14 + 喊话 21）、`test-schemas.ts`
 * （zod schema + 守卫外壳/引用解析等共享 helper + 节点端点 17–20）、`test-seed.ts`
 * （夹具/生命周期端点 1–4 与 15–16）。导出名与签名对外保持不变。
 */
import { Hono, type Context } from "hono"
import { removeGroupMember } from "../core/group-ops"
import {
  addParticipant as gatedAddParticipant,
  ContainerCannotSendError,
  ContainerNotChatTargetError,
  ContainerNotGroupMemberError,
  createGroup as gatedCreateGroup,
  NotParticipantError,
  RecipientNotFound,
  sendMessage,
  shout,
} from "../core/messaging"
import { ensureHuman, Forbidden } from "../core/permissions"
import type { Db } from "../db"
import { agentRenameSchema } from "../store/agents"
import {
  conversationStats,
  createDm,
  deleteConversationCascade,
  listConversations,
  listParticipants,
  renameConversation,
  ConversationNotFoundError,
} from "../store/conversations"
import { deleteMessagesInConversation, history, latestInConversation } from "../store/messages"
import { markRead } from "../store/read_states"
import { defaultIsLoopback } from "./admin"
import { clearMcpSessions } from "./mcp"
import {
  addMemberBodySchema,
  agentRoutes,
  createConversationSchema,
  GROUP_OP_STATUS,
  guarded,
  memberBodySchema,
  pathId,
  readBodySchema,
  resolveAgentRef,
  sendBodySchema,
  shoutBodySchema,
  withConversation,
  type TestHandler,
} from "./test-schemas"
import { seedRoutes } from "./test-seed"

/** 路由选项：回环判定可注入（测试用假 Context 直调 HTTP 面）。 */
export interface TestRoutesOptions {
  /** 回环判定（缺省复用 `routes/admin.ts` 已导出的 `defaultIsLoopback`）；测试注入。 */
  readonly isLoopback?: (c: Context) => boolean
}

/** 测试路由表；`db` 缺省时惰性取进程配置库（测试显式注入临时库 + 假回环判定）。 */
export function testRoutes(db?: Db, options?: TestRoutesOptions): Hono {
  const isLoopback = options?.isLoopback ?? defaultIsLoopback
  const handle = (handler: TestHandler) => guarded(db, isLoopback, handler)

  return new Hono()
    // 1–4、15–16：夹具/生命周期与拆除端点见 `test-seed.ts`；17–20：节点端点见 `test-schemas.ts`。
    .route("/", seedRoutes(handle))
    .route("/", agentRoutes(handle))
    // 5. 会话列表：成员 + 统计（`conversationStats`）一并给出，省去测试再查 dump。
    .get("/api/test/conversations", handle((c, database) =>
      c.json({
        ok: true,
        conversations: listConversations(database).map((conversation) => {
          const stats = conversationStats(database, conversation.id)
          return {
            id: conversation.id,
            kind: conversation.kind,
            key: conversation.key,
            name: conversation.name,
            createdBy: conversation.createdBy,
            createdAt: conversation.createdAt,
            participants: listParticipants(database, conversation.id).map((participant) => ({
              agentId: participant.agentId,
              role: participant.role,
              joinedAt: participant.joinedAt,
            })),
            messageCount: stats.messageCount,
            lastSeq: stats.lastSeq,
          }
        }),
      })))
    // 6. 建会话：DM 幂等取或建（store 直写）；群走 core 的 Gated 入口（human 直通，agent 才落审批单）。
    .post("/api/test/conversations", handle(async (c, database) => {
      const parsed = createConversationSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const input = parsed.data
      if (input.kind === "dm") {
        const a = resolveAgentRef(database, input.a)
        const b = resolveAgentRef(database, input.b)
        if (a === undefined || b === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
        // 同一节点作 DM 两端（含"名字 / id 混写指同一人"）：`createDm` 会给同一 agent 插两行
        // participants 撞主键 —— 这是载荷形状非法，写前拦成 400，而不是落成 500。
        if (a.id === b.id) return c.json({ ok: false, error: "invalid_body" }, 400)
        return c.json({ ok: true, conversation: createDm(database, a.id, b.id) })
      }
      const memberIds: string[] = []
      for (const ref of input.memberIds ?? []) {
        const member = resolveAgentRef(database, ref)
        if (member === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
        memberIds.push(member.id)
      }
      try {
        const outcome = gatedCreateGroup(database, {
          name: input.name,
          createdBy: ensureHuman(database).id,
          memberIds,
        })
        return "approved" in outcome
          ? c.json({ ok: true, conversation: outcome.approved })
          : c.json({ ok: true, approval: outcome.approval })
      } catch (error) {
        // P5：memberIds 含容器 → 409 `container_not_group_member`（业务拒绝不落 500）。
        if (error instanceof ContainerNotGroupMemberError) {
          return c.json({ ok: false, error: error.code }, 409)
        }
        throw error
      }
    }))
    // 7. 会话改名（群名 / DM 备注名）：复用 `agentRenameSchema`（trim 1..64、禁控制字符）同一口径。
    .patch("/api/test/conversations/:id", handle(async (c, database) => {
      const parsed = agentRenameSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      try {
        return c.json({ ok: true, conversation: renameConversation(database, pathId(c), parsed.data.name) })
      } catch (error) {
        if (error instanceof ConversationNotFoundError) return c.json({ ok: false, error: error.code }, 404)
        throw error
      }
    }))
    // 8. 删会话（级联）：先取统计（级联后消息行已消失，事后再数不出来）。
    .delete("/api/test/conversations/:id", handle((c, database) =>
      withConversation(c, database, (conversation) => {
        const stats = conversationStats(database, conversation.id)
        deleteConversationCascade(database, conversation.id)
        return c.json({ ok: true, deleted: { messages: stats.messageCount } })
      })))
    // 9. 历史分页：`before`（seq 不含）/`limit` 校验规则与 `routes/ui.ts` 逐字一致。
    .get("/api/test/conversations/:id/messages", handle((c, database) =>
      withConversation(c, database, (conversation) => {
        const rawBefore = c.req.query("before")
        const before = rawBefore === undefined || rawBefore === "" ? undefined : Number(rawBefore)
        if (before !== undefined && (!Number.isInteger(before) || before < 0)) {
          return c.json({ ok: false, error: "invalid_before" }, 400)
        }
        const rawLimit = c.req.query("limit")
        const limit = rawLimit === undefined || rawLimit === "" ? undefined : Number(rawLimit)
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
          return c.json({ ok: false, error: "invalid_limit" }, 400)
        }
        return c.json({
          ok: true,
          messages: history(database, {
            conversationId: conversation.id,
            ...(before === undefined ? {} : { before }),
            ...(limit === undefined ? {} : { limit }),
          }),
        })
      })))
    // 10. 发消息：**真实投递路径**（wake + publish），与 MCP/UI 同一条 core 编排。
    .post("/api/test/conversations/:id/messages", handle(async (c, database) => {
      const parsed = sendBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      return withConversation(c, database, (conversation) => {
        const from =
          parsed.data.from === undefined ? ensureHuman(database) : resolveAgentRef(database, parsed.data.from)
        if (from === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
        try {
          const result = sendMessage(database, {
            from: from.id,
            to: conversation.id,
            body: parsed.data.body,
            ...(parsed.data.mentions === undefined ? {} : { mentions: parsed.data.mentions }),
            ...(parsed.data.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.data.idempotencyKey }),
          })
          return c.json({ ok: true, ...result })
        } catch (error) {
          // 错误码与 `routes/ui.ts` 的投递分支同源（同一批 core 错误类 → 同一批 HTTP 码）。
          if (error instanceof Error && error.name === "SelfSendError") {
            return c.json({ ok: false, error: "self_send" }, 409)
          }
          if (error instanceof RecipientNotFound) return c.json({ ok: false, error: error.code }, 404)
          if (error instanceof NotParticipantError) return c.json({ ok: false, error: error.code }, 403)
          if (error instanceof ContainerNotChatTargetError) {
            return c.json({ ok: false, error: error.code }, 409)
          }
          // P5：容器不可作发送方（业务拒绝映射 409，不落进 `handle()` 的 500）。
          if (error instanceof ContainerCannotSendError) {
            return c.json({ ok: false, error: error.code }, 409)
          }
          throw error
        }
      })
    }))
    // 11. 清空会话消息（会话本身保留）。
    .post("/api/test/conversations/:id/purge", handle((c, database) =>
      withConversation(c, database, (conversation) =>
        c.json({ ok: true, deleted: deleteMessagesInConversation(database, conversation.id) }))))
    // 12. 推进已读位点到该会话最新 seq（body 可省 → 默认 human 读者）。
    .post("/api/test/conversations/:id/read", handle(async (c, database) => {
      // 只读冒烟里常不带 body：缺省 `{}` 而非 undefined，否则「省略 body」会被判成 invalid_body。
      const parsed = readBodySchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      return withConversation(c, database, (conversation) => {
        const reader =
          parsed.data.agentId === undefined
            ? ensureHuman(database)
            : resolveAgentRef(database, parsed.data.agentId)
        if (reader === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
        const lastReadSeq = latestInConversation(database, conversation.id)?.seq ?? 0
        markRead(database, { conversationId: conversation.id, agentId: reader.id, lastReadSeq })
        return c.json({ ok: true, lastReadSeq })
      })
    }))
    // 13. 拉人入会话：core Gated（human 直通 / agent 落审批单）。
    .post("/api/test/conversations/:id/members", handle(async (c, database) => {
      const parsed = addMemberBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      return withConversation(c, database, (conversation) => {
        const agent = resolveAgentRef(database, parsed.data.agentId)
        if (agent === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
        try {
          const outcome = gatedAddParticipant(database, {
            conversationId: conversation.id,
            agentId: agent.id,
            invitedBy: ensureHuman(database).id,
            ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
          })
          return "approved" in outcome ? c.json({ ok: true }) : c.json({ ok: true, approval: outcome.approval })
        } catch (error) {
          // P5：容器不可入群 → 409 `container_not_group_member`（业务拒绝不落 500）。
          if (error instanceof ContainerNotGroupMemberError) {
            return c.json({ ok: false, error: error.code }, 409)
          }
          throw error
        }
      })
    }))
    // 14. 移出群成员：与生产 `POST /api/groups/:id/members/remove` 共用 `core/group-ops` 唯一实现。
    .post("/api/test/conversations/:id/members/remove", handle(async (c, database) => {
      const parsed = memberBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      // group-ops 只认 id：能解析成 id（含系统名）就传 id；解析不到则原样透传，
      // 由 group-ops 给出契约内的 not_in_group / conversation_not_found（而非本层另立码）。
      const agentId = resolveAgentRef(database, parsed.data.agentId)?.id ?? parsed.data.agentId
      const outcome = removeGroupMember(database, { conversationId: pathId(c), agentId })
      return outcome.ok
        ? c.json({ ok: true })
        : c.json({ ok: false, error: outcome.error }, GROUP_OP_STATUS[outcome.error])
    }))
    // 21. 全员喊话：Gated（human 直通；agent 发起落审批单）—— 与投递端点同层，故留在本文件。
    .post("/api/test/shout", handle(async (c, database) => {
      const parsed = shoutBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const from =
        parsed.data.from === undefined ? ensureHuman(database) : resolveAgentRef(database, parsed.data.from)
      if (from === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
      try {
        const outcome = shout(database, from.id, parsed.data.body)
        return "approved" in outcome
          ? c.json({ ok: true, ...outcome.approved })
          : c.json({ ok: true, approval: outcome.approval })
      } catch (error) {
        // gate 对「子节点 / 逻辑节点」发起 shout 直接拒绝并抛 `Forbidden`（无审批单）：
        // 测试面允许任意 agent 作 `from`，故这是可达路径 —— 必须映射 403，而不是落进
        // `guarded()` 的 500（业务拒绝被误读成服务端故障）。
        if (error instanceof Forbidden) return c.json({ ok: false, error: error.code }, 403)
        // P5：容器不可作发送方（`shout` 经 `sendMessage` 落地）。
        if (error instanceof ContainerCannotSendError) {
          return c.json({ ok: false, error: error.code }, 409)
        }
        throw error
      }
    }))
    /**
     * 22. 确定性触发器：清空当前 Hub 的**全部 MCP 会话**（关闭 transport）。
     *
     * 用途（B 提出）：404 自愈路径在真机上是"单次进程级资源"——adapter 的共享 client 只要有一次
     * 成功调用就把那次 stale-session 消费掉。用本端点可**反复**制造 stale session，无需重启 Hub：
     * 清空后 adapter 下一次 `tools/call` 必吃 404 → 触发同调用内重握手 + 原样重发。
     * 返回 `{ok:true, cleared:<清掉的会话数>}`；无 mcpRoutes 实例时 `cleared:0`。
     */
    .post("/api/test/mcp-sessions/clear", handle((c) => c.json({ ok: true, cleared: clearMcpSessions() })))
}
