/**
 * 通讯录多选成员选择器（spec §11.4「群创建/拉人：通讯录多选（含子 agent 与逻辑节点）」；Plan 3 T7）。
 *
 * 自绘复选框列表（不引组件库）：复用 `treeFold.foldTree`（默认折叠、human 过滤、逻辑节点图标、
 * 退役标记），带手风琴展开（独立持久化键，不与会话列表/组织树展开态串扰）。
 * human 由 `foldTree` 完全过滤 → 天然不可选；退役节点灰显且 checkbox 禁用。
 * 分组容器（`role_tag === "container"`，P5）**保留在树里**（层级与可展开不变），
 * 但 checkbox 不可勾选，并显示「容器」徽标 + 说明文案。
 *
 * 修 2A「离线/历史会话」折叠栏：`partitionPickerRows` 纯函数把**全离线根子树**分拣进
 * 独立折叠栏（默认收起、独立持久化键 `agentchat:expandedPickerLegacy`）；主列表为空且
 * 折叠栏有行时自动展开（否则用户一个都看不到）；折叠栏为空则不渲染。
 *
 * UI-1 ①（可辨识与反馈）：列表顶部补**状态点图例**（绿/橙/白/黑圆点含义不必逐行 hover）；
 * vendor 胶囊只在**多厂商**列表里渲染（同厂商重复十几行是噪声，图标底色已表达厂商）；
 * 容器行的禁用态在 `styles.css` 里压暗 45% + 横杠勾选框 + 行尾「不可作为成员」hint。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadExpanded, saveExpanded, toggleIndependent, type StorageLike } from "../accordion"
import { vendorBadge } from "../chat"
import { useStore } from "../store"
import {
  foldTree,
  isContainerNode,
  partitionPickerRows,
  roleTone,
  statusGlyph,
  statusLabel,
  type TreeRow,
} from "../treeFold"

const PICKER_TREE_KEY = "agentchat:expandedPicker"
/** 折叠栏展开态持久化键（独立于 `PICKER_TREE_KEY`；哨兵 id 走 accordion 列表存取）。 */
const PICKER_LEGACY_KEY = "agentchat:expandedPickerLegacy"
const LEGACY_SENTINEL = "__picker_legacy__"

/** 状态点图例顺序（①-2）：与 `treeFold.statusGlyph/statusLabel` 同源，只固定展示顺序。 */
const STATUS_LEGEND = ["online", "busy", "offline", "retired"] as const

/** 行尾可见图例：把「绿/橙/白/黑圆点」的含义写明，免去逐行 hover 猜（①-2）。 */
function StatusLegend() {
  return (
    <p className="picker-legend" data-testid="picker-status-legend">
      <span className="picker-legend-title">状态</span>
      {STATUS_LEGEND.map((status) => (
        <span className="picker-legend-item" key={status} data-status={status}>
          <i
            className="node-dot"
            role="img"
            aria-label={statusLabel(status)}
            title={statusLabel(status)}
          >
            {statusGlyph(status)}
          </i>
          {statusLabel(status)}
        </span>
      ))}
    </p>
  )
}

/**
 * 列表内出现的厂商集合（①-3）：只有**多厂商**时才逐行渲染 vendor 胶囊 ——
 * 同一厂商重复十几行是纯噪声，而 `.picker-icon[data-vendor]` 的底色已表达厂商。
 */
