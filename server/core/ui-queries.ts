/**
 * UI 读模型（spec §11.3；Task 9）——会话列表（双层聚合未读 + 最后预览）、群列表、
 * 资料卡。路由层只做 HTTP 编排，聚合逻辑集中在本 core 层（routes/ui.ts 保持薄）。
 *
 * - 每会话 `unread` 按 human 位点（super-observer 已在 Task 4 修入）
 * - `unreadByRoot` 对每个根调既有 `unreadFor`（自身 + 全部后代递归，两层聚合）
 * - 排序：最后消息时间倒序（无消息者置底，稳定次序按会话创建序）
 */
import {
  RECEIPT_STAGES,
  type ChatMessage,
  type NotificationEntry,
  type ReceiptStage,
} from "../../shared/contracts"
import type { Db } from "../db"
import { listAgents } from "../store/agents"
import type { Approval } from "../store/approvals"
import {
  getConversation,
  isParticipant,
  listConversations,
  listParticipants,
  SHOUT_KEY,
  type Conversation,
} from "../store/conversations"
import { findCardMessage, history, latestInConversation, type Message } from "../store/messages"
import { listNotifications, type NotificationScope } from "../store/notifications"
import { rosterTree, type RosterNode } from "./agents"
import { ensureHuman, recipientsOf, unreadFor } from "./messaging"
import { batchReceiptStates, type ReceiptStageMap } from "./publish"

/** 会话最后一条消息预览（随 `GET /api/conversations` 返回）。 */
export interface ConversationPreview {
  readonly id: string
  readonly seq: number
  readonly from: string
  readonly body: string
  readonly createdAt: number
}

export interface ConversationSummary {
  readonly id: string
  readonly name: string | null
  readonly kind: "dm" | "group"
  readonly key: string
  /** 会话创建时间（无消息的新会话排序依据；Plan 3 T7）。 */
  readonly createdAt: number
  readonly lastMessage: ConversationPreview | null
  readonly unread: number
}

export interface ConversationListResult {
  readonly conversations: readonly ConversationSummary[]
  readonly unreadByRoot: Readonly<Record<string, number>>
}

export interface GroupEntry {
  readonly id: string
  readonly kind: Conversation["kind"]
  readonly name: string | null
  readonly key: string
  readonly createdBy: string
  readonly createdAt: number
  /** 参与者 agent id（含 human 创建者）；Plan 3 T7 群资料页成员树数据源。 */
  readonly members: readonly string[]
}

/** 某会话内 human 的未读数（未过 human 位点且非 human 自发的消息）。 */
function humanUnreadIn(db: Db, conversationId: string, humanId: string): number {
  const row = db
    .prepare<[string, string, string, string], { unread: number }>(
      `SELECT COUNT(m.seq) AS unread FROM messages m
        WHERE m.conversation_id = ? AND m.from_agent_id <> ?
          AND m.seq > COALESCE((SELECT last_read_seq FROM read_states
                                 WHERE conversation_id = ? AND agent_id = ?), 0)`,
    )
    .get(conversationId, humanId, conversationId, humanId)
  return row?.unread ?? 0
}

function previewOf(message: Message | undefined): ConversationPreview | null {
  return message === undefined
    ? null
    : {
        id: message.id,
        seq: message.seq,
        from: message.fromAgentId,
        body: message.body,
        createdAt: message.createdAt,
      }
}

/** 会话列表：每会话最后预览 + human 未读；`unreadByRoot` 为各根的双层聚合未读。 */
export function conversationList(db: Db): ConversationListResult {
  const human = ensureHuman(db)
  const conversations = listConversations(db).map(
    (conversation): ConversationSummary => ({
      id: conversation.id,
      name: conversation.name ?? null,
      kind: conversation.kind,
      key: conversation.key,
      createdAt: conversation.createdAt,
      lastMessage: previewOf(latestInConversation(db, conversation.id)),
      unread: humanUnreadIn(db, conversation.id, human.id),
    }),
  )
  const lastTime = (summary: ConversationSummary): number => summary.lastMessage?.createdAt ?? 0
  conversations.sort((a, b) => lastTime(b) - lastTime(a))
  const unreadByRoot: Record<string, number> = {}
  for (const agent of listAgents(db)) {
    if (agent.parentId === undefined) unreadByRoot[agent.id] = unreadFor(db, agent.id)
  }
  return { conversations, unreadByRoot }
}

/** 群列表（kind=group：普通群 + 喊话广播会话）。 */
export function groupList(db: Db): readonly GroupEntry[] {
  return listConversations(db)
    .filter((conversation) => conversation.kind === "group")
    .map((conversation) => ({
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name ?? null,
      key: conversation.key,
      createdBy: conversation.createdBy,
      createdAt: conversation.createdAt,
      members: listParticipants(db, conversation.id).map((participant) => participant.agentId),
    }))
}

export interface AgentConversationEntry {
  readonly id: string
  readonly name: string | null
  readonly kind: "dm" | "group"
  readonly key: string
}

export interface AgentCard {
  readonly node: RosterNode
  readonly conversations: readonly AgentConversationEntry[]
}

