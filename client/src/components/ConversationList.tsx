/**
 * 会话列表（spec §11.3；Plan 3 T4）——折叠容器 + 手风琴 + 双层未读徽标。
 *
 * - 折叠/归属/排序计算全在 `fold.ts` 纯函数；本组件只渲染 + 管理展开态
 * - 展开态持久化到 `localStorage`（键 `agentchat:expandedRoots`），坏 JSON 忽略
 * - 点击行：`openAndRead`（打开会话 + 按需载入消息 + `POST .../read` 标已读）
 * - 退役子行：灰显 + `disabled`（不可开聊），仍在原位
 * - Task 8：会话行「被 @」标记（`conversationMentioned`，未读计数口径不变）
 *   行原子组件抽至 `conversation-row.tsx`（C2：本文件回 ≤250 纯行）
 * - 批次2 轮C (C1)：顶部「群聊」分组头——不可点击 header + 箭头切换、默认收起、
 *   展开态持久化 `agentchat:groupSectionExpanded`；群行全部挂分组区、分组整体
 *   置顶于普通会话之上（喊话仍最顶，非群行相对原序不变）；分组头不聚合未读。
 *   修复 (C1)：分组区（状态/持久化/header/行区）抽至 `GroupSection.tsx`，本文件
 *   只负责分区（喊话顶置 → 分组区 → 其余行）与行渲染，行为零变化。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RosterNode } from "../../../shared/contracts"
import {
  foldConversations,
  loadExpandedRoots,
  saveExpandedRoots,
  toggleExpandedRoot,
  type ChildRow,
  type FoldedRow,
  type StorageLike,
} from "../fold"
import { useStore } from "../store"
import { conversationMentioned } from "../unread"
import { Badge, Body, MentionBadge, StatusDot } from "./conversation-row"
import { GroupSection, GROUP_SECTION_KEY } from "./GroupSection"

// 分组展开态键仍从本模块导出（既有消费方导入路径不变，实现已移至 GroupSection）。
export { GROUP_SECTION_KEY }

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式禁用存储：不持久化展开态
  }
}

function ChildItem({
  child,
  activeId,
  onOpen,
  roster,
}: {
  readonly child: ChildRow
  readonly activeId: string | null
  readonly onOpen: (conversationId: string) => void
  readonly roster: readonly RosterNode[]
}) {
  const { conversation, node, retired } = child
  const mentioned = conversationMentioned(conversation, roster)
  return (
    <li>
      <button
        className="conversation-item conversation-child"
        data-testid="conversation-item"
        data-kind="child"
        data-conversation-id={conversation.id}
        data-active={conversation.id === activeId}
        data-retired={retired}
        disabled={retired}
        onClick={() => onOpen(conversation.id)}
        type="button"
      >
        {node === undefined ? null : <StatusDot status={node.status} />}
        <Body name={node?.name ?? conversation.name ?? "私聊"} conversation={conversation} />
        {mentioned ? <MentionBadge /> : null}
        <Badge count={conversation.unread} />
      </button>
    </li>
  )
}

function flatName(row: FoldedRow): string {
  const conversation = row.conversation
  if (conversation === null) return "私聊"
  if (row.kind === "shout") return conversation.name ?? "全员喊话"
  if (row.kind === "group") return conversation.name ?? "群聊"
  return row.node?.name ?? conversation.name ?? "逻辑节点"
}

function FlatItem({
  row,
  activeId,
  onOpen,
  roster,
}: {
  readonly row: FoldedRow
  readonly activeId: string | null
  readonly onOpen: (conversationId: string) => void
  readonly roster: readonly RosterNode[]
}) {
  const conversation = row.conversation
  if (conversation === null) return null
  const mentioned = conversationMentioned(conversation, roster)
  return (
    <li>
      <button
        className="conversation-item conversation-flat"
        data-testid="conversation-item"
        data-kind={row.kind}
        data-conversation-id={conversation.id}
        data-active={conversation.id === activeId}
        onClick={() => onOpen(conversation.id)}
        type="button"
      >
        <Body name={flatName(row)} conversation={conversation} />
        {mentioned ? <MentionBadge /> : null}
        <Badge count={row.unread} />
      </button>
    </li>
  )
}

function RootItem({
  row,
  expanded,
  activeId,
  onToggle,
  onOpen,
  roster,
}: {
  readonly row: FoldedRow
  readonly expanded: boolean
  readonly activeId: string | null
  readonly onToggle: (rootId: string) => void
  readonly onOpen: (conversationId: string) => void
  readonly roster: readonly RosterNode[]
}) {
  const name = row.node?.name ?? "私聊"
  const conversation = row.conversation
  const mentioned = conversation !== null && conversationMentioned(conversation, roster)
  return (
    <li className="fold-root" data-testid="root-row" data-root-id={row.id}>
      <div className="fold-head" data-expanded={expanded}>
        {row.children.length > 0 ? (
          <button
            className="fold-toggle"
            data-testid="fold-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${name} 的子会话`}
            onClick={() => onToggle(row.id)}
            type="button"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="fold-toggle is-placeholder" aria-hidden="true" />
        )}
        <button
          className="conversation-item fold-content"
          data-testid="conversation-item"
          data-kind="root"
          data-conversation-id={conversation?.id ?? ""}
          data-active={conversation !== null && conversation.id === activeId}
          disabled={conversation === null}
          onClick={() => {
            if (conversation !== null) onOpen(conversation.id)
          }}
          type="button"
        >
          <Body name={name} conversation={conversation} />
          {mentioned ? <MentionBadge /> : null}
        </button>
        <span className="fold-meta">
          {row.children.length > 0 ? (
            <span className="fold-summary" data-testid="fold-summary">
              {row.children.length} 子
            </span>
          ) : null}
          <Badge count={row.unread} />
        </span>
      </div>
      {expanded && row.children.length > 0 ? (
        <ul className="fold-children">
          {row.children.map((child) => (
            <ChildItem key={child.conversation.id} child={child} activeId={activeId} onOpen={onOpen} roster={roster} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface ConversationListProps {
  /** 建群入口（Plan 3 T7）；缺省不渲染（组织树等复用场景）。 */
  readonly onCreateGroup?: () => void
}

