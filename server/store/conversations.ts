/**
 * 会话、成员与已读位点（spec §5.3/§5.4）：
 * DM key 成员排序、自动两行成员、群 owner+成员、`read_states` upsert（只前进）。
 * 多行写入一律 `BEGIN IMMEDIATE`（spec §12 数据安全约束）。
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Db } from "../db"

// spec §5.3 的两个会话 kind / 成员角色；Task 8 收敛 io 契约时再并入 shared/contracts.ts。
const conversationKindSchema = z.enum(["dm", "group"])
const participantRoleSchema = z.enum(["owner", "member"])
export type ConversationKind = z.infer<typeof conversationKindSchema>
export type ParticipantRole = z.infer<typeof participantRoleSchema>

export interface Conversation {
  readonly id: string
  readonly kind: ConversationKind
  readonly key: string
  readonly name: string | undefined
  readonly createdBy: string
  readonly createdAt: number
}

export interface Participant {
  readonly conversationId: string
  readonly agentId: string
  readonly role: ParticipantRole
  readonly joinedAt: number
  readonly invitedBy: string | undefined
}

export interface ReadState {
  readonly conversationId: string
  readonly agentId: string
  readonly lastReadSeq: number
  readonly updatedAt: number
}

interface ConversationRow {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly name: string | null
  readonly created_by: string
  readonly created_at: number
}

interface ParticipantInsertParams {
  readonly conversationId: string
  readonly agentId: string
  readonly role: ParticipantRole
  readonly joinedAt: number
  readonly invitedBy: string | null
}

interface ConversationInsertParams {
  readonly id: string
  readonly kind: ConversationKind
  readonly key: string
  readonly name: string | null
  readonly createdBy: string
  readonly createdAt: number
}

interface ParticipantRow {
  readonly conversation_id: string
  readonly agent_id: string
  readonly role: string
  readonly joined_at: number
  readonly invited_by: string | null
}

/** DM 会话键（spec §5.3）：两个成员按字典序排序后拼接，`dm:<idA>_<idB>`。 */
export function dmKey(agentA: string, agentB: string): string {
  const first = agentA <= agentB ? agentA : agentB
  const second = agentA <= agentB ? agentB : agentA
  return `dm:${first}_${second}`
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: conversationKindSchema.parse(row.kind),
    key: row.key,
    name: row.name ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

function insertConversation(db: Db, c: Conversation): void {
  const params: ConversationInsertParams = {
    id: c.id,
    kind: c.kind,
    key: c.key,
    name: c.name ?? null,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
  }
  db.prepare<ConversationInsertParams, void>(
    `INSERT INTO conversations (id, kind, key, name, created_by, created_at)
     VALUES ($id, $kind, $key, $name, $createdBy, $createdAt)`,
  ).run(params)
}

function insertParticipant(db: Db, p: ParticipantInsertParams): void {
  db.prepare<ParticipantInsertParams, void>(
    `INSERT INTO participants (conversation_id, agent_id, role, joined_at, invited_by)
     VALUES ($conversationId, $agentId, $role, $joinedAt, $invitedBy)`,
  ).run(p)
}

/** 取或建 DM（幂等）：conversation + 两行成员同一 `BEGIN IMMEDIATE` 事务写入。 */
export function createDm(db: Db, agentA: string, agentB: string): Conversation {
  const tx = db.transaction((a: string, b: string): Conversation => {
    const key = dmKey(a, b)
    const existing = getConversationByKey(db, key)
    if (existing !== undefined) return existing
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      kind: "dm",
      key,
      name: undefined,
      createdBy: a,
      createdAt: now,
    }
    insertConversation(db, conversation)
    insertParticipant(db, { conversationId: conversation.id, agentId: a, role: "member", joinedAt: now, invitedBy: null })
    insertParticipant(db, { conversationId: conversation.id, agentId: b, role: "member", joinedAt: now, invitedBy: null })
    return conversation
  })
  return tx.immediate(agentA, agentB)
}

export interface CreateGroupInput {
  readonly name: string
  readonly createdBy: string
  /** 创作者之外的初始成员（重复与创作者本人自动去除）。 */
  readonly memberIds?: readonly string[]
}

