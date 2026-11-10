/**
 * `agents` 表读写（spec §5.1 节点卡、§5.2 生命周期字段）。
 * 行（snake_case）→ 域对象（camelCase）的映射与 JSON/枚举解析都在本层完成。
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  agentKindSchema,
  agentStatusSchema,
  type AgentKind,
  type AgentStatus,
} from "../../shared/contracts"
import type { Db } from "../db"
import { deleteConversationCascade } from "./conversations"

const skillsSchema = z.array(z.string())

export interface Agent {
  readonly id: string
  readonly name: string
  /** 用户改名（Task 6）：非空时为展示名，覆盖系统名 `name`；NULL = 未改名。 */
  readonly customName: string | undefined
  readonly kind: AgentKind
  readonly taskRef: string | undefined
  readonly parentId: string | undefined
  readonly rootId: string
  readonly vendor: string
  readonly model: string
  readonly status: AgentStatus
  readonly purpose: string | undefined
  readonly skills: readonly string[]
  readonly roleTag: string | undefined
  readonly remark: string | undefined
  readonly statusText: string | undefined
  readonly lastSeen: number
  readonly retiredAt: number | undefined
  readonly createdAt: number
}

export interface InsertAgentInput {
  readonly name: string
  readonly kind: AgentKind
  readonly status: AgentStatus
  readonly vendor: string
  readonly model?: string
  readonly parentId?: string
  readonly taskRef?: string
  readonly purpose?: string
  readonly skills?: readonly string[]
  readonly roleTag?: string
  readonly remark?: string
  readonly statusText?: string
}

interface AgentRow {
  readonly id: string
  readonly name: string
  readonly custom_name: string | null
  readonly kind: string
  readonly task_ref: string | null
  readonly parent_id: string | null
  readonly root_id: string
  readonly vendor: string
  readonly model: string
  readonly status: string
  readonly purpose: string | null
  readonly skills: string
  readonly role_tag: string | null
  readonly remark: string | null
  readonly status_text: string | null
  readonly last_seen: number
  readonly retired_at: number | null
  readonly created_at: number
}

interface AgentInsertParams {
  readonly id: string
  readonly name: string
  readonly kind: AgentKind
  readonly taskRef: string | null
  readonly parentId: string | null
  readonly rootId: string
  readonly vendor: string
  readonly model: string
  readonly status: AgentStatus
  readonly purpose: string | null
  readonly skills: string
  readonly roleTag: string | null
  readonly remark: string | null
  readonly statusText: string | null
  readonly lastSeen: number
  readonly createdAt: number
}

const INSERT_SQL = `
  INSERT INTO agents (id, name, kind, task_ref, parent_id, root_id, vendor, model,
                      status, purpose, skills, role_tag, remark, status_text, last_seen, created_at)
  VALUES ($id, $name, $kind, $taskRef, $parentId, $rootId, $vendor, $model,
          $status, $purpose, $skills, $roleTag, $remark, $statusText, $lastSeen, $createdAt)`

function toAgent(row: AgentRow): Agent {
  const storedSkills: unknown = JSON.parse(row.skills)
  return {
    id: row.id,
    name: row.name,
    customName: row.custom_name ?? undefined,
    kind: agentKindSchema.parse(row.kind),
    taskRef: row.task_ref ?? undefined,
    parentId: row.parent_id ?? undefined,
    rootId: row.root_id,
    vendor: row.vendor,
    model: row.model,
    status: agentStatusSchema.parse(row.status),
    purpose: row.purpose ?? undefined,
    skills: skillsSchema.parse(storedSkills),
    roleTag: row.role_tag ?? undefined,
    remark: row.remark ?? undefined,
    statusText: row.status_text ?? undefined,
    lastSeen: row.last_seen,
    retiredAt: row.retired_at ?? undefined,
    createdAt: row.created_at,
  }
}

