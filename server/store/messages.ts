/**
 * `messages` 表读写（spec §5.3/§6/§12）：
 * 全局 seq 顺序唯一来源、短随机码 id、`idempotencyKey` 幂等重发、历史分页。
 */
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { Db } from "../db"

// spec §5.3 的消息 kind；Task 8 收敛 io 契约时再并入 shared/contracts.ts。
const messageKindSchema = z.enum(["text", "system"])
const metaSchema = z.record(z.string(), z.unknown())
export type MessageKind = z.infer<typeof messageKindSchema>

const DEFAULT_HISTORY_LIMIT = 50

export interface Message {
  readonly seq: number
  readonly id: string
  readonly conversationId: string
  readonly fromAgentId: string
  readonly body: string
  readonly kind: MessageKind
  readonly meta: Record<string, unknown> | undefined
  readonly idempotencyKey: string | undefined
  readonly createdAt: number
}

export interface SendInput {
  readonly conversationId: string
  readonly fromAgentId: string
  readonly body: string
  readonly kind?: MessageKind
  readonly meta?: Record<string, unknown>
  readonly idempotencyKey?: string
}

export interface HistoryQuery {
  readonly conversationId: string
  /** 分页游标（seq，不含）；缺省返回最新一页。 */
  readonly before?: number
  readonly limit?: number
}

interface MessageRow {
  readonly seq: number
  readonly id: string
  readonly conversation_id: string
  readonly from_agent_id: string
  readonly body: string
  readonly kind: string
  readonly meta: string | null
  readonly idempotency_key: string | null
  readonly created_at: number
}

function toMessage(row: MessageRow): Message {
  return {
    seq: row.seq,
    id: row.id,
    conversationId: row.conversation_id,
    fromAgentId: row.from_agent_id,
    body: row.body,
    kind: messageKindSchema.parse(row.kind),
    meta: row.meta === null ? undefined : metaSchema.parse(JSON.parse(row.meta)),
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
  }
}

function findByIdempotencyKey(db: Db, fromAgentId: string, key: string): Message | undefined {
  const row = db
    .prepare<[string, string], MessageRow>(
      "SELECT * FROM messages WHERE from_agent_id = ? AND idempotency_key = ?",
    )
    .get(fromAgentId, key)
  return row === undefined ? undefined : toMessage(row)
}

/**
 * 写入一条消息（spec §12 重复投递安全）：同 `(from_agent_id, idempotency_key)`
 * 重复发送返回首条，不产生第二行。单行写入，语句自身原子。
 */
