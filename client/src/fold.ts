/**
 * 会话列表折叠纯函数（spec §11.3；Plan 3 T4）。输入 `(conversations, roster)`
 * → 顶层行数组：① 喊话置顶；② 群聊/逻辑节点私聊顶层；③ runtime 根私聊=折叠容器（同根子树
 * 全部子私聊嵌套其内）；④ human 节点与 human 会话完全过滤；⑤ 其余按最后消息时间倒序。
 * 归属规则单源在 `ownership.ts`（与会话列表/组织树/未读聚合共用）。
 * 展开态走手风琴，持久化键前缀 `agentchat:`，坏 JSON 容错。
 */
import type { ConversationSummary, RosterNode } from "../../shared/contracts"
import { loadExpanded, saveExpanded, toggleExpanded, type StorageLike } from "./accordion"
import {
  buildRosterIndex,
  hasContainerParticipant,
  isHumanDm,
  resolveOwner,
  type RosterIndex,
} from "./ownership"
import { aggregateUnread } from "./unread"

export type { StorageLike }
/** 嵌套于根容器内的子会话行。 */
export interface ChildRow {
  readonly conversation: ConversationSummary
  readonly node: RosterNode | undefined
  /** `status==='retired'`：灰显、不可开聊（仍在原位）。 */
  readonly retired: boolean
}

/** 顶层行（喊话 / 群 / 逻辑私聊 / 根容器）。 */
export interface FoldedRow {
  readonly kind: "shout" | "group" | "logical" | "root"
  /** 稳定 key：容器根用 rootId，其余用 conversation.id。 */
  readonly id: string
  /** 行自身会话；容器根无自有 DM 时为 null（仍可展开）。 */
  readonly conversation: ConversationSummary | null
  readonly node: RosterNode | undefined
  /**
   * 容器根 = **human 观察者口径的全子树聚合未读**（`aggregateUnread`：自身 + 全部后代会话的
   * 每条会话 human 侧 `unread` 之和，spec §11.3 双层聚合）；子行/扁平行 = `conversation.unread`
   * 本身。打开子会话标已读后 `conversation.unread` 归零 → 祖先徽标同步下降。
   */
  readonly unread: number
  readonly children: readonly ChildRow[]
  readonly lastActivity: number
}

const SHOUT_KEY = "shout"
/**
 * 会话活动时间：末条消息时间；**无消息的会话回落到会话创建时间**——
 * 否则新建的空会话（`createGroup` 不写消息）活动恒为 0，会被倒序排到列表末尾，
 * 违背「新会话出现在列表顶部」的 DoD（Plan 3 T7 fix）。shout 恒单独置顶，不走此值。
 */
