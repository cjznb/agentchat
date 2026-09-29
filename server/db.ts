/**
 * SQLite 打开、建表与幂等迁移 —— 进程内所有连接的唯一入口，
 * 保证每个连接都带同一套 PRAGMA（spec §12：WAL 数据安全前提）与 schema。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"

/** better-sqlite3 数据库实例类型；store 层统一以它为第一参数。 */
export type Db = Database.Database

const SCHEMA_URL = new URL("./schema.sql", import.meta.url)

/** `approvals` 扩展列（spec §17.2；任一缺失即触发重建）。 */
const APPROVALS_NEW_COLUMNS = ["kind", "target", "result", "read_at"] as const

/** `messages` 新增可空列（撤回；旧库 ADD COLUMN 即可，无需重建 —— 列可空且无 CHECK）。 */
const MESSAGES_REVOKED_COLUMN = "revoked_at"

interface SqliteMasterRow {
  readonly sql: string | null
}

interface TableInfoRow {
  readonly name: string
}

/**
 * 旧库检测（spec §17.2 决策①）：`approvals` 已存在但 `sqlite_master.sql` 缺 `'answered'`
 * （旧 CHECK 仅四态）或 `PRAGMA table_info` 缺任一扩展列时，需要重建表。
 * fresh 库不存在该表（由 schema.sql 直建新结构），返回 false 走短路。
 */
function approvalsNeedsRebuild(db: Db): boolean {
  const master = db
    .prepare<[string], SqliteMasterRow>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("approvals")
  if (master === undefined || master.sql === null) return false
  if (!master.sql.includes("'answered'")) return true
  const columns = new Set(
    (db.pragma("table_info(approvals)") as TableInfoRow[]).map((column) => column.name),
  )
  return APPROVALS_NEW_COLUMNS.some((column) => !columns.has(column))
}

/**
 * CHECK 约束不可 ALTER —— 需要 `status` 新值时必须表重建（spec §17.2 / brief Key facts）：
 * 新结构表 + `INSERT SELECT`（既有行补 `kind='action'`/`target='human'`）+ drop + rename，
 * 全程 `BEGIN IMMEDIATE` 事务。重建后检测短路，**幂等**（连跑两次不重建、不报错）。
 */
const REBUILD_APPROVALS_SQL = `
CREATE TABLE approvals_new (
  id                 TEXT PRIMARY KEY,
  requester_agent_id TEXT NOT NULL REFERENCES agents(id),
  kind               TEXT NOT NULL DEFAULT 'action',
  target             TEXT NOT NULL DEFAULT 'human',
  action             TEXT NOT NULL,
  payload            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'answered')),
  result             TEXT,
  created_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  read_at            INTEGER
);
INSERT INTO approvals_new
  (id, requester_agent_id, kind, target, action, payload, status, result, created_at, decided_at, read_at)
  SELECT id, requester_agent_id, 'action', 'human', action, payload, status, NULL, created_at, decided_at, NULL
  FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
`

function migrateApprovals(db: Db): void {
  if (!approvalsNeedsRebuild(db)) return
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(REBUILD_APPROVALS_SQL)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/**
 * `messages.revoked_at` 幂等迁移（撤回功能）：旧库缺列时 `ALTER TABLE ADD COLUMN`（可空，
 * 老行取值 NULL，天然向后兼容）；fresh 库由 schema.sql 直建，短路跳过。
 */
function migrateMessages(db: Db): void {
  const columns = new Set(
    (db.pragma("table_info(messages)") as TableInfoRow[]).map((column) => column.name),
  )
  if (columns.has(MESSAGES_REVOKED_COLUMN)) return
  db.exec(`ALTER TABLE messages ADD COLUMN ${MESSAGES_REVOKED_COLUMN} INTEGER`)
}

/**
 * 打开（必要时创建）`dbPath` 指向的数据库并建表。
 * - `journal_mode=WAL`：读写并发（spec §14）
 * - `foreign_keys=ON`：八张表的引用完整性逐语句生效
 * - schema.sql 幂等（IF NOT EXISTS）；`approvals` 旧结构再经幂等迁移重建
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  db.exec(readFileSync(SCHEMA_URL, "utf8"))
  migrateApprovals(db)
  migrateMessages(db)
  return db
}