/** 建群：conversation + owner 行 + 成员行同一 `BEGIN IMMEDIATE` 事务写入（任一失败全回滚）。 */
export function createGroup(db: Db, input: CreateGroupInput): Conversation {
  const tx = db.transaction((): Conversation => {
    const now = Date.now()
    const id = randomUUID()
    const conversation: Conversation = {
      id,
      kind: "group",
      key: `group:${id}`,
      name: input.name,
      createdBy: input.createdBy,
      createdAt: now,
    }
    insertConversation(db, conversation)
    insertParticipant(db, { conversationId: id, agentId: input.createdBy, role: "owner", joinedAt: now, invitedBy: null })
    const members = new Set(input.memberIds ?? [])
    members.delete(input.createdBy)
    for (const agentId of members) {
      insertParticipant(db, { conversationId: id, agentId, role: "member", joinedAt: now, invitedBy: input.createdBy })
    }
    return conversation
  })
  return tx.immediate()
}

export interface AddParticipantInput {
  readonly conversationId: string
  readonly agentId: string
  readonly role?: ParticipantRole
  readonly invitedBy?: string
}

/** 拉成员入会话（单行写入，语句自身原子）。 */
export function addParticipant(db: Db, input: AddParticipantInput): void {
  insertParticipant(db, {
    conversationId: input.conversationId,
    agentId: input.agentId,
    role: input.role ?? "member",
    joinedAt: Date.now(),
    invitedBy: input.invitedBy ?? null,
  })
}

export function getConversation(db: Db, id: string): Conversation | undefined {
  const row = db
    .prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE id = ?")
    .get(id)
  return row === undefined ? undefined : toConversation(row)
}

export function getConversationByKey(db: Db, key: string): Conversation | undefined {
  const row = db
    .prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE key = ?")
    .get(key)
  return row === undefined ? undefined : toConversation(row)
}

export function listConversations(db: Db): Conversation[] {
  const rows = db
    .prepare<[], ConversationRow>("SELECT * FROM conversations ORDER BY created_at ASC")
    .all()
  return rows.map(toConversation)
}

export function listParticipants(db: Db, conversationId: string): Participant[] {
  const rows = db
    .prepare<[string], ParticipantRow>(
      "SELECT * FROM participants WHERE conversation_id = ? ORDER BY joined_at ASC",
    )
    .all(conversationId)
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    role: participantRoleSchema.parse(row.role),
    joinedAt: row.joined_at,
    invitedBy: row.invited_by ?? undefined,
  }))
}

export function isParticipant(db: Db, conversationId: string, agentId: string): boolean {
  const row = db
    .prepare<[string, string], { present: number }>(
      "SELECT 1 AS present FROM participants WHERE conversation_id = ? AND agent_id = ?",
    )
    .get(conversationId, agentId)
  return row !== undefined
}

export interface MarkReadInput {
  readonly conversationId: string
  readonly agentId: string
  readonly lastReadSeq: number
}

/**
 * 已读位点 upsert（spec §5.4）：单语句原子写入；
 * 位点只前进不回退（旧 ack 不得把已读拉回）。
 */
export function markRead(db: Db, input: MarkReadInput): void {
  const params: MarkReadInput & { updatedAt: number } = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    lastReadSeq: input.lastReadSeq,
    updatedAt: Date.now(),
  }
  db.prepare<MarkReadInput & { updatedAt: number }, void>(
    `INSERT INTO read_states (conversation_id, agent_id, last_read_seq, updated_at)
     VALUES ($conversationId, $agentId, $lastReadSeq, $updatedAt)
     ON CONFLICT (conversation_id, agent_id) DO UPDATE SET
       last_read_seq = MAX(read_states.last_read_seq, excluded.last_read_seq),
       updated_at = excluded.updated_at`,
  ).run(params)
}

export function getReadState(db: Db, conversationId: string, agentId: string): ReadState | undefined {
  const row = db
    .prepare<
      [string, string],
      { conversation_id: string; agent_id: string; last_read_seq: number; updated_at: number }
    >("SELECT * FROM read_states WHERE conversation_id = ? AND agent_id = ?")
    .get(conversationId, agentId)
  return row === undefined
    ? undefined
    : {
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        lastReadSeq: row.last_read_seq,
        updatedAt: row.updated_at,
      }
}
