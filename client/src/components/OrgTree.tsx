/**
 * 通讯录 · 组织树（spec §11.2）——**分组 + 默认折叠（手风琴）**。
 *
 * - 顶层只列主 agent（roster 根节点）；human 经 `foldTree` 完全过滤（不变）
 * - 子节点默认收起；点父行展开/收起，**手风琴一次只开一个**（复用 `accordion.ts`：
 *   `loadExpandedTree`/`saveExpandedTree`/`toggleTreeRow`，键 `agentchat:expandedTree`）
 * - 子行**缩进一档**表达层级（嵌套 `org-children`），不再有行内 `↳` 来源标注
 * - **在线优先排序**由 `foldTree`（`treeFold.ts`）完成（顶层与各层子节点同级稳定排序）
 * - 容器节点（`role_tag === "container"`）显示「容器」徽标；**不可 DM**
 *   （`ContactCard`/`App.tsx` 双层拦截 `openDm`，本组件仅作展示）
 * - 折叠父行徽标 = 全子树聚合未读（`aggregateUnread` 口径：自身 + 全部后代）
 * - 展开/收起为原生 `<button aria-expanded>`（键盘可达）；容器行/退役行仍可点开资料卡
 *
 * `OrgTreeList` 为**纯展示**子组件（无 store 依赖），供 jsdom 组件测试直接渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RosterNode } from "../../../shared/contracts"
import { browserStorage } from "../accordion"
import { vendorBadge } from "../chat"
import { useStore } from "../store"
import { aggregateUnread } from "../unread"
import {
  foldTree,
  isContainerNode,
  loadExpandedTree,
  roleTone,
  saveExpandedTree,
  statusGlyph,
  statusLabel,
  toggleTreeRow,
  type TreeRow,
} from "../treeFold"

export interface OrgTreeProps {
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
}

function NodeStatus({ node }: { readonly node: RosterNode }) {
  return (
    <span className="node-status" data-status={node.status}>
      <i
        className="node-dot"
        role="img"
        aria-label={statusLabel(node.status)}
        title={statusLabel(node.status)}
      >
        {statusGlyph(node.status)}
      </i>
      {node.status === "busy" && node.status_text !== null ? (
        <span className="node-status-text" data-testid="status-text">
          {node.status_text}
        </span>
      ) : null}
    </span>
  )
}

function RoleTag({ tag }: { readonly tag: string | null }) {
  const tone = roleTone(tag)
  if (tone === "none") return null
  return (
    <span className="role-tag" data-tone={tone} data-testid="role-tag">
      {tag}
    </span>
  )
}

function Badge({ count }: { readonly count: number }) {
  if (count <= 0) return null
  return (
    <em className="unread-badge" data-testid="unread-badge" aria-label={`${count} 条未读`}>
      {count}
    </em>
  )
}

/** 节点可点行（点开资料卡）；容器行显示「容器」徽标。 */
function NodeButton({
  row,
  selectedId,
  onSelect,
}: {
  readonly row: TreeRow
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
}) {
  const { node, summary, retired, logical } = row
  const isContainer = isContainerNode(node)
  return (
    <button
      className="org-node"
      data-testid="org-node"
      data-node-id={node.id}
      data-kind={node.kind}
      data-status={node.status}
      data-retired={retired}
      data-selected={node.id === selectedId}
      data-container={isContainer || undefined}
      aria-label={`查看 ${node.name} 资料卡`}
      onClick={() => onSelect(node.id)}
      type="button"
    >
      <span
        className={`node-icon${logical ? " is-logical" : ""}`}
        data-vendor={node.vendor}
        aria-hidden="true"
      >
        {logical ? "◆" : vendorBadge(node.vendor)}
      </span>
      <span className="node-body">
        <span className="node-name">{node.name}</span>
        <span className="node-meta">
          <NodeStatus node={node} />
          <span className="vendor-badge">{node.vendor}</span>
          {isContainer ? (
            <span
              className="container-badge"
              data-testid="container-badge"
              title="分组容器，不是聊天对象"
            >
              容器
            </span>
          ) : null}
          <RoleTag tag={node.role_tag} />
        </span>
      </span>
      <span className="org-meta">
        {summary.count > 0 ? (
          <span className="fold-summary" data-testid="org-summary">
            {summary.text}
          </span>
        ) : null}
        <Badge count={row.unread} />
      </span>
    </button>
  )
}

