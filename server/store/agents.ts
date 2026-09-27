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

const skillsSchema = z.array(z.string())

export interface Agent {
  readonly id: string
  readonly name: string
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
