/**
 * 组织树纯函数（spec §11.2；Plan 3 T6）—— roster → 分组树行（在线优先）。
 *
 * 规则：
 * - 第一层仅根主 agent（+ 逻辑节点）；human 节点完全过滤（树与资料卡可达集一致）
 * - **排序**：同级（顶层根之间、各层子节点之间）按状态在线优先：`online`/`busy`（视为在线）
 *   → `offline` → `retired`；同级内稳定排序（保持 roster 原有相对顺序）
 * - 摘要 `N子·M忙`（直接可见子级数量 + busy 数，退役子级计入数量不计 busy）
 * - 行徽标 = **human 观察者口径的全子树聚合未读**（`unread.ts` `aggregateUnread`）——
 *   即「自身 + 全部后代」，故折叠父行天然显示其子树未读合计（非独立第二口径）
 *
 * UI 为**分组 + 默认折叠（手风琴）**：顶层只列主 agent，子节点默认收起、点父行展开；
 * 归属由缩进表达（`OrgTree` 嵌套 `org-children`），不再有行内 `↳` 标注。
 */
import type { AgentStatus, RosterNode } from "../../shared/contracts"
import { loadExpanded, saveExpanded, toggleExpanded, type StorageLike } from "./accordion"

export type { StorageLike }

export const EXPANDED_TREE_KEY = "agentchat:expandedTree"

/** human 节点判定（`vendor === "human"`；与 `fold.ts`/`chat.ts` 同规则）。 */
export function isHuman(node: RosterNode): boolean {
  return node.vendor === "human"
}

/** 可见直接子节点（human 过滤）。 */
export function visibleChildren(node: RosterNode): readonly RosterNode[] {
  return node.children.filter((child) => !isHuman(child))
}

/**
 * 状态排序权重——**在线优先**：`online`/`busy` 视为在线（并列 0）→ `offline`(1) → `retired`(2)。
 * 同权重由 `Array#sort` 的稳定性保持 roster 原有相对顺序（稳定排序）。
 */
const STATUS_ORDER = {
  online: 0,
  busy: 0,
  offline: 1,
  retired: 2,
} as const satisfies Record<AgentStatus, number>

/** 状态排序权重（数值越小越靠前）；在线与忙碌并列最优。 */
export function statusRank(status: AgentStatus): number {
  return STATUS_ORDER[status]
}

/** 稳定在线优先排序（不改原数组；同权重保持原顺序）。 */
function sortByStatus(nodes: readonly RosterNode[]): readonly RosterNode[] {
  return [...nodes].sort((a, b) => statusRank(a.status) - statusRank(b.status))
}

/** 折叠行摘要（`N子·M忙`）。 */
export interface TreeSummary {
  readonly count: number
  readonly busy: number
  readonly text: string
}

/** 摘要：直接可见子级数量与其中 busy 数（退役子级仍计入数量、不入 busy）。 */
export function summarize(node: RosterNode): TreeSummary {
  const children = visibleChildren(node)
  const busy = children.filter((child) => child.status === "busy").length
  return { count: children.length, busy, text: `${children.length}子·${busy}忙` }
}

/** 组织树行（node + 派生展示字段 + 已排序的可见子行，便于渲染与单测断言）。 */
export interface TreeRow {
  readonly node: RosterNode
  readonly logical: boolean
  readonly retired: boolean
  readonly summary: TreeSummary
  readonly unread: number
  readonly children: readonly TreeRow[]
}

function toRow(node: RosterNode, unread: ReadonlyMap<string, number>): TreeRow {
  return {
    node,
    logical: node.kind === "logical",
    retired: node.status === "retired",
    summary: summarize(node),
    unread: unread.get(node.id) ?? 0,
    children: sortByStatus(visibleChildren(node)).map((child) => toRow(child, unread)),
  }
}

/**
 * 折叠 roster 森林为组织树行（第一层：根主 agent + 逻辑节点；human 过滤；在线优先稳定排序）。
 * `unread` 为 human 观察者全子树聚合表（`aggregateUnread` 产出）；缺省空表 → 各行为 0。
 */
export function foldTree(
  roster: readonly RosterNode[],
  unread: ReadonlyMap<string, number> = new Map(),
): readonly TreeRow[] {
  return sortByStatus(roster.filter((node) => !isHuman(node))).map((node) => toRow(node, unread))
}

// ── 视觉纯映射：role 标签颜色 / 状态点（spec §11.2） ───────────────────

export type RoleTone = "executor" | "organizer" | "supervisor" | "other" | "none"

const ROLE_TONES: Readonly<Record<string, Exclude<RoleTone, "none" | "other">>> = {
  执行者: "executor",
  组织者: "organizer",
  监管者: "supervisor",
}

/** `role_tag` → 颜色 tone（三已知角色映射；空值与 `container` → `none`；未知值兜底 `other`）。 */
export function roleTone(tag: string | null): RoleTone {
  if (tag === null || tag.trim() === "") return "none"
  // 容器节点由专属「容器」徽标表达，不再渲染裸英文 `container` 角色标签（评审 Minor #1）。
  if (tag === "container") return "none"
  return ROLE_TONES[tag] ?? "other"
}

/**
 * 容器节点判定（`role_tag === "container"`）——**唯一谓词**，组件与拦截共用（评审 Minor #2）。
 * 容器展示「容器」徽标且不可作为私聊对象（`ContactCard` 隐藏按钮 + `App` 拦截 `openDm`）。
 */
export function isContainerNode(node: Pick<RosterNode, "role_tag">): boolean {
  return node.role_tag === "container"
}

const STATUS_GLYPHS = {
  online: "🟢",
  busy: "🟠",
  offline: "⚪",
  retired: "⚫",
} as const satisfies Record<AgentStatus, string>

/** 状态点字形（🟢在线/🟠忙碌/⚪离线/⚫退役）。 */
export function statusGlyph(status: AgentStatus): string {
  return STATUS_GLYPHS[status]
}

const STATUS_LABELS = {
  online: "在线",
  busy: "忙碌",
  offline: "离线",
  retired: "退役",
} as const satisfies Record<AgentStatus, string>

/** 状态中文标签（aria/title 用；busy 另附 `status_text`）。 */
export function statusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status]
}

// ── 展开态：手风琴 + localStorage（组织树专属键） ─────────────────────

export function loadExpandedTree(storage: StorageLike | null): readonly string[] {
  return loadExpanded(storage, EXPANDED_TREE_KEY)
}

export function saveExpandedTree(storage: StorageLike | null, ids: readonly string[]): void {
  saveExpanded(storage, EXPANDED_TREE_KEY, ids)
}

/** 手风琴：展开新节点只保留它；再点已展开的节点则收起。 */
export function toggleTreeRow(ids: readonly string[], nodeId: string): readonly string[] {
  return toggleExpanded(ids, nodeId)
}