/** 插入节点；`root_id` 取父树根（根节点 = 自身）。name 唯一、task_ref 幂等由索引保证。 */
export function insertAgent(db: Db, input: InsertAgentInput): Agent {
  const id = randomUUID()
  const now = Date.now()
  // parent 缺失时下面的 INSERT 会被 parent_id 外键拒绝，此处取值不会落库。
  const rootId =
    input.parentId === undefined ? id : (getAgent(db, input.parentId)?.rootId ?? id)
  const params: AgentInsertParams = {
    id,
    name: input.name,
    kind: input.kind,
    taskRef: input.taskRef ?? null,
    parentId: input.parentId ?? null,
    rootId,
    vendor: input.vendor,
    model: input.model ?? "—",
    status: input.status,
    purpose: input.purpose ?? null,
    skills: JSON.stringify(input.skills ?? []),
    roleTag: input.roleTag ?? null,
    remark: input.remark ?? null,
    statusText: input.statusText ?? null,
    lastSeen: now,
    createdAt: now,
  }
  db.prepare<AgentInsertParams, void>(INSERT_SQL).run(params)
  return {
    id,
    name: params.name,
    customName: undefined,
    kind: params.kind,
    taskRef: input.taskRef,
    parentId: input.parentId,
    rootId,
    vendor: params.vendor,
    model: params.model,
    status: params.status,
    purpose: input.purpose,
    skills: input.skills ?? [],
    roleTag: input.roleTag,
    remark: input.remark,
    statusText: input.statusText,
    lastSeen: now,
    retiredAt: undefined,
    createdAt: now,
  }
}

/**
 * 重注册（认领/task_ref 幂等）可更新的卡片字段（spec §5.1）。
 *
 * **白名单仅卡片字段**：`kind`/`parent_id`/`root_id`/`task_ref`/`status`/`vendor`
 * 等身份与结构字段永不在此；`undefined` = 不改动（只写已提供项）。
 */
export interface AgentCardPatch {
  readonly name?: string
  readonly model?: string
  readonly purpose?: string
  readonly skills?: readonly string[]
  readonly roleTag?: string
  readonly remark?: string
}

/**
 * 更新节点卡字段（重注册路径）：只写 `patch` 中**已提供**（非 `undefined`）的项，
 * 其余字段与库中原值一律不动。`skills` 序列化为 JSON；行不存在抛 `AgentNotFoundError`。
 */
export function updateAgentCard(db: Db, id: string, patch: AgentCardPatch): Agent {
  const assignments: string[] = []
  const params: Record<string, string | null> = { id }
  if (patch.name !== undefined) {
    assignments.push("name = $name")
    params["name"] = patch.name
  }
  if (patch.model !== undefined) {
    assignments.push("model = $model")
    params["model"] = patch.model
  }
  if (patch.purpose !== undefined) {
    assignments.push("purpose = $purpose")
    params["purpose"] = patch.purpose
  }
  if (patch.skills !== undefined) {
    assignments.push("skills = $skills")
    params["skills"] = JSON.stringify(patch.skills)
  }
  if (patch.roleTag !== undefined) {
    assignments.push("role_tag = $roleTag")
    params["roleTag"] = patch.roleTag
  }
  if (patch.remark !== undefined) {
    assignments.push("remark = $remark")
    params["remark"] = patch.remark
  }
  if (assignments.length === 0) {
    const current = getAgent(db, id)
    if (current === undefined) throw new AgentNotFoundError(id)
    return current
  }
  const row = db
    .prepare<Record<string, string | null>, AgentRow>(
      `UPDATE agents SET ${assignments.join(", ")} WHERE id = $id RETURNING *`,
    )
    .get(params)
  if (row === undefined) throw new AgentNotFoundError(id)
  return toAgent(row)
}

// ── Task 6：改名（custom_name）—— 展示名优先级：用户改名 > 系统名 ─────────────

/**
 * 展示名（Task 6 唯一取名口径）：`custom_name` 有值取之（用户改名），否则回落系统名
 * `name`（会话标题同步只写 name，永不触碰 custom_name）。所有对外展示取名处一律走本函数。
 */
export function agentDisplayName(agent: Pick<Agent, "name" | "customName">): string {
  return agent.customName ?? agent.name
}

