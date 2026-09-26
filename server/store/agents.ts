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

export function listAgents(db: Db): Agent[] {
  const rows = db
    .prepare<[], AgentRow>("SELECT * FROM agents ORDER BY created_at ASC, name ASC")
    .all()
  return rows.map(toAgent)
}
