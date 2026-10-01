/**
 * 会话、成员与未读聚合（spec §5.3/§5.4）：
 * DM key 成员排序、自动两行成员、群 owner+成员、喊话广播会话（无成员行）、
 * 全员直达未读计数。已读位点（`read_states`）访问器在 `./read_states.ts`。
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

/** 移除会话成员行（F2 群成员移除）：仅删 participants 行；群/在群/至少一人守卫在路由层。 */
export function removeParticipant(db: Db, conversationId: string, agentId: string): void {
  db.prepare<[string, string]>(
    "DELETE FROM participants WHERE conversation_id = ? AND agent_id = ?",
  ).run(conversationId, agentId)
}

/**
 * 解散会话级联删除（F2）：schema 外键无 `ON DELETE CASCADE` 且 `PRAGMA foreign_keys=ON`，
 * 按被引用顺序手动处置 —— wake_jobs（引用 messages.seq）→ messages → read_states →
 * participants → conversations，同一事务原子落库。
 */
export function deleteConversationCascade(db: Db, conversationId: string): void {
  const tx = db.transaction((id: string): void => {
    db.prepare<[string]>(
      "DELETE FROM wake_jobs WHERE message_id IN (SELECT seq FROM messages WHERE conversation_id = ?)",
    ).run(id)
    db.prepare<[string]>("DELETE FROM messages WHERE conversation_id = ?").run(id)
    db.prepare<[string]>("DELETE FROM read_states WHERE conversation_id = ?").run(id)
    db.prepare<[string]>("DELETE FROM participants WHERE conversation_id = ?").run(id)
    db.prepare<[string]>("DELETE FROM conversations WHERE id = ?").run(id)
  })
  tx(conversationId)
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

/** 喊话广播会话（决议 3）：全库唯一，`key='shout'`、kind=group、**无 participants 行**。 */
export const SHOUT_KEY = "shout"
export const SHOUT_NAME = "全员喊话"

/** 取或建喊话广播会话（幂等；conversation 单行写入，语句自身原子）。 */
export function ensureShoutConversation(db: Db, createdBy: string): Conversation {
  const tx = db.transaction((creator: string): Conversation => {
    const existing = getConversationByKey(db, SHOUT_KEY)
    if (existing !== undefined) return existing
    const conversation: Conversation = {
      id: randomUUID(),
      kind: "group",
      key: SHOUT_KEY,
      name: SHOUT_NAME,
      createdBy: creator,
      createdAt: Date.now(),
    }
    insertConversation(db, conversation)
    return conversation
  })
  return tx.immediate(createdBy)
}

/**
 * 各 agent 的直达未读**消息 seq 集合**（决议 3/5）：其**参与会话 + 喊话广播会话**中、
 * 未过自身 `read_states` 位点、且非自己发出的消息。返回集合而非计数，供 `unreadFor`
 * 在子树内**按 message id 去重**（同一消息被多名子树成员未读只计一次）。
 * 喊话会话无成员行，对全节点可见，故不能复用 `store/agents.unreadCounts`（只算参与者）。
 * human = 隐含成员 + 超级观察者（复审 Important #1）：`a.vendor='human'` 计入
 * **全部会话**的未读；其他节点谓词与修复前逐字相同。
 */
export function directUnreadSeqs(db: Db, shoutConversationId: string): ReadonlyMap<string, Set<number>> {
  const rows = db
    .prepare<{ shoutId: string }, { agent_id: string; seq: number }>(
      `SELECT a.id AS agent_id, m.seq AS seq
         FROM agents a
         JOIN messages m ON m.from_agent_id <> a.id
        WHERE (m.conversation_id = $shoutId
               OR a.vendor = 'human'
               OR m.conversation_id IN (SELECT conversation_id FROM participants WHERE agent_id = a.id))
          AND m.seq > COALESCE((SELECT last_read_seq FROM read_states r
                                 WHERE r.conversation_id = m.conversation_id AND r.agent_id = a.id), 0)`,
    )
    .all({ shoutId: shoutConversationId })
  const byAgent = new Map<string, Set<number>>()
  for (const row of rows) {
    const seqs = byAgent.get(row.agent_id)
    if (seqs === undefined) byAgent.set(row.agent_id, new Set([row.seq]))
    else seqs.add(row.seq)
  }
  return byAgent
}
