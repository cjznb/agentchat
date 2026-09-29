/**
 * 管理端点（供 Web UI 的「恢复出厂设置」按钮）——`POST /api/admin/reset` 与 `GET /api/admin/info`。
 *
 * 安全模型与既有本机单用户一致：Hub 只绑 `127.0.0.1`，本层**仍显式校验请求来源为回环**
 * （不依赖「反正只有本机」），并要求 body `{confirm:"RESET"}` **精确匹配**；任何异常都在本层
 * 转成明确 JSON 错误（`server/index.ts` **没有** `app.onError`，不能依赖全局兜底）。
 *
 * 运行中不能删 `agentchat.db`（Windows 锁文件）：先 `VACUUM INTO` 一致性快照到 `<home>.bak-<ts>/`，
 * 再 `clearAllTables` **就地清空并重建**（空但可用）；随后才删适配器侧文件与 `hub_token`。
 *
 * ⚠️ 残余风险：回环上任何本地进程都能调用本端点（与既有安全模型一致）；且删除 `hub_token` 后
 * 运行中的 Hub 仍持内存里的旧 token，窗口期内旧 token 依然可用——须**重启 Hub** 才彻底生效。
 *
 * 目标文件清单与 CLI `bin/reset-io.mjs` 的 `RESET_TARGETS` 一致（两处同步）；差异：本层不删 DB 文件。
 */
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Hono, type Context } from "hono"
import { z } from "zod"
import { config } from "../config"
import { clearAllTables, openDb, type Db } from "../db"

/** 适配器侧出厂态条目（**不含** `agentchat.db`——运行中就地清空，不删文件）。 */
export const ADAPTER_STATE_TARGETS = [
  "hub_token",
  "tokens",
  "agents",
  "logs",
  "backups",
  "config.json",
]

export interface AdminRoutesOptions {
  /** 数据目录（缺省 `config.home`）。 */
  readonly home?: string
  /** 注入时钟（缺省 `Date.now`）；测试固定快照目录名。 */
  readonly now?: () => number
  /** 回环判定（缺省读 `c.env.incoming.socket.remoteAddress`）；测试注入。 */
  readonly isLoopback?: (c: Context) => boolean
}

const resetBodySchema = z.object({
  confirm: z.literal("RESET"),
  keepBackups: z.boolean().optional(),
})

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 node-server 的 env 绑定里安全取远端地址（不依赖类型层，纯守卫）。 */
function remoteAddress(env: unknown): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const incoming = (env as { readonly incoming?: unknown }).incoming
  if (typeof incoming !== "object" || incoming === null) return undefined
  const socket = (incoming as { readonly socket?: unknown }).socket
  if (typeof socket !== "object" || socket === null) return undefined
  const address = (socket as { readonly remoteAddress?: unknown }).remoteAddress
  return typeof address === "string" ? address : undefined
}

/** 仅回环（IPv4 / IPv6 / IPv4-mapped）视为可信来源。 */
function defaultIsLoopback(c: Context): boolean {
  const address = remoteAddress(c.env)
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

/** 删除适配器侧出厂态条目；返回未能删除的条目名（Windows 上文件可能被占用）。 */
export function clearAdapterState(home: string, keepBackups: boolean): string[] {
  const failed: string[] = []
  for (const name of ADAPTER_STATE_TARGETS) {
    if (name === "backups" && keepBackups) continue
    const target = join(home, name)
    if (!existsSync(target)) continue
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      failed.push(name)
    }
  }
  return failed
}

/** 生产缺省连接（同 routes/ui 模式）：首个请求时按 `config.dbPath` 打开并复用。 */
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

/** 管理路由表；`db` 缺省时惰性取进程配置库（测试显式注入临时库 + 临时 home）。 */
export function adminRoutes(db?: Db, options?: AdminRoutesOptions): Hono {
  const home = options?.home ?? config.home
  const now = options?.now ?? Date.now
  const isLoopback = options?.isLoopback ?? defaultIsLoopback

  return new Hono()
    .get("/api/admin/info", (c) => {
      if (!isLoopback(c)) return c.json({ ok: false, error: "forbidden" }, 403)
      return c.json({ home, logsDir: join(home, "logs") })
    })
    .post("/api/admin/reset", async (c) => {
      if (!isLoopback(c)) return c.json({ ok: false, error: "forbidden" }, 403)
      const parsed = resetBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)

      let database: Db
      try {
        database = resolveDb(db)
      } catch (error) {
        // 无 app.onError：打开库失败也必须自转 JSON，不能落成非 JSON 500
        return c.json({ ok: false, error: "db_open_failed", detail: errorText(error) }, 500)
      }
      const backupDir = `${home}.bak-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`
      const snapshotPath = join(backupDir, "agentchat.db")
      try {
        mkdirSync(backupDir, { recursive: true })
        database.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`)
      } catch (error) {
        return c.json({ ok: false, error: "snapshot_failed", detail: errorText(error) }, 500)
      }
      try {
        clearAllTables(database)
      } catch (error) {
        return c.json({ ok: false, error: "db_clear_failed", detail: errorText(error) }, 500)
      }
      const failed = clearAdapterState(home, parsed.data.keepBackups === true)
      return c.json({
        ok: true,
        restartRequired: true,
        snapshotPath,
        ...(failed.length === 0 ? {} : { failed }),
      })
    })
}
