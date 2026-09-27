/**
 * 群成员树状归属纯函数（spec §11.4「群创建/拉人：通讯录多选或群资料页 +」；Plan 3 T7）。
 *
 * - `groupMembers(成员 id[], roster)`：把成员按**所属根**分组（成员 → 根），供群资料页树状展示；
 *   human 与未知 id 过滤（与组织树 / 会话列表一致：human 不出现在成员视图）
 * - `addableMembers(roster, 已排除 id[])`：可拉入的节点（复用 `treeFold` 折叠规则：过滤 human、
 *   标记退役；退役不可入群），供「+ 添加成员」下拉
 *
 * 层级归属沿用 `treeFold`/roster 的同一数据源，不复制折叠/徽标逻辑。
 */
import type { AgentKind, AgentStatus, RosterNode } from "../../shared/contracts"
import { foldTree, type TreeRow } from "./treeFold"

/** 成员展示视图（群资料页一行）。 */
export interface MemberView {
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly kind: AgentKind
  readonly status: AgentStatus
}

/** 同一根下的成员分组（根名 + 成员）。 */
export interface MemberGroup {
  readonly rootId: string
  readonly rootName: string
  readonly members: readonly MemberView[]
}

/** 可拉入节点（下拉选项）。 */
export interface MemberOption {
  readonly id: string
  readonly name: string
  readonly kind: AgentKind
}

interface Located {
  readonly node: RosterNode
  readonly rootId: string
  readonly rootName: string
}

function indexRoster(roster: readonly RosterNode[]): ReadonlyMap<string, Located> {
  const index = new Map<string, Located>()
  const walk = (node: RosterNode, rootId: string, rootName: string): void => {
    index.set(node.id, { node, rootId, rootName })
    for (const child of node.children) walk(child, rootId, rootName)
  }
  for (const root of roster) walk(root, root.id, root.name)
  return index
}

/**
 * 成员 id → 按所属根分组的展示视图（human / 未知 id 跳过）。
 * 根分组按成员出现次序稳定输出；根名取根节点名。
 */
export function groupMembers(
  memberIds: readonly string[],
  roster: readonly RosterNode[],
): readonly MemberGroup[] {
  const index = indexRoster(roster)
  const groups: { rootId: string; rootName: string; members: MemberView[] }[] = []
  for (const id of memberIds) {
    const located = index.get(id)
    if (located === undefined || located.node.vendor === "human") continue
    const view: MemberView = {
      id,
      name: located.node.name,
      vendor: located.node.vendor,
      kind: located.node.kind,
      status: located.node.status,
    }
    const existing = groups.find((group) => group.rootId === located.rootId)
    if (existing === undefined) {
      groups.push({ rootId: located.rootId, rootName: located.rootName, members: [view] })
    } else {
      existing.members.push(view)
    }
  }
  return groups
}

function collect(rows: readonly TreeRow[], out: MemberOption[]): void {
  for (const row of rows) {
    if (!row.retired) out.push({ id: row.node.id, name: row.node.name, kind: row.node.kind })
    collect(row.children, out)
  }
}

/** 可拉入的节点（foldTree 已过滤 human；退役排除；再排除已选 / 已在群 id）。 */
export function addableMembers(
  roster: readonly RosterNode[],
  excluded: readonly string[],
): readonly MemberOption[] {
  const out: MemberOption[] = []
  collect(foldTree(roster), out)
  return out.filter((option) => !excluded.includes(option.id))
}
