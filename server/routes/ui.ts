/**
 * UI 侧 HTTP 路由（spec §11）——`GET /api/roster`；
 * Task 4：路由服务的库同时保证 human 身份就绪（决议 2，人通道即刻可执行）。
 */
import { Hono } from "hono"
import { rosterTree } from "../core/agents"
import { ensureHuman } from "../core/messaging"
import { config } from "../config"
import { openDb, type Db } from "../db"

// 生产缺省连接：首个 roster 请求时按 `config.dbPath` 打开并复用（进程单例）。
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

/** 路由表：`db` 缺省时惰性取进程配置库（测试显式注入临时库）。 */
export function uiRoutes(db?: Db): Hono {
  return new Hono().get("/api/roster", (c) => {
    const database = resolveDb(db)
    ensureHuman(database)
    return c.json(rosterTree(database))
  })
}
