/**
 * 通知页 HTTP 路由（spec §11.5/§17.3；Task 4）—— 自 `routes/ui.ts` 拆出
 * （`ui.ts` ≤250 纯行红线，controller 授权的结构偏差）：通知列表、ask 答复、已读标记。
 *
 * 路由层只做 HTTP 编排与稳定错误码映射（错误体含 `code`）；查询/组装在 `core/ui-queries`，
 * 状态变更走既有 core（`respondAsk` / `markRead`）—— 路由层不直接广播（经 core publish）。
 * 单用户 MVP：已读为全局 `read_at`，且**不改变 actionable 归属**（仅影响未读徽标）。
 */
import { Hono } from "hono"
import { z } from "zod"
import { config } from "../config"
import {
  AskAlreadyAnsweredError,
  AskForbiddenError,
  AskNotFoundError,
  ensureHuman,
  InvalidChoiceError,
  respondAsk,
} from "../core/permissions"
import { notificationList } from "../core/ui-queries"
import { openDb, type Db } from "../db"
import { getApproval } from "../store/approvals"
import { markRead, type NotificationScope } from "../store/notifications"

// 生产缺省连接：与 `routes/ui.ts` 同模式（首个请求时按 `config.dbPath` 打开并复用）。
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

/** 答复体：`{choice} | {text}`（二者择一，合法性交由 `respondAsk` 统一裁决）。 */
const respondBodySchema = z.object({
  choice: z.string().optional(),
  text: z.string().optional(),
})

/** `scope` 解析：缺省 `actionable`；未知值 → `undefined`（路由回 400）。 */
function parseScope(raw: string | undefined): NotificationScope | undefined {
  if (raw === undefined || raw === "actionable") return "actionable"
  return raw === "all" ? "all" : undefined
}

/** 路由表：`db` 缺省时惰性取进程配置库（测试显式注入临时库）。 */
export function notificationRoutes(db?: Db): Hono {
  return new Hono()
    // 通知列表（`scope=actionable|all`，spec §11.5 两 tab）；每条含深链锚点。
    .get("/api/notifications", (c) => {
      const scope = parseScope(c.req.query("scope"))
      if (scope === undefined) return c.json({ ok: false, error: "invalid_scope" }, 400)
      return c.json(notificationList(resolveDb(db), scope))
    })
    // ask 答复（human 信任模型，spec §17.3）：成功 200 + 单据已决；答复消息落卡所在会话。
    .post("/api/asks/:id/respond", async (c) => {
      const database = resolveDb(db)
      const parsed = respondBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      try {
        const approval = respondAsk(database, c.req.param("id"), ensureHuman(database).id, {
          ...(parsed.data.choice === undefined ? {} : { choice: parsed.data.choice }),
          ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
        })
        return c.json({ ok: true, ask: approval })
      } catch (error) {
        if (error instanceof AskNotFoundError) {
          return c.json({ ok: false, error: error.code }, 404)
        }
        if (error instanceof AskAlreadyAnsweredError) {
          return c.json({ ok: false, error: error.code }, 409)
        }
        if (error instanceof InvalidChoiceError) {
          return c.json({ ok: false, error: error.code }, 400)
        }
        if (error instanceof AskForbiddenError) {
          return c.json({ ok: false, error: error.code }, 403)
        }
        throw error
      }
    })
    // 已读标记（幂等；不改 actionable 归属）：未知单 404。
    .post("/api/notifications/:id/read", (c) => {
      const database = resolveDb(db)
      const id = c.req.param("id")
      if (getApproval(database, id) === undefined) {
        return c.json({ ok: false, error: "notification_not_found" }, 404)
      }
      return c.json({ ok: true, read: markRead(database, id) })
    })
}