function activityOf(conversation: ConversationSummary | null): number {
  if (conversation === null) return 0
  return conversation.lastMessage?.createdAt ?? conversation.createdAt
}
/** 最近活动倒序；同值以 id 字典序定序（稳定）。 */
function byRecency<T extends { readonly id: string; readonly lastActivity: number }>(
  a: T,
  b: T,
): number {
  const delta = b.lastActivity - a.lastActivity
  if (delta !== 0) return delta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
interface RootBucket {
  readonly node: RosterNode
  /** 归属该根的**自有会话**（owner 即根本身）；>1 条时按约定选 header，其余降级为子行。 */
  readonly own: ConversationSummary[]
  readonly children: ChildRow[]
}

function childRow(conversation: ConversationSummary, node: RosterNode): ChildRow {
  return { conversation, node, retired: node.status === "retired" }
}

/**
 * header 归属约定：human↔root 的自有 DM 优先（无则取最近活动者，同值 id 稳定）。
 * 其余自有会话**降级为子行**，保证同一根的多条会话零丢行。
 */
function selectHeader(
  own: readonly ConversationSummary[],
  index: RosterIndex,
): ConversationSummary | null {
  const human = own.find((conversation) => isHumanDm(conversation.key, index))
  if (human !== undefined) return human
  return own.reduce<ConversationSummary | null>((best, conversation) => {
    if (best === null) return conversation
    const delta = activityOf(conversation) - activityOf(best)
    if (delta > 0) return conversation
    return delta === 0 && conversation.id < best.id ? conversation : best
  }, null)
}
function flatRow(
  kind: "shout" | "group" | "logical",
  conversation: ConversationSummary,
  node: RosterNode | undefined,
): FoldedRow {
  return {
    kind,
    id: conversation.id,
    conversation,
    node,
    unread: conversation.unread,
    children: [],
    lastActivity: activityOf(conversation),
  }
}

/**
 * 折叠会话列表为顶层行数组（纯函数）。
 * 根容器行徽标取 `aggregateUnread`（human 观察者全子树口径）；子行/扁平行取自身 `unread`。
 */
export function foldConversations(
  conversations: readonly ConversationSummary[],
  roster: readonly RosterNode[],
): readonly FoldedRow[] {
  const index = buildRosterIndex(roster)
  const unreadByOwner = aggregateUnread(conversations, roster)
  const shout: FoldedRow[] = []
  const flat: FoldedRow[] = []
  const buckets = new Map<string, RootBucket>()

  for (const conversation of conversations) {
    if (conversation.kind === "group") {
      const kind = conversation.key === SHOUT_KEY ? "shout" : "group"
      const row = flatRow(kind, conversation, undefined)
      if (kind === "shout") shout.push(row)
      else flat.push(row)
      continue
    }
    const owner = resolveOwner(conversation.key, index)
    if (owner === undefined) continue
    // 分组容器不是聊天实体：与容器之间的会话不出现在聊天栏（仍保留在 roster 供通讯录分组）。
    if (hasContainerParticipant(conversation.key, index)) continue
    if (owner.logical) {
      flat.push(flatRow("logical", conversation, owner.node))
      continue
    }
    const rootId = owner.rootId
    const bucket =
      buckets.get(rootId) ?? { node: index.roots.get(rootId) ?? owner.node, own: [], children: [] }
    if (rootId === owner.node.id) bucket.own.push(conversation)
    else bucket.children.push(childRow(conversation, owner.node))
    buckets.set(rootId, bucket)
  }

  const containerRows: FoldedRow[] = []
  for (const [rootId, bucket] of buckets) {
    const header = selectHeader(bucket.own, index)
    const demoted = bucket.own
      .filter((conversation) => conversation !== header)
      .map((conversation) => childRow(conversation, bucket.node))
    const children = [...bucket.children, ...demoted].sort((a, b) =>
      byRecency(
        { id: a.conversation.id, lastActivity: activityOf(a.conversation) },
        { id: b.conversation.id, lastActivity: activityOf(b.conversation) },
      ),
    )
    const lastActivity = Math.max(
      activityOf(header),
      ...children.map((child) => activityOf(child.conversation)),
      0,
    )
    containerRows.push({
      kind: "root",
      id: rootId,
      conversation: header,
      node: bucket.node,
      unread: unreadByOwner.get(rootId) ?? 0,
      children,
      lastActivity,
    })
  }

  return [...shout, ...[...flat, ...containerRows].sort(byRecency)]
}

// ── 展开态：手风琴 + localStorage（键前缀 `agentchat:`） ─────────────
// 纯原语抽到 `accordion.ts`（Plan 3 T6：会话列表与组织树共用同一折叠模式）；
// 以下为会话列表专属的键绑定 + 薄封装，导出名与行为保持不变。

export const EXPANDED_ROOTS_KEY = "agentchat:expandedRoots"

/** 读取展开的根 id。 */
export function loadExpandedRoots(storage: StorageLike | null): readonly string[] {
  return loadExpanded(storage, EXPANDED_ROOTS_KEY)
}

/** 写入展开的根 id。 */
export function saveExpandedRoots(storage: StorageLike | null, roots: readonly string[]): void {
  saveExpanded(storage, EXPANDED_ROOTS_KEY, roots)
}

/** 手风琴：展开新根只保留它；再点已展开的根则收起。 */
export function toggleExpandedRoot(roots: readonly string[], rootId: string): readonly string[] {
  return toggleExpanded(roots, rootId)
}