/** `PATCH /api/agents/:id` 入参：trim 后非空、≤64 字、禁控制字符（\p{Cc}：C0/C1）。 */
export const agentRenameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => !/[\p{Cc}]/u.test(value), { message: "control characters are not allowed" }),
})

/** 改名冲突：目标展示名已被其他节点占用（展示名唯一索引口径）→ 409 `name_taken`。 */
export class AgentNameTakenError extends Error {
  readonly code = "name_taken"
  constructor(readonly displayName: string) {
    super(`agent display name already taken: ${displayName}`)
    this.name = "AgentNameTakenError"
  }
}

/**
 * 用户改名（Task 6 `PATCH /api/agents/:id`）：只写 `custom_name`，`name` 与身份/结构字段
 * 一律不动（`register`/标题同步写 name 的对偶面）。唯一性按展示名口径
 * （`COALESCE(custom_name, name)` 唯一索引兜底）：撞他人展示名 → `AgentNameTakenError`；
 * 未知 id → `AgentNotFoundError`；改回自身当前展示名 → 幂等放行。
 */
export function renameAgent(db: Db, id: string, displayName: string): Agent {
  let row: AgentRow | undefined
  try {
    row = db
      .prepare<{ id: string; customName: string }, AgentRow>(
        "UPDATE agents SET custom_name = $customName WHERE id = $id RETURNING *",
      )
      .get({ id, customName: displayName })
  } catch (error) {
    // 该 UPDATE 只写 custom_name → 唯一约束冲突只可能来自展示名唯一索引。
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new AgentNameTakenError(displayName)
    }
    throw error
  }
  if (row === undefined) throw new AgentNotFoundError(id)
  return toAgent(row)
}

export function getAgent(db: Db, id: string): Agent | undefined {
  const row = db.prepare<[string], AgentRow>("SELECT * FROM agents WHERE id = ?").get(id)
  return row === undefined ? undefined : toAgent(row)
}

export function getAgentByName(db: Db, name: string): Agent | undefined {
  const row = db.prepare<[string], AgentRow>("SELECT * FROM agents WHERE name = ?").get(name)
  return row === undefined ? undefined : toAgent(row)
}

export function getAgentByTaskRef(db: Db, taskRef: string): Agent | undefined {
  const row = db
    .prepare<[string], AgentRow>("SELECT * FROM agents WHERE task_ref = ?")
    .get(taskRef)
  return row === undefined ? undefined : toAgent(row)
}

/** join_token 指纹落 `agent_keys`（spec §5.3；token 明文只在 `$AGENTCHAT_HOME/tokens/<id>` 文件）。 */
export function insertAgentKey(db: Db, joinTokenHash: string, agentId: string): void {
  db.prepare<{ joinTokenHash: string; agentId: string; createdAt: number }, void>(
    "INSERT INTO agent_keys (join_token_hash, agent_id, created_at) VALUES ($joinTokenHash, $agentId, $createdAt)",
  ).run({ joinTokenHash, agentId, createdAt: Date.now() })
}

export function getAgentByTokenHash(db: Db, joinTokenHash: string): Agent | undefined {
  const row = db
    .prepare<[string], AgentRow>(
      "SELECT a.* FROM agent_keys k JOIN agents a ON a.id = k.agent_id WHERE k.join_token_hash = ?",
    )
    .get(joinTokenHash)
  return row === undefined ? undefined : toAgent(row)
}

/** 是否持有 hub 身份（`agent_keys` 行；spec §9 Bearer 身份来源，`registerRoot` 注册时写入）。 */
export function hasAgentKey(db: Db, agentId: string): boolean {
  const row = db
    .prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM agent_keys WHERE agent_id = ?",
    )
    .get(agentId)
  return row !== undefined
}

/** store 层按 id 查找失败（行不存在）。 */
export class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`agent not found: ${agentId}`)
    this.name = "AgentNotFoundError"
  }
}

interface TouchParams {
  readonly id: string
  readonly now: number
  readonly status: AgentStatus | null
}