function vendorsIn(rows: readonly TreeRow[]): ReadonlySet<string> {
  const vendors = new Set<string>()
  const walk = (row: TreeRow): void => {
    vendors.add(row.node.vendor)
    for (const child of row.children) walk(child)
  }
  for (const row of rows) walk(row)
  return vendors
}

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
  showVendor,
  onToggle,
  onExpand,
}: {
  readonly row: TreeRow
  readonly expandedIds: readonly string[]
  readonly selected: readonly string[]
  /** 多厂商列表才渲染 vendor 胶囊（①-3；单厂商时靠 `.picker-icon` 底色表达）。 */
  readonly showVendor: boolean
  readonly onToggle: (nodeId: string) => void
  readonly onExpand: (nodeId: string) => void
}) {
  const { node, logical, retired, children } = row
  const expanded = expandedIds.includes(node.id)
  const checked = selected.includes(node.id)
  // P5：分组容器是目录、不是聊天对象 —— 不可勾选（服务端亦 409 兜底）。
  // **保留层级与可展开**：容器行仍在树里、仍能展开看子节点，只是 checkbox 不可选。
  const container = isContainerNode(node)
  const blocked = retired || container
  const expandable = children.length > 0 && !retired
  return (
    <li
      className="picker-row"
      data-testid="member-row"
      data-node-id={node.id}
      data-retired={retired}
      data-container={container || undefined}
    >
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
            checked={checked && !blocked}
            disabled={blocked}
            aria-label={container ? `${node.name}（分组容器，不可作为成员）` : undefined}
            title={container ? "分组容器，不可作为成员" : undefined}
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
            {showVendor ? <span className="vendor-badge">{node.vendor}</span> : null}
            {container ? (
              <span
                className="container-badge"
                data-testid="container-badge"
                title="分组容器，不是聊天对象"
              >
                容器
              </span>
            ) : null}
            <RoleTag tag={node.role_tag} />
            {/* ①-1：行尾可见 hint —— 禁用理由不能只藏在 title 里（截图/触屏都要看得见）。 */}
            {container ? (
              <span className="picker-hint" data-testid="picker-container-hint">
                分组容器，不可作为成员
              </span>
            ) : null}
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
              showVendor={showVendor}
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
  const { main, legacy } = useMemo(() => partitionPickerRows(rows), [rows])
  // ①-3：整棵树（含折叠栏）只有一个厂商 → 逐行胶囊全是噪声，不渲染。
  const showVendor = useMemo(() => vendorsIn(rows).size > 1, [rows])
  // 折叠栏默认收起（持久化独立键）；主列表空且折叠栏有行 → 自动展开。
  const [legacyIds, setLegacyIds] = useState<readonly string[]>(() =>
    loadExpanded(safeStorage(), PICKER_LEGACY_KEY),
  )
  const legacyForced = main.length === 0 && legacy.length > 0
  const legacyOpen = legacyForced || legacyIds.includes(LEGACY_SENTINEL)

  // 展开态持久化移入 effect（F6）：updater 保持纯函数。
  const expand = useCallback((nodeId: string) => {
    setExpanded((previous) => toggleIndependent(previous, nodeId))
  }, [])

  const toggleLegacy = useCallback(() => {
    setLegacyIds((previous) => toggleIndependent(previous, LEGACY_SENTINEL))
  }, [])

  // 值未变不重复持久化（StrictMode 双挂载同值幂等）。
  const persistedRef = useRef("")
  useEffect(() => {
    const serialized = JSON.stringify(expanded)
    if (persistedRef.current === serialized) return
    persistedRef.current = serialized
    saveExpanded(safeStorage(), PICKER_TREE_KEY, expanded)
  }, [expanded])

  const legacyPersistedRef = useRef("")
  useEffect(() => {
    const serialized = JSON.stringify(legacyIds)
    if (legacyPersistedRef.current === serialized) return
    legacyPersistedRef.current = serialized
    saveExpanded(safeStorage(), PICKER_LEGACY_KEY, legacyIds)
  }, [legacyIds])

  if (rows.length === 0) {
    return (
      <p className="picker-empty" data-testid="member-picker-empty">
        等待 Agent 加入后可创建群聊。
      </p>
    )
  }

  return (
    <>
      <StatusLegend />
      <ul className="member-picker" data-testid="member-picker">
        {main.map((row) => (
          <PickerRow
            key={row.node.id}
            row={row}
            expandedIds={expanded}
            selected={selected}
            showVendor={showVendor}
            onToggle={onToggle}
            onExpand={expand}
          />
        ))}
      </ul>
      {legacy.length > 0 ? (
        <div className="picker-legacy" data-testid="picker-legacy">
          <button
            className="picker-legacy-toggle"
            data-testid="picker-legacy-toggle"
            type="button"
            aria-expanded={legacyOpen}
            onClick={toggleLegacy}
          >
            <span aria-hidden="true">{legacyOpen ? "▾" : "▸"}</span>
            离线/历史会话 {legacy.length}
          </button>
          {legacyOpen ? (
            <ul className="member-picker picker-legacy-list">
              {legacy.map((row) => (
                <PickerRow
                  key={row.node.id}
                  row={row}
                  expandedIds={expanded}
                  selected={selected}
                  showVendor={showVendor}
                  onToggle={onToggle}
                  onExpand={expand}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