export function send(db: Db, input: SendInput): Message {
  const key = input.idempotencyKey
  if (key !== undefined) {
    const existing = findByIdempotencyKey(db, input.fromAgentId, key)
    if (existing !== undefined) return existing
  }
  const id = randomBytes(6).toString("hex")
  const now = Date.now()
  const kind: MessageKind = input.kind ?? "text"
  const metaJson = input.meta === undefined ? null : JSON.stringify(input.meta)
  const result = db
    .prepare<
      [string, string, string, string, MessageKind, string | null, string | null, number],
      void
    >(
      `INSERT INTO messages (id, conversation_id, from_agent_id, body, kind, meta, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.conversationId, input.fromAgentId, input.body, kind, metaJson, key ?? null, now)
  return {
    seq: Number(result.lastInsertRowid),
    id,
    conversationId: input.conversationId,
    fromAgentId: input.fromAgentId,
    body: input.body,
    kind,
    meta: input.meta,
    idempotencyKey: key,
    createdAt: now,
  }
}

export function getBySeq(db: Db, seq: number): Message | undefined {
  const row = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE seq = ?").get(seq)
  return row === undefined ? undefined : toMessage(row)
}

/** 按短随机码取消息。 */
export function getById(db: Db, id: string): Message | undefined {
  const row = db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE id = ?").get(id)
  return row === undefined ? undefined : toMessage(row)
}

/** 会话内最新一条消息（WS `message`/`receipt` 事件与 UI 预览的载荷来源；空会话 → undefined）。 */
export function latestInConversation(db: Db, conversationId: string): Message | undefined {
  const row = db
    .prepare<[string], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(conversationId)
  return row === undefined ? undefined : toMessage(row)
}

/**
 * 卡消息反查（Task 4 深链锚点，spec §11.5）：按卡 `meta.askId` / `meta.approvalId` 命中单据卡，
 * 取**最早一条** —— 卡先于答复/回执落库，故最早即卡本身（而非答复/回执消息）。无卡 → `undefined`。
 * JSON1 `json_extract`（better-sqlite3 内建启用）；`meta IS NULL` 时返回 null，比较自然不命中。
 */
export function findCardMessage(db: Db, approvalId: string): Message | undefined {
  const row = db
    .prepare<{ id: string }, MessageRow>(
      `SELECT * FROM messages
        WHERE json_extract(meta, '$.askId') = $id OR json_extract(meta, '$.approvalId') = $id
        ORDER BY seq ASC LIMIT 1`,
    )
    .get({ id: approvalId })
  return row === undefined ? undefined : toMessage(row)
}

/**
 * 会话历史：默认返回最新一页（seq 升序）；
 * 给 `before`（seq，不含）则返回紧邻其前的一页，供客户端向上翻页。
 */
export function history(db: Db, query: HistoryQuery): Message[] {
  const limit = query.limit ?? DEFAULT_HISTORY_LIMIT
  const rows =
    query.before === undefined
      ? db
          .prepare<{ conversationId: string; limit: number }, MessageRow>(
            `SELECT * FROM messages WHERE conversation_id = $conversationId
             ORDER BY seq DESC LIMIT $limit`,
          )
          .all({ conversationId: query.conversationId, limit })
      : db
          .prepare<{ conversationId: string; before: number; limit: number }, MessageRow>(
            `SELECT * FROM messages WHERE conversation_id = $conversationId AND seq < $before
             ORDER BY seq DESC LIMIT $limit`,
          )
          .all({ conversationId: query.conversationId, before: query.before, limit })
  return rows.reverse().map(toMessage)
}

/** 游标之后的增量消息（升序）——重连补同步与阻塞等待醒来后的复查用。 */
export function messagesAfter(db: Db, conversationId: string, afterSeq: number): Message[] {
  const rows = db
    .prepare<[string, number], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(conversationId, afterSeq)
  return rows.map(toMessage)
}

export interface InboxQuery {
  readonly agentId: string
  /** 喊话广播会话 id；尚无喊话会话时传 `""`（空串恒不匹配真实 id）。 */
  readonly shoutConversationId: string
  /** 游标（seq，不含）；0 = 从头。 */
  readonly after: number
  readonly limit: number
}

export const DEFAULT_INBOX_LIMIT = 50

/**
 * 收件箱：agent 可见会话（其参与的会话 + 喊话广播会话，决议 3）中游标之后的消息，
 * 全局 seq 升序。human = 隐含成员 + 超级观察者（复审 Important #1）：`vendor='human'`
 * 跳过成员过滤、可见**全部会话**（shout 规则对其他节点照旧）。可见性只由成员表、
 * 广播会话与 human 身份决定，不过滤己方消息（DoD：喊话对每个节点各得一条）。
 */
export function inboxMessages(db: Db, query: InboxQuery): Message[] {
  const rows = db
    .prepare<InboxQuery, MessageRow>(
      `SELECT * FROM messages
        WHERE seq > $after
          AND (conversation_id = $shoutConversationId
               OR EXISTS (SELECT 1 FROM agents WHERE id = $agentId AND vendor = 'human')
               OR conversation_id IN (SELECT conversation_id FROM participants WHERE agent_id = $agentId))
        ORDER BY seq ASC
        LIMIT $limit`,
    )
    .all(query)
  return rows.map(toMessage)
}
