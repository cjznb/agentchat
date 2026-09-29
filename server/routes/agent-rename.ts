/**
 * `PATCH /api/agents/:id` 改名处理器（Task 6）—— 自 `routes/ui.ts` 拆出的小路由模块
 * （ui.ts 纯行红线；校验与冲突判定在 store，本层只做 HTTP 编排与稳定错误码映射）。
 *
 * - 400 `invalid_body`：zod 校验失败（trim 后非空 / ≤64 字 / 禁控制字符）
 * - 404 `agent_not_found`：未知 id；409 `name_taken`：展示名（COALESCE 唯一索引）冲突
 * - 200 `{ok, name}`：`name` = 新展示名；成功后广播既有 `agent` 树事件（`emitAgentTree`，无新事件）
 */
import type { Context } from "hono"
import { emitAgentTree } from "../core/agents"
import type { Db } from "../db"
import {
  agentDisplayName,
  agentRenameSchema,
  AgentNameTakenError,
  AgentNotFoundError,
  renameAgent,
} from "../store/agents"

/** 处理一次改名请求：校验 → 改名 → 广播；错误映射为 brief 锁定的四个状态码。 */
export async function handleAgentRename(c: Context, db: Db): Promise<Response> {
  const id = c.req.param("id")
  if (id === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
  const parsed = agentRenameSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
  try {
    const agent = renameAgent(db, id, parsed.data.name)
    emitAgentTree(db)
    return c.json({ ok: true, name: agentDisplayName(agent) })
  } catch (error) {
    if (error instanceof AgentNotFoundError) {
      return c.json({ ok: false, error: "agent_not_found" }, 404)
    }
    if (error instanceof AgentNameTakenError) {
      return c.json({ ok: false, error: error.code }, 409)
    }
    throw error
  }
}