function findNode(nodes: readonly RosterNode[], id: string): RosterNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** 资料卡：roster 树节点 + 其参与的会话入口列表（human 为超级观察者，含全部会话）。 */
export function agentCard(db: Db, id: string): AgentCard | undefined {
  const node = findNode(rosterTree(db), id)
  if (node === undefined) return undefined
  const isHumanAgent = listAgents(db).find((agent) => agent.id === id)?.vendor === "human"
  const conversations = listConversations(db)
    .filter(
      (conversation) =>
        isHumanAgent ||
        conversation.key === SHOUT_KEY ||
        isParticipant(db, conversation.id, id),
    )
    .map(
      (conversation): AgentConversationEntry => ({
        id: conversation.id,
        name: conversation.name ?? null,
        kind: conversation.kind,
        key: conversation.key,
      }),
    )
  return { node, conversations }
}

// ── 通知页读模型（spec §11.5/§17.3；Task 4）─────────────────────────

/** 单条通知组装：单据全量 + 卡消息深链锚点（`cardMessageId` + `conversationId`）。 */
function notificationEntry(db: Db, approval: Approval): NotificationEntry {
  const card = findCardMessage(db, approval.id)
  return {
    id: approval.id,
    kind: approval.kind,
    requesterAgentId: approval.requesterAgentId,
    target: approval.target,
    action: approval.action,
    payload: approval.payload,
    status: approval.status,
    ...(approval.result === undefined ? {} : { result: approval.result }),
    createdAt: approval.createdAt,
    ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
    ...(approval.readAt === undefined ? {} : { readAt: approval.readAt }),
    cardMessageId: card?.id ?? null,
    conversationId: card?.conversationId ?? null,
  }
}

/**
 * 通知列表（spec §11.5）：`scope` 语义见 `store/notifications.listNotifications`
 * （`actionable` = `target='human' AND status='pending'`；`all` = 全部）；
 * 每条附深链锚点，供 UI `?conversation=<id>&msg=<cardMessageId>` 滚动定位。
 */
export function notificationList(db: Db, scope: NotificationScope): readonly NotificationEntry[] {
  return listNotifications(db, scope).map((approval) => notificationEntry(db, approval))
}

// ── 聊天视图读模型（spec §11.4；Plan 3 T5 决议 1：自有消息回执） ──────

/** 四级回执顺序索引（聚合「取最落后」= 取最小索引）。 */
function stageRank(stage: ReceiptStage): number {
  return RECEIPT_STAGES.indexOf(stage)
}

/** 消息线格式基础字段（不含回执）。 */
function bareMessage(message: Message): ChatMessage {
  return {
    seq: message.seq,
    id: message.id,
    conversationId: message.conversationId,
    fromAgentId: message.fromAgentId,
    body: message.body,
    kind: message.kind,
    createdAt: message.createdAt,
    ...(message.meta === undefined ? {} : { meta: message.meta }),
    ...(message.revokedAt === undefined ? {} : { revoked_at: message.revokedAt }),
  }
}

/**
 * 单条消息出参：自有（human 发出）**文本**消息附各收件方四级回执 + 聚合 stage（取最落后）。
 * 非己方 / 系统消息 / 无收件方 → 不加回执字段（决议 1）。回执来自批量派生（复审 I3）。
 */
function chatMessageView(
  message: Message,
  humanId: string,
  recipients: readonly string[],
  receiptMap: ReceiptStageMap,
): ChatMessage {
  const base = bareMessage(message)
  if (message.kind !== "text" || message.fromAgentId !== humanId || recipients.length === 0) {
    return base
  }
  const perAgent = receiptMap.get(message.seq)
  if (perAgent === undefined) return base
  const receipts = recipients.map((agentId) => ({
    agentId,
    stage: perAgent.get(agentId) ?? "queued",
  }))
  const [first, ...rest] = receipts
  if (first === undefined) return base
  const receiptStage = rest.reduce<ReceiptStage>(
    (laggard, view) => (stageRank(view.stage) < stageRank(laggard) ? view.stage : laggard),
    first.stage,
  )
  return { ...base, receipts, receiptStage }
}

/**
 * 会话历史（UI 出参 `GET /api/conversations/:id/messages`）：分页语义同 `store.history`，
 * 自有文本消息附四级回执（决议 1）。**每请求只解析一次会话 / 收件方，并批量取回执**
 * （复审 I3：由每消息 O(M) 查询降为 O(N+M) 内存映射）。未知会话由路由层先 404。
 */
export function conversationMessages(
  db: Db,
  conversationId: string,
  humanId: string,
  before?: number,
  limit?: number,
): readonly ChatMessage[] {
  const messages = history(db, {
    conversationId,
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  })
  const conversation = getConversation(db, conversationId)
  if (conversation === undefined) return messages.map(bareMessage)
  const recipients = recipientsOf(db, conversation, humanId)
  const receiptMap = batchReceiptStates(db, conversationId, messages, recipients)
  return messages.map((message) => chatMessageView(message, humanId, recipients, receiptMap))
}
