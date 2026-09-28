/**
 * 通讯录 · 组织树（spec §11.2；Plan 3 T6）——**单层扁平列表**。
 *
 * - 所有可见节点（human 过滤后）在同一视觉层级逐行排列，DFS 顺序
 * - 父节点的行加淡色 `↳ <父节点名>` 来源标注（同一视觉层级靠相邻 + 标注判归属）
 * - 容器节点（`role_tag === "container"`）显示「容器」徽标；**不可 DM**
 *   （`ContactCard`/`App.tsx` 双层拦截 `openDm`，本组件仅作展示）
 * - 保留：状态点（online/busy/offline/retired）、未读徽标、`treeFold` 摘要
 *   （`N子·M忙`）、点击选中回调、退役节点灰显 + 仍可点开资料卡
 * - human 节点经 `visibleChildren` 语义完全过滤（不变）
 */
import { useMemo } from "react"
import type { RosterNode } from "../../../shared/contracts"
import { vendorBadge } from "../chat"
import { useStore } from "../store"
import { aggregateUnread } from "../unread"
import {
  flattenTree,
  foldTree,
  roleTone,
  statusGlyph,
  statusLabel,
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

function FlatNodeRow({
  row,
  selectedId,
  onSelect,
}: {
  readonly row: TreeRow
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
}) {
  const { node, summary, retired, logical } = row
  const isContainer = node.role_tag === "container"
  return (
    <li className="org-row" data-testid="org-row" data-node-id={node.id}>
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
          {row.parentName !== null ? (
            <span className="org-source" data-testid="org-source" aria-hidden="true">
              ↳ {row.parentName}
            </span>
          ) : null}
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
    </li>
  )
}

export function OrgTree({ selectedId, onSelect }: OrgTreeProps) {
  const { state } = useStore()
  const rows = useMemo(
    () => flattenTree(foldTree(state.roster, aggregateUnread(state.conversations, state.roster))),
    [state.roster, state.conversations],
  )

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
        <FlatNodeRow key={row.node.id} row={row} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </ul>
  )
}
