/**
 * UI 读模型（spec §11.3；Task 9）——会话列表（双层聚合未读 + 最后预览）、群列表、
 * 资料卡。路由层只做 HTTP 编排，聚合逻辑集中在本 core 层（routes/ui.ts 保持薄）。
 *
 * - 每会话 `unread` 按 human 位点（super-observer 已在 Task 4 修入）
 * - `unreadByRoot` 对每个根调既有 `unreadFor`（自身 + 全部后代递归，两层聚合）
 * - 排序：最后消息时间倒序（无消息者置底，稳定次序按会话创建序）
 */
import type { Db } from "../db"
import { listAgents } from "../store/agents"
import { isParticipant, listConversations, SHOUT_KEY } from "../store/conversations"
import { latestInConversation, type Message } from "../store/messages"
import { rosterTree, type RosterNode } from "./agents"
import { ensureHuman, unreadFor } from "./messaging"

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
  readonly lastMessage: ConversationPreview | null
  readonly unread: number
}

export interface ConversationListResult {
  readonly conversations: readonly ConversationSummary[]
  readonly unreadByRoot: Readonly<Record<string, number>>
}

export interface GroupEntry {
  readonly id: string
  readonly name: string | null
  readonly key: string
  readonly createdBy: string
  readonly createdAt: number
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
      name: conversation.name ?? null,
      key: conversation.key,
      createdBy: conversation.createdBy,
      createdAt: conversation.createdAt,
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