/**
 * 触碰更新：`last_seen` 置为当前时刻；给了 `status` 就一并迁移
 * （`retired` 同时落 `retired_at`）。迁移白名单由 core 层判定，本层只执行。
 */
export function touchAgent(db: Db, id: string, status?: AgentStatus): Agent {
  const params: TouchParams = { id, now: Date.now(), status: status ?? null }
  const row = db
    .prepare<TouchParams, AgentRow>(
      `UPDATE agents
          SET last_seen = $now,
              status = COALESCE($status, status),
              retired_at = CASE WHEN $status = 'retired' THEN $now ELSE retired_at END
        WHERE id = $id
        RETURNING *`,
    )
    .get(params)
  if (row === undefined) throw new AgentNotFoundError(id)
  return toAgent(row)
}

/** 更新状态文本（spec §9 `status`）：单行 `UPDATE ... RETURNING`；行不存在抛 `AgentNotFoundError`。 */
export function setStatusText(db: Db, id: string, text: string): Agent {
  const row = db
    .prepare<{ id: string; text: string }, AgentRow>(
      "UPDATE agents SET status_text = $text WHERE id = $id RETURNING *",
    )
    .get({ id, text })
  if (row === undefined) throw new AgentNotFoundError(id)
  return toAgent(row)
}

/**
 * 各 agent 的直达未读数：其参与会话中、未过自身 `read_states` 位点、
 * 且非自己发出的消息条数（聚合规则是 Task 4 的事，这里只算单层）。
 */
export function unreadCounts(db: Db): ReadonlyMap<string, number> {
  const rows = db
    .prepare<[], { agent_id: string; unread: number }>(
      `SELECT p.agent_id, COUNT(*) AS unread
         FROM messages m
         JOIN participants p ON p.conversation_id = m.conversation_id
         LEFT JOIN read_states r
                ON r.conversation_id = m.conversation_id AND r.agent_id = p.agent_id
        WHERE m.from_agent_id <> p.agent_id
          AND m.seq > COALESCE(r.last_read_seq, 0)
        GROUP BY p.agent_id`,
    )
    .all()
  return new Map(rows.map((row) => [row.agent_id, row.unread]))
}

export function listAgents(db: Db): Agent[] {
  const rows = db
    .prepare<[], AgentRow>("SELECT * FROM agents ORDER BY created_at ASC, name ASC")
    .all()
  return rows.map(toAgent)
}

// ── 硬删除（`/api/test/*` 测试面，不可恢复）：引用清点 + 单事务级联清理 ─────────────

/**
 * 该 agent 的**行级引用清点**（`force` 守卫判据，并作为 `agent_in_use` 的报错明细）。
 * `children` 由外键现实导出：他人行的 `parent_id` / `root_id` 指向本 id；自身
 * `root_id = id`（根节点）不算，故显式排除自身 —— 否则每个根都会「有子」而永远删不掉。
 */
export interface AgentReferences {
  readonly children: number
  readonly messages: number
  readonly approvals: number
  readonly conversations: number
  readonly participants: number
  readonly readStates: number
  readonly wakeJobs: number
  readonly keys: number
}

interface AgentReferenceRow {
  readonly children: number
  readonly messages: number
  readonly approvals: number
  readonly conversations: number
  readonly participants: number
  readonly readStates: number
  readonly wakeJobs: number
  readonly keys: number
}

const ZERO_REFERENCES: AgentReferences = {
  children: 0,
  messages: 0,
  approvals: 0,
  conversations: 0,
  participants: 0,
  readStates: 0,
  wakeJobs: 0,
  keys: 0,
}

/**
 * 一次查齐全部引用计数：八个标量子查询在同一语句内取快照（无中间态，`$id` 重复引用
 * 由 better-sqlite3 命名参数支持）。调用方在同一 `BEGIN IMMEDIATE` 事务内调用时，
 * 返回值即删除判据。
 */