export function ConversationList({ onCreateGroup }: ConversationListProps = {}) {
  const { state, openAndRead } = useStore()
  const [expanded, setExpanded] = useState<readonly string[]>(() => loadExpandedRoots(safeStorage()))

  const rows = useMemo(
    () => foldConversations(state.conversations, state.roster),
    [state.conversations, state.roster],
  )

  // C1 分区：喊话置顶不变；群会话全部收进分组区；其余行保持原相对顺序。
  const shoutRows = useMemo(() => rows.filter((row) => row.kind === "shout"), [rows])
  const groupRows = useMemo(() => rows.filter((row) => row.kind === "group"), [rows])
  const otherRows = useMemo(
    () => rows.filter((row) => row.kind !== "shout" && row.kind !== "group"),
    [rows],
  )

  // 展开态持久化移入 effect（Plan 3 终审 F6）：updater 保持纯函数，
  // StrictMode 双挂载只做幂等重写（同值），不再在 updater 内触发副作用。
  const toggle = useCallback((rootId: string) => {
    setExpanded((previous) => toggleExpandedRoot(previous, rootId))
  }, [])

  // 值未变不重复持久化（StrictMode 双挂载同值幂等）。
  const persistedRef = useRef("")
  useEffect(() => {
    const serialized = JSON.stringify(expanded)
    if (persistedRef.current === serialized) return
    persistedRef.current = serialized
    saveExpandedRoots(safeStorage(), expanded)
  }, [expanded])

  const open = useCallback(
    (conversationId: string) => openAndRead(conversationId),
    [openAndRead],
  )

  return (
    <ul className="conversation-list" data-testid="conversation-list">
      {rows.length === 0 ? (
        <li className="list-empty" data-testid="conversation-empty">
          <span aria-hidden="true">—</span>
          <p>还没有会话</p>
          <small>从通讯录发起对话，或新建群聊</small>
        </li>
      ) : (
        <>
          {shoutRows.map((row) => (
            <FlatItem key={row.id} row={row} activeId={state.openConversationId} onOpen={open} roster={state.roster} />
          ))}
          {groupRows.length === 0 ? null : (
            <GroupSection>
              {groupRows.map((row) => (
                <FlatItem key={row.id} row={row} activeId={state.openConversationId} onOpen={open} roster={state.roster} />
              ))}
            </GroupSection>
          )}
          {otherRows.map((row) =>
            row.kind === "root" ? (
              <RootItem
                key={row.id}
                row={row}
                expanded={expanded.includes(row.id)}
                activeId={state.openConversationId}
                onToggle={toggle}
                onOpen={open}
                roster={state.roster}
              />
            ) : (
              <FlatItem key={row.id} row={row} activeId={state.openConversationId} onOpen={open} roster={state.roster} />
            ),
          )}
        </>
      )}
      {onCreateGroup === undefined ? null : (
        <li className="conversation-create">
          <button
            className="conversation-create-button"
            data-testid="create-group"
            onClick={onCreateGroup}
            type="button"
          >
            <span className="conversation-create-glyph" aria-hidden="true">
              ＋
            </span>
            新建群聊
          </button>
        </li>
      )}
    </ul>
  )
}
