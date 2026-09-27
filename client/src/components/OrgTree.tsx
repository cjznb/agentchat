/**
 * 通讯录 · 组织树（spec §11.2；Plan 3 T6）——折叠计算全在 `treeFold.ts` 纯函数；
 * 本组件只渲染 + 管理展开态（手风琴，持久化 `agentchat:expandedTree`）。
 *
 * - 默认折叠：第一层仅根主 agent（+ 逻辑节点），子级折叠在根行下，`▸` 原地展开
 * - 折叠行摘要 `N子·M忙` + 聚合未读徽标（随 WS `agent` 事件重拉 roster 实时刷新）
 * - 节点视觉：状态点/厂商徽标/role 彩色标签；逻辑节点特殊图标
 * - 退役节点灰显、留原位、不可点（不可开聊/开卡）
 * - human 节点经 `foldTree` 完全过滤
 */
import { useCallback, useMemo, useState } from "react"
import type { RosterNode } from "../../../shared/contracts"
import { vendorBadge } from "../chat"
import { useStore } from "../store"
import {
  foldTree,
  loadExpandedTree,
  roleTone,
  saveExpandedTree,
  statusGlyph,
  statusLabel,
  toggleTreeRow,
  type StorageLike,
  type TreeRow,
} from "../treeFold"

export interface OrgTreeProps {
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
}

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式禁用存储：不持久化展开态
  }
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

function NodeRow({
  row,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
}: {
  readonly row: TreeRow
  readonly expandedIds: readonly string[]
  readonly selectedId: string | null
  readonly onToggle: (nodeId: string) => void
  readonly onSelect: (nodeId: string) => void
}) {
  const { node, summary, children, retired, logical } = row
  const expanded = expandedIds.includes(node.id)
  const expandable = children.length > 0 && !retired
  return (
    <li className="org-row" data-testid="org-row" data-node-id={node.id}>
      <div className="org-head" data-expanded={expanded} data-retired={retired}>
        {expandable ? (
          <button
            className="org-toggle"
            data-testid="org-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${node.name}`}
            onClick={() => onToggle(node.id)}
            type="button"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="org-toggle is-placeholder" aria-hidden="true" />
        )}
        <button
          className="org-node"
          data-testid="org-node"
          data-node-id={node.id}
          data-kind={node.kind}
          data-status={node.status}
          data-retired={retired}
          data-selected={node.id === selectedId}
          disabled={retired}
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
      </div>
      {expanded && children.length > 0 ? (
        <ul className="org-children">
          {children.map((child) => (
            <NodeRow
              key={child.node.id}
              row={child}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function OrgTree({ selectedId, onSelect }: OrgTreeProps) {
  const { state } = useStore()
  const [expanded, setExpanded] = useState<readonly string[]>(() => loadExpandedTree(safeStorage()))
  const rows = useMemo(() => foldTree(state.roster), [state.roster])

  const toggle = useCallback((nodeId: string) => {
    setExpanded((previous) => {
      const next = toggleTreeRow(previous, nodeId)
      saveExpandedTree(safeStorage(), next)
      return next
    })
  }, [])

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
        <NodeRow
          key={row.node.id}
          row={row}
          expandedIds={expanded}
          selectedId={selectedId}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}
