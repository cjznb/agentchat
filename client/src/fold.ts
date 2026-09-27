/**
 * 会话列表折叠纯函数（spec §11.3；Plan 3 T4）。输入 `(conversations, unreadByRoot, roster)`
 * → 顶层行数组：① 喊话置顶；② 群聊/逻辑节点私聊顶层；③ runtime 根私聊=折叠容器（同根子树
 * 全部子私聊嵌套其内）；④ human 节点与 human 会话完全过滤；⑤ 其余按最后消息时间倒序。
 * 归属：DM `key`=`dm:<idA>_<idB>`（字典序），取非 human 参与方最深者（同级 id 最小）；
 * 展开态走手风琴，持久化键前缀 `agentchat:`，坏 JSON 容错。
 */
import type { ConversationSummary, RosterNode } from "../../shared/contracts"
import { loadExpanded, saveExpanded, toggleExpanded, type StorageLike } from "./accordion"

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
   * 容器根 = `unreadByRoot[rootId]`（**root agent 侧**：根自身+后代聚合，服务端 `unreadFor` 口径）；
   * 其余行 = `conversation.unread`（**human 侧**）。两读者不同：`POST /read` 只推进 human 位点，
   * 故根聚合**不随 human 阅读减少/清零**——纯函数恒等于入参，不做 human 侧扣减。
   */
  readonly unread: number
  readonly children: readonly ChildRow[]
  readonly lastActivity: number
}
interface NodeInfo {
  readonly node: RosterNode
  readonly rootId: string
  readonly depth: number
  readonly human: boolean
  readonly logical: boolean
}

interface RosterIndex {
  readonly nodes: ReadonlyMap<string, NodeInfo>
  readonly roots: ReadonlyMap<string, RosterNode>
}

function buildIndex(roster: readonly RosterNode[]): RosterIndex {
  const nodes = new Map<string, NodeInfo>()
  const roots = new Map<string, RosterNode>()
  const walk = (node: RosterNode, rootId: string, depth: number): void => {
    nodes.set(node.id, {
      node,
      rootId,
      depth,
      human: node.vendor === "human",
      logical: node.kind === "logical",
    })
    for (const child of node.children) walk(child, rootId, depth + 1)
  }
  for (const root of roster) {
    roots.set(root.id, root)
    walk(root, root.id, 0)
  }
  return { nodes, roots }
}

/**
 * DM `key`（`dm:<idA>_<idB>`，成员字典序）→ 参与方 id；非 DM 或**段数≠2** 返回空
 * （段数校验：未来 id 含 `_` 时宁可判为不可归属，也不静默错拆丢行）。
 */
function dmParticipants(key: string): readonly string[] {
  if (!key.startsWith("dm:")) return []
  const parts = key.slice(3).split("_")
  return parts.length === 2 && parts.every((id) => id !== "") ? parts : []
}
const SHOUT_KEY = "shout"
function activityOf(conversation: ConversationSummary | null): number {
  return conversation?.lastMessage?.createdAt ?? 0
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
/** DM 归属 agent：非 human 参与方中最深者（同级取 id 字典序最小）。 */
function resolveOwner(key: string, index: RosterIndex): NodeInfo | undefined {
  let best: NodeInfo | undefined
  for (const id of dmParticipants(key)) {
    const info = index.nodes.get(id)
    if (info === undefined || info.human) continue
    if (best === undefined || info.depth > best.depth) best = info
    else if (info.depth === best.depth && id < best.node.id) best = info
  }
  return best
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
/** 该 DM 是否含 human 参与方（用于 header 优先 human↔root 约定）。 */
function isHumanDm(key: string, index: RosterIndex): boolean {
  return dmParticipants(key).some((id) => index.nodes.get(id)?.human === true)
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

/** 折叠会话列表为顶层行数组（纯函数，便于单测断言）。 */
export function foldConversations(
  conversations: readonly ConversationSummary[],
  unreadByRoot: Readonly<Record<string, number>>,
  roster: readonly RosterNode[],
): readonly FoldedRow[] {
  const index = buildIndex(roster)
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
      unread: unreadByRoot[rootId] ?? 0,
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
