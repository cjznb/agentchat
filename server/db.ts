/**
 * SQLite 打开与建表 —— 进程内所有连接的唯一入口，
 * 保证每个连接都带同一套 PRAGMA（spec §12：WAL 数据安全前提）与 schema。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"

/** better-sqlite3 数据库实例类型；store 层统一以它为第一参数。 */
export type Db = Database.Database

const SCHEMA_URL = new URL("./schema.sql", import.meta.url)

/**
 * 打开（必要时创建）`dbPath` 指向的数据库并建表。
 * - `journal_mode=WAL`：读写并发（spec §14）
 * - `foreign_keys=ON`：八张表的引用完整性逐语句生效
 * - schema.sql 幂等（IF NOT EXISTS），重复打开安全
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  db.exec(readFileSync(SCHEMA_URL, "utf8"))
  return db
}