export function agentReferences(db: Db, id: string): AgentReferences {
  const row = db
    .prepare<{ id: string }, AgentReferenceRow>(
      `SELECT
         (SELECT COUNT(*) FROM agents WHERE id <> $id AND (parent_id = $id OR root_id = $id)) AS children,
         (SELECT COUNT(*) FROM messages WHERE from_agent_id = $id)        AS messages,
         (SELECT COUNT(*) FROM approvals WHERE requester_agent_id = $id)  AS approvals,
         (SELECT COUNT(*) FROM conversations WHERE created_by = $id)      AS conversations,
         (SELECT COUNT(*) FROM participants WHERE agent_id = $id)         AS participants,
         (SELECT COUNT(*) FROM read_states WHERE agent_id = $id)          AS readStates,
         (SELECT COUNT(*) FROM wake_jobs WHERE agent_id = $id)            AS wakeJobs,
         (SELECT COUNT(*) FROM agent_keys WHERE agent_id = $id)           AS keys`,
    )
    .get({ id })
  return row ?? ZERO_REFERENCES
}

/** 硬删守卫 1：仍有子节点（`parent_id` / `root_id` 指向它）—— `force` 也不删子节点，避免孤儿树。 */
export class AgentHasChildrenError extends Error {
  readonly code = "agent_has_children"
  constructor(
    readonly agentId: string,
    readonly count: number,
  ) {
    super(`agent ${agentId} still has ${count} child node(s)`)
    this.name = "AgentHasChildrenError"
  }
}

/** 硬删守卫 2：未 `force` 而该 agent 仍被业务数据引用（消息 / 审批单 / 其创建的会话）。 */
export class AgentInUseError extends Error {
  readonly code = "agent_in_use"
  constructor(
    readonly agentId: string,
    readonly refs: AgentReferences,
  ) {
    super(
      `agent ${agentId} is in use (messages=${refs.messages}, approvals=${refs.approvals}, conversations=${refs.conversations})`,
    )
    this.name = "AgentInUseError"
  }
}

/**
 * 硬删报告。**口径（lead 确认的 A 口径）**：各删除字段 = 本次 `deleteAgentHard`
 * 一个事务内、相应表**实际减少的行数**（含会话级联删除的副作用行数），调用方据此对账
 * 「库里无残留」；不是对 `AgentReferences` 的预估。唯一例外 `clearedInvites` 是 UPDATE
 * 影响的 `participants.invited_by` 置 NULL 行数，不走差值。
 */
export interface AgentDeleteReport {
  readonly id: string
  readonly deletedConversations: number
  readonly deletedMessages: number
  readonly deletedApprovals: number
  readonly deletedWakeJobs: number
  readonly deletedParticipants: number
  readonly deletedReadStates: number
  readonly deletedKeys: number
  /** 置 NULL 的 `participants.invited_by` 行数（UPDATE 的 `.changes`）。 */
  readonly clearedInvites: number
}

interface TableCounts {
  readonly conversations: number
  readonly messages: number
  readonly approvals: number
  readonly wakeJobs: number
  readonly participants: number
  readonly readStates: number
  readonly keys: number
}

/** 删除前后的全库行数快照（A 口径的取数：表级差值 = 本次事务实际删除的行数）。 */
function tableCounts(db: Db): TableCounts {
  const row = db
    .prepare<[], TableCounts>(
      `SELECT
         (SELECT COUNT(*) FROM conversations) AS conversations,
         (SELECT COUNT(*) FROM messages)      AS messages,
         (SELECT COUNT(*) FROM approvals)     AS approvals,
         (SELECT COUNT(*) FROM wake_jobs)     AS wakeJobs,
         (SELECT COUNT(*) FROM participants)  AS participants,
         (SELECT COUNT(*) FROM read_states)   AS readStates,
         (SELECT COUNT(*) FROM agent_keys)    AS keys`,
    )
    .get()
  // 无 FROM 的聚合查询恒返回一行；`undefined` 仅为类型收窄（不可达）。
  if (row === undefined) throw new Error("tableCounts: aggregate query returned no row")
  return row
}

