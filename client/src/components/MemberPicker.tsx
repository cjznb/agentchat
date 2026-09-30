/**
 * 通讯录多选成员选择器（spec §11.4「群创建/拉人：通讯录多选（含子 agent 与逻辑节点）」；Plan 3 T7）。
 *
 * 自绘复选框列表（不引组件库）：复用 `treeFold.foldTree`（默认折叠、human 过滤、逻辑节点图标、
 * 退役标记），带手风琴展开（独立持久化键，不与会话列表/组织树展开态串扰）。
 * human 由 `foldTree` 完全过滤 → 天然不可选；退役节点灰显且 checkbox 禁用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadExpanded, saveExpanded, toggleIndependent, type StorageLike } from "../accordion"
import { vendorBadge } from "../chat"
import { useStore } from "../store"
import { foldTree, roleTone, statusGlyph, statusLabel, type TreeRow } from "../treeFold"

const PICKER_TREE_KEY = "agentchat:expandedPicker"

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式禁用存储：不持久化展开态
  }
}

export interface MemberPickerProps {
  readonly selected: readonly string[]
  readonly onToggle: (nodeId: string) => void
}

function RoleTag({ tag }: { readonly tag: string | null }) {
  const tone = roleTone(tag)
  if (tone === "none") return null
  return (
    <span className="role-tag" data-tone={tone}>
      {tag}
    </span>
  )
}

function PickerRow({
  row,
  expandedIds,
  selected,
  onToggle,
  onExpand,
}: {
  readonly row: TreeRow
  readonly expandedIds: readonly string[]
  readonly selected: readonly string[]
  readonly onToggle: (nodeId: string) => void
  readonly onExpand: (nodeId: string) => void
}) {
  const { node, logical, retired, children } = row
  const expanded = expandedIds.includes(node.id)
  const checked = selected.includes(node.id)
  const expandable = children.length > 0 && !retired
  return (
    <li className="picker-row" data-testid="member-row" data-node-id={node.id} data-retired={retired}>
      <div className="picker-head" data-expanded={expanded} data-selected={checked}>
        {expandable ? (
          <button
            className="picker-toggle"
            data-testid="member-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${node.name}`}
            onClick={() => onExpand(node.id)}
            type="button"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="picker-toggle is-placeholder" aria-hidden="true" />
        )}
        <label className="picker-label">
          <input
            className="picker-check"
            data-testid="member-check"
            type="checkbox"
            checked={checked}
            disabled={retired}
            onChange={() => onToggle(node.id)}
          />
          <span
            className={logical ? "picker-icon is-logical" : "picker-icon"}
            data-vendor={node.vendor}
            aria-hidden="true"
          >
            {logical ? "◆" : vendorBadge(node.vendor)}
          </span>
          <span className="picker-name">{node.name}</span>
          <span className="picker-meta">
            <i
              className="node-dot"
              role="img"
              aria-label={statusLabel(node.status)}
              title={statusLabel(node.status)}
            >
              {statusGlyph(node.status)}
            </i>
            <span className="vendor-badge">{node.vendor}</span>
            <RoleTag tag={node.role_tag} />
          </span>
        </label>
      </div>
      {expanded && children.length > 0 ? (
        <ul className="picker-children">
          {children.map((child) => (
            <PickerRow
              key={child.node.id}
              row={child}
              expandedIds={expandedIds}
              selected={selected}
              onToggle={onToggle}
              onExpand={onExpand}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function MemberPicker({ selected, onToggle }: MemberPickerProps) {
  const { state } = useStore()
  const [expanded, setExpanded] = useState<readonly string[]>(() =>
    loadExpanded(safeStorage(), PICKER_TREE_KEY),
  )
  const rows = useMemo(() => foldTree(state.roster), [state.roster])

  // 展开态持久化移入 effect（F6）：updater 保持纯函数。
  const expand = useCallback((nodeId: string) => {
    setExpanded((previous) => toggleIndependent(previous, nodeId))
  }, [])

  // 值未变不重复持久化（StrictMode 双挂载同值幂等）。
  const persistedRef = useRef("")
  useEffect(() => {
    const serialized = JSON.stringify(expanded)
    if (persistedRef.current === serialized) return
    persistedRef.current = serialized
    saveExpanded(safeStorage(), PICKER_TREE_KEY, expanded)
  }, [expanded])

  if (rows.length === 0) {
    return (
      <p className="picker-empty" data-testid="member-picker-empty">
        等待 Agent 加入后可创建群聊。
      </p>
    )
  }

  return (
    <ul className="member-picker" data-testid="member-picker">
      {rows.map((row) => (
        <PickerRow
          key={row.node.id}
          row={row}
          expandedIds={expanded}
          selected={selected}
          onToggle={onToggle}
          onExpand={expand}
        />
      ))}
    </ul>
  )
}
