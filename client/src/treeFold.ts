/**
 * 组织树折叠纯函数（spec §11.2；Plan 3 T6）——与会话列表（`fold.ts`）**复用同一折叠模式**：
 * 默认收起、手风琴（单开）、`▸` 原地展开、摘要 + 聚合徽标。
 *
 * 折叠规则：
 * - 第一层仅根主 agent（+ 逻辑节点）；子级默认折叠在根行下
 * - human 节点完全过滤（树与资料卡可达集一致，spec §11.2「human 不出现在树」）
 * - 折叠行摘要 `N子·M忙`（直接可见子级数量 + busy 数）
 * - 行徽标 = **human 观察者口径的全子树聚合未读**（`unread.ts` `aggregateUnread`，spec §11.2
 *   「聚合未读徽标 = 全树未读，展开后子行各显各的」）——由调用方传入（缺省空表 = 无徽标）。
 *   与 `fold.ts` 会话根行**同口径**（Plan 3 终审 F1 统一，取代旧的 roster agent 侧 `unread`）。
 *
 * 展开态持久化复用 `accordion.ts` 原语，键独立（`agentchat:expandedTree`）。
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

/** 组织树行（node + 派生展示字段 + 可见子行，便于渲染与单测断言）。 */
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
    children: visibleChildren(node).map((child) => toRow(child, unread)),
  }
}

/**
 * 折叠 roster 森林为组织树行（第一层：根主 agent + 逻辑节点；human 过滤）。
 * `unread` 为 human 观察者全子树聚合表（`aggregateUnread` 产出）；缺省空表 → 各行为 0。
 */
export function foldTree(
  roster: readonly RosterNode[],
  unread: ReadonlyMap<string, number> = new Map(),
): readonly TreeRow[] {
  return roster.filter((node) => !isHuman(node)).map((node) => toRow(node, unread))
}

// ── 视觉纯映射：role 标签颜色 / 状态点（spec §11.2） ───────────────────

export type RoleTone = "executor" | "organizer" | "supervisor" | "other" | "none"

const ROLE_TONES: Readonly<Record<string, Exclude<RoleTone, "none" | "other">>> = {
  执行者: "executor",
  组织者: "organizer",
  监管者: "supervisor",
}

/** `role_tag` → 颜色 tone（三已知角色映射；未知值兜底 `other`；空值 `none`）。 */
export function roleTone(tag: string | null): RoleTone {
  if (tag === null || tag.trim() === "") return "none"
  return ROLE_TONES[tag] ?? "other"
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
