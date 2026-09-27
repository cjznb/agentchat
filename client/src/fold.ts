/**
 * 会话列表折叠纯函数（spec §11.3；Plan 3 T4）。
 *
 * 输入 `(conversations, unreadByRoot, roster)` → 顶层行数组：
 * ① 喊话（`key==='shout'`）置顶独立行；② 群聊 / 逻辑节点私聊为顶层行；
 * ③ runtime 根私聊为**折叠容器**（同根子树内全部子私聊嵌套其内）；
 * ④ human 节点与 human 会话完全过滤；⑤ 排序：喊话置顶 → 其余按最后消息时间倒序。
 * 展开态走**手风琴**（同开一条分支），持久化键前缀 `agentchat:`；坏 JSON 容错忽略。
 *
 * 归属规则：DM 的 `key` 为 `dm:<idA>_<idB>`（成员字典序）；取非 human 参与方中
 * **最深者**（同级取 id 字典序最小）作为归属 agent，其所在 runtime 根即容器。
 */
import type { ConversationSummary, RosterNode } from "../../shared/contracts"

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
  /** 容器根 = `unreadByRoot[rootId]`（根自身 + 嵌套子会话聚合）；其余 = `conversation.unread`。 */
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

/** DM `key`（`dm:<idA>_<idB>`，成员字典序）→ 参与方 id；非 DM 返回空。 */
function dmParticipants(key: string): readonly string[] {
  return key.startsWith("dm:") ? key.slice(3).split("_").filter((id) => id !== "") : []
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
  conversation: ConversationSummary | null
  readonly children: ChildRow[]
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
      buckets.get(rootId) ??
      { node: index.roots.get(rootId) ?? owner.node, conversation: null, children: [] }
    if (rootId === owner.node.id) bucket.conversation = conversation
    else bucket.children.push({ conversation, node: owner.node, retired: owner.node.status === "retired" })
    buckets.set(rootId, bucket)
  }

  const containerRows: FoldedRow[] = []
  for (const [rootId, bucket] of buckets) {
    const children = [...bucket.children].sort((a, b) =>
      byRecency(
        { id: a.conversation.id, lastActivity: activityOf(a.conversation) },
        { id: b.conversation.id, lastActivity: activityOf(b.conversation) },
      ),
    )
    const lastActivity = Math.max(
      activityOf(bucket.conversation),
      ...children.map((child) => activityOf(child.conversation)),
      0,
    )
    containerRows.push({
      kind: "root",
      id: rootId,
      conversation: bucket.conversation,
      node: bucket.node,
      unread: unreadByRoot[rootId] ?? 0,
      children,
      lastActivity,
    })
  }

  return [...shout, ...[...flat, ...containerRows].sort(byRecency)]
}

// ── 展开态：手风琴 + localStorage（键前缀 `agentchat:`） ─────────────

export const EXPANDED_ROOTS_KEY = "agentchat:expandedRoots"

/** 可注入的存储面（浏览器 `Storage` 与测试假实现皆满足）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 读取展开的根 id；坏 JSON / 非字符串数组 / 存储异常 → 空数组（容错）。 */
export function loadExpandedRoots(storage: StorageLike | null): readonly string[] {
  if (storage === null) return []
  try {
    const raw = storage.getItem(EXPANDED_ROOTS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as readonly unknown[]).filter((value): value is string => typeof value === "string")
  } catch {
    return [] // 坏 JSON：忽略持久化，回到默认收起
  }
}

/** 写入展开的根 id；配额/隐私模式异常吞掉（持久化失败不影响交互）。 */
export function saveExpandedRoots(storage: StorageLike | null, roots: readonly string[]): void {
  if (storage === null) return
  try {
    storage.setItem(EXPANDED_ROOTS_KEY, JSON.stringify(roots))
  } catch {
    /* 存储不可用：忽略 */
  }
}

/** 手风琴：展开新根只保留它；再点已展开的根则收起。 */
export function toggleExpandedRoot(roots: readonly string[], rootId: string): readonly string[] {
  return roots.includes(rootId) ? [] : [rootId]
}
