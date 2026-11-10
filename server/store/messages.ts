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
  /** 发送方撤回时间（epoch ms）；`undefined` = 未撤回。 */
  readonly revokedAt: number | undefined
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
  readonly revoked_at: number | null
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
    revokedAt: row.revoked_at ?? undefined,
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
    revokedAt: undefined,
  }
}

/**
 * 置撤回位点（条件更新：仅未撤回时写入，返回受影响行数作为幂等闸）。
 * `revoked_at` 一次落定后不再改写（二次调用 changes=0）。
 */
export function markRevoked(db: Db, input: { readonly id: string; readonly now: number }): number {
  return db
    .prepare<[number, string], void>(
      "UPDATE messages SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .run(input.now, input.id).changes
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
  /**
   * **额外**下界（seq，不含），用于翻页；缺省 0。
   * 真正的"未读"判据是每会话 `read_states` 位点（见 `inboxMessages`），本游标叠加其上。
   */
  readonly after: number
  readonly limit: number
}

export const DEFAULT_INBOX_LIMIT = 50

/**
 * 收件箱 = **未读**（spec §9 工具承诺的「收件箱（未读+提及）」）：
 * 可见会话中、**该 agent 自身每会话 `read_states` 位点之后**的消息，全局 seq 升序。
 *
 * 为什么必须带未读游标（P9 修复）：先前只用 `seq > $after`（`after` 缺省 0），取到的是
 * **全部可见历史的最旧 limit 条** —— 新到的未读消息 seq 更大，永远挤不进这一页，于是
 * 「unread=3 但 inbox 页里全是旧 DM」；也与 `unreadFor` / `directUnreadSeqs` 的口径打架。
 * 无 `read_states` 行视为 0（该会话全部未读），故**从未 ack 过的 agent / human 行为等价于
 * "未被读过的都算未读"**，与 `directUnreadSeqs` 的 `COALESCE(..., 0)` 逐字同源。
 *
 * 可见性不变（决议 3 + 复审 Important #1）：参与会话 + 喊话广播会话；human = 隐含成员 +
 * 超级观察者（`vendor='human'` 跳过成员过滤、可见全部会话）。
 * **不过滤己方消息**（与 `claimableInboxMessages` 的关键差别 —— 后者是投递台账，按 P2 口径
 * 过滤自发；此处只加未读游标，不改这一条）。
 * `after` 语义保留为额外下界（翻页）：缺省 0 时由未读游标主导。
 */
export function inboxMessages(db: Db, query: InboxQuery): Message[] {
  const rows = db
    .prepare<InboxQuery, MessageRow>(
      `SELECT * FROM messages
        WHERE seq > $after
          AND seq > COALESCE((SELECT last_read_seq FROM read_states r
                               WHERE r.agent_id = $agentId
                                 AND r.conversation_id = messages.conversation_id), 0)
          AND (conversation_id = $shoutConversationId
               OR EXISTS (SELECT 1 FROM agents WHERE id = $agentId AND vendor = 'human')
               OR conversation_id IN (SELECT conversation_id FROM participants WHERE agent_id = $agentId))
        ORDER BY seq ASC
        LIMIT $limit`,
    )
    .all(query)
  return rows.map(toMessage)
}

export interface ClaimableInboxQuery extends InboxQuery {
  /** 注入时钟：`sending` 在途租约的到期判定（`retry_at <= now`）用。 */
  readonly now: number
  /**
   * runtime 收件方的投递台账闸门（spec §14.4：jobs 即唯一台账）；logical（含 human）
   * 不门控、纯收件箱。
   */
  readonly runtimeGated: boolean
}

/** 绑定参数（`runtimeGated` 落 SQL 为 0/1；better-sqlite3 不支持 boolean 绑定）。 */
interface ClaimableInboxParams {
  readonly agentId: string
  readonly shoutConversationId: string
  readonly after: number
  readonly limit: number
  readonly now: number
  readonly runtimeGated: number
}

/**
 * /internal/wake 的**可认领候选**（P2 修复：认领页饥饿）。
 *
 * 与 `inboxMessages` 的唯一差别是：候选集在 SQL 层就与 `claimWakeBacklog` 的 JS 判据
 * 逐条对齐，因此**每一页都能被吃满**——被认领/已读/已撤回/无 job 的行不再占据窗口，
 * `after = 0` 的下一页自然推进。改前只取「最旧 50 条」再在 JS 里跳过，窗口永不前进：
 * 收件方累计可见消息 >50 后新消息永远进不了这一页（永久 `pending, attempts=0`）。
 *
 * 判据镜像（与 `claimWakeBacklog` 分支一一对应，任一改动必须两边同步）：
 * - `revoked_at IS NULL` ← 撤回守卫（绝不投递、绝不补建 job）
 * - `from_agent_id != agentId` ← 自发消息过滤
 * - 无 `read_states` 位点 `>= seq` ← 回执 `read` 跳过
 * - runtime：`pending` ｜ `sending` 且租约过期 ｜ **system 且无 job 行**
 *   （system 豁免：ask 卡/入群通知必须达）；非 runtime 不加此闸
 * - 可见性（参与会话 + 喊话广播 + human 超级观察者）与 `inboxMessages` 完全一致
 */
export function claimableInboxMessages(db: Db, query: ClaimableInboxQuery): Message[] {
  const rows = db
    .prepare<ClaimableInboxParams, MessageRow>(
      `SELECT * FROM messages
        WHERE seq > $after
          AND revoked_at IS NULL
          AND from_agent_id != $agentId
          AND NOT EXISTS (
            SELECT 1 FROM read_states r
             WHERE r.conversation_id = messages.conversation_id
               AND r.agent_id = $agentId
               AND r.last_read_seq >= messages.seq)
          AND (conversation_id = $shoutConversationId
               OR EXISTS (SELECT 1 FROM agents WHERE id = $agentId AND vendor = 'human')
               OR conversation_id IN (SELECT conversation_id FROM participants WHERE agent_id = $agentId))
          AND (
            $runtimeGated = 0
            OR EXISTS (
              SELECT 1 FROM wake_jobs j
               WHERE j.message_id = messages.seq AND j.agent_id = $agentId
                 AND (j.state = 'pending' OR (j.state = 'sending' AND j.retry_at <= $now)))
            OR (kind = 'system'
                AND NOT EXISTS (
                  SELECT 1 FROM wake_jobs j2
                   WHERE j2.message_id = messages.seq AND j2.agent_id = $agentId)))
        ORDER BY seq ASC
        LIMIT $limit`,
    )
    .all({ ...query, runtimeGated: query.runtimeGated ? 1 : 0 })
  return rows.map(toMessage)
}

// ── 硬删除原语（`/api/test/*` 测试面）：外键现实决定必须先删 wake_jobs 再删消息 ──

/**
 * 按**短随机码**删除单条消息（`DELETE /api/test/messages/:id`）。
 *
 * 外键现实：`wake_jobs.message_id REFERENCES messages(seq)` 且 `PRAGMA foreign_keys=ON`，
 * 故同一 `BEGIN IMMEDIATE` 事务内先删引用该消息的 wake_jobs，再删 `messages` 行 ——
 * 注意 `messages.id` 是短码，被引用的主键是 `seq`（子查询换算）。返回是否真的删掉
 * （`false` = 短码不存在，路由层据此 404 `message_not_found`）。
 */
export function deleteMessageById(db: Db, id: string): boolean {
  const tx = db.transaction((messageId: string): boolean => {
    db.prepare<[string]>(
      "DELETE FROM wake_jobs WHERE message_id IN (SELECT seq FROM messages WHERE id = ?)",
    ).run(messageId)
    return db.prepare<[string]>("DELETE FROM messages WHERE id = ?").run(messageId).changes > 0
  })
  return tx.immediate(id)
}

/**
 * 清空会话全部消息（`POST /api/test/conversations/:id/purge`）：保留会话与成员，
 * 只删消息及其 wake_jobs。同事务、同顺序（先 wake_jobs 后 messages），返回删除的**消息**条数
 * （不含 wake_jobs —— 调用方要的是「清掉几条消息」）。
 */
export function deleteMessagesInConversation(db: Db, conversationId: string): number {
  const tx = db.transaction((id: string): number => {
    db.prepare<[string]>(
      "DELETE FROM wake_jobs WHERE message_id IN (SELECT seq FROM messages WHERE conversation_id = ?)",
    ).run(id)
    return db.prepare<[string]>("DELETE FROM messages WHERE conversation_id = ?").run(id).changes
  })
  return tx.immediate(conversationId)
}