function OrgRow({
  row,
  depth,
  expandedIds,
  selectedId,
  onSelect,
  onToggle,
}: {
  readonly row: TreeRow
  readonly depth: number
  readonly expandedIds: readonly string[]
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
  readonly onToggle: (nodeId: string) => void
}) {
  // 手风琴只在顶层生效：非顶层行随其根展开而整体铺开（子 agent 收在主 agent 内）。
  const expandable = depth === 0 && row.children.length > 0
  const expanded = expandedIds.includes(row.node.id)
  const showChildren = row.children.length > 0 && (depth > 0 || expanded)
  return (
    <li
      className="org-row"
      data-testid="org-row"
      data-node-id={row.node.id}
      data-depth={depth}
      data-expanded={expandable ? expanded : undefined}
    >
      <div className="org-head" data-expanded={expandable ? expanded : undefined}>
        {expandable ? (
          <button
            className="org-toggle"
            data-testid="org-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${row.node.name} 的子节点`}
            onClick={() => onToggle(row.node.id)}
            type="button"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="org-toggle is-placeholder" aria-hidden="true" />
        )}
        <NodeButton row={row} selectedId={selectedId} onSelect={onSelect} />
      </div>
      {showChildren ? (
        <ul className="org-children" data-testid="org-children">
          {row.children.map((child) => (
            <OrgRow
              key={child.node.id}
              row={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface OrgTreeListProps {
  readonly rows: readonly TreeRow[]
  readonly expandedIds: readonly string[]
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
  readonly onToggle: (nodeId: string) => void
}

/** 纯展示组织树（无 store 依赖；jsdom 组件测试直接渲染）。 */
export function OrgTreeList({
  rows,
  expandedIds,
  selectedId,
  onSelect,
  onToggle,
}: OrgTreeListProps) {
  if (rows.length === 0) {
    return (
      <div className="list-empty" data-testid="org-tree-empty">
        <span aria-hidden="true">—</span>
        <p>等待 Agent 加入</p>
        <small>节点注册后自动出现在这里</small>
      </div>
    )
  }
  return (
    <ul className="org-tree" data-testid="org-tree">
      {rows.map((row) => (
        <OrgRow
          key={row.node.id}
          row={row}
          depth={0}
          expandedIds={expandedIds}
          selectedId={selectedId}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </ul>
  )
}

export function OrgTree({ selectedId, onSelect }: OrgTreeProps) {
  const { state } = useStore()
  const [expanded, setExpanded] = useState<readonly string[]>(() =>
    loadExpandedTree(browserStorage()),
  )
  const rows = useMemo(
    () => foldTree(state.roster, aggregateUnread(state.conversations, state.roster)),
    [state.roster, state.conversations],
  )

  // 展开态持久化移入 effect：updater 保持纯函数，StrictMode 双挂载幂等。
  const toggle = useCallback((nodeId: string) => {
    setExpanded((previous) => toggleTreeRow(previous, nodeId))
  }, [])

  const persistedRef = useRef("")
  useEffect(() => {
    const serialized = JSON.stringify(expanded)
    if (persistedRef.current === serialized) return
    persistedRef.current = serialized
    saveExpandedTree(browserStorage(), expanded)
  }, [expanded])

  return (
    <OrgTreeList
      rows={rows}
      expandedIds={expanded}
      selectedId={selectedId}
      onSelect={onSelect}
      onToggle={toggle}
    />
  )
}