/**
 * 硬删除 agent（**不可恢复**）：`db.transaction(...).immediate()` 单事务，顺序不可变 ——
 * 见下方各步注释（顺序由 `PRAGMA foreign_keys=ON` 下的外键现实决定）。
 *
 * 1. 未知 id → `AgentNotFoundError`
 * 2. `refs.children > 0` → `AgentHasChildrenError`（`force` 也不删子节点，避免孤儿树）
 * 3. 非 `force` 且有消息 / 审批单 / 其创建的会话 → `AgentInUseError`（**任何删除之前**抛，
 *    保证失败路径零写入）
 * 4. 其创建的会话逐个 `deleteConversationCascade` 整体级联（外键顺序由该函数单点保证，勿复制 SQL）
 * 5. 其**剩余**消息（在他人创建的会话里）：先删引用这批 seq 的 wake_jobs，再删 messages
 * 6. 其发起的 approvals
 * 7. read_states + participants（自身的成员行；先于第 8 步，自引用方可安全置 NULL）
 * 8. `participants.invited_by = id` 置 NULL（外键要求，非删除）
 * 9. agent_keys
 * 10. 以它为唤醒目标的 wake_jobs（第 5 步只覆盖「其消息所引用」那批，两批可不相交）
 * 11. agents 行本身
 */
export function deleteAgentHard(
  db: Db,
  id: string,
  options?: { readonly force?: boolean },
): AgentDeleteReport {
  const force = options?.force ?? false
  const tx = db.transaction((): AgentDeleteReport => {
    if (getAgent(db, id) === undefined) throw new AgentNotFoundError(id)
    const refs = agentReferences(db, id)
    if (refs.children > 0) throw new AgentHasChildrenError(id, refs.children)
    if (!force && (refs.messages > 0 || refs.approvals > 0 || refs.conversations > 0)) {
      throw new AgentInUseError(id, refs)
    }
    const before = tableCounts(db)

    // 4) 其创建的会话：整体级联删除（含会话内他人的消息 —— 计入 deletedMessages 的差值口径）。
    const created = db
      .prepare<[string], { id: string }>("SELECT id FROM conversations WHERE created_by = ?")
      .all(id)
    for (const row of created) deleteConversationCascade(db, row.id)

    // 5) 剩余消息（他人创建的会话里）：wake_jobs（引用 messages.seq）先于 messages 删除。
    db.prepare<[string]>(
      "DELETE FROM wake_jobs WHERE message_id IN (SELECT seq FROM messages WHERE from_agent_id = ?)",
    ).run(id)
    db.prepare<[string]>("DELETE FROM messages WHERE from_agent_id = ?").run(id)

    // 6) 其发起的审批 / 请求批示单。
    db.prepare<[string]>("DELETE FROM approvals WHERE requester_agent_id = ?").run(id)

    // 7) 已读位点 + 成员行（会话内的部分已随第 4 步级联删除）。
    db.prepare<[string]>("DELETE FROM read_states WHERE agent_id = ?").run(id)
    db.prepare<[string]>("DELETE FROM participants WHERE agent_id = ?").run(id)

    // 8) 他人成员行的邀请人指向本 id → 置 NULL（UPDATE 的 changes 即 clearedInvites）。
    const clearedInvites = db
      .prepare<[string]>("UPDATE participants SET invited_by = NULL WHERE invited_by = ?")
      .run(id).changes

    // 9) join_token 指纹。
    db.prepare<[string]>("DELETE FROM agent_keys WHERE agent_id = ?").run(id)

    // 10) 以本 agent 为唤醒目标的 job。
    db.prepare<[string]>("DELETE FROM wake_jobs WHERE agent_id = ?").run(id)

    // 11) 节点行本身。
    db.prepare<[string]>("DELETE FROM agents WHERE id = ?").run(id)

    const after = tableCounts(db)
    return {
      id,
      deletedConversations: before.conversations - after.conversations,
      deletedMessages: before.messages - after.messages,
      deletedApprovals: before.approvals - after.approvals,
      deletedWakeJobs: before.wakeJobs - after.wakeJobs,
      deletedParticipants: before.participants - after.participants,
      deletedReadStates: before.readStates - after.readStates,
      deletedKeys: before.keys - after.keys,
      clearedInvites,
    }
  })
  return tx.immediate()
}
