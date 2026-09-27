/**
 * roster 归属纯函数（Plan 3 终审 F1）——会话折叠（`fold.ts`）与未读聚合（`unread.ts`）
 * **共用同一 owner 归属规则**，避免两处口径漂移（spec §11.3）。
 *
 * 归属：DM `key`=`dm:<idA>_<idB>`（字典序），取非 human 参与方最深者（同级 id 最小）；
 * 非 DM / 段数≠2 → 不可归属（返回 undefined，宁可跳过也不静默错拆）。
 */
import type { RosterNode } from "../../shared/contracts"

/** roster 节点派生信息（根 / 深度 / human / 逻辑）。 */
export interface NodeInfo {
  readonly node: RosterNode
  readonly rootId: string
  readonly depth: number
  readonly human: boolean
  readonly logical: boolean
}

/** id → 节点信息 + 根表。 */
export interface RosterIndex {
  readonly nodes: ReadonlyMap<string, NodeInfo>
  readonly roots: ReadonlyMap<string, RosterNode>
}

/** 展开 roster 森林为 id → 节点信息索引（含根 id 与深度）。 */
export function buildRosterIndex(roster: readonly RosterNode[]): RosterIndex {
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
 * （未来 id 含 `_` 时宁可判为不可归属，也不静默错拆丢行）。
 */
export function dmParticipants(key: string): readonly string[] {
  if (!key.startsWith("dm:")) return []
  const parts = key.slice(3).split("_")
  return parts.length === 2 && parts.every((id) => id !== "") ? parts : []
}

/** DM 归属 agent：非 human 参与方中最深者（同级取 id 字典序最小）。 */
export function resolveOwner(key: string, index: RosterIndex): NodeInfo | undefined {
  let best: NodeInfo | undefined
  for (const id of dmParticipants(key)) {
    const info = index.nodes.get(id)
    if (info === undefined || info.human) continue
    if (best === undefined || info.depth > best.depth) best = info
    else if (info.depth === best.depth && id < best.node.id) best = info
  }
  return best
}

/** 该 DM 是否含 human 参与方（header 优先 human↔root 约定）。 */
export function isHumanDm(key: string, index: RosterIndex): boolean {
  return dmParticipants(key).some((id) => index.nodes.get(id)?.human === true)
}
