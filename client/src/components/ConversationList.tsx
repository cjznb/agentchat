/**
 * 会话列表（spec §11.3；Plan 3 T4）——折叠容器 + 手风琴 + 双层未读徽标。
 *
 * - 折叠/归属/排序计算全在 `fold.ts` 纯函数；本组件只渲染 + 管理展开态
 * - 展开态持久化到 `localStorage`（键 `agentchat:expandedRoots`），坏 JSON 忽略
 * - 点击行：`openAndRead`（打开会话 + 按需载入消息 + `POST .../read` 标已读）
 * - 退役子行：灰显 + `disabled`（不可开聊），仍在原位
 */
import { useCallback, useMemo, useState } from "react"
import type { AgentStatus, ConversationSummary } from "../../../shared/contracts"
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

const STATUS = {
  online: { glyph: "●", text: "在线" },
  busy: { glyph: "◐", text: "忙碌" },
  offline: { glyph: "○", text: "离线" },
  retired: { glyph: "◌", text: "退役" },
} as const satisfies Record<AgentStatus, { readonly glyph: string; readonly text: string }>

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式禁用存储：不持久化展开态
  }
}
function previewOf(conversation: ConversationSummary | null): string {
  return conversation?.lastMessage?.body ?? "暂无消息"
}

function Badge({ count }: { readonly count: number }) {
  if (count <= 0) return null
  return (
    <em className="unread-badge" data-testid="unread-badge" aria-label={`${count} 条未读`}>
      {count}
    </em>
  )
}

function StatusDot({ status }: { readonly status: AgentStatus }) {
  return (
    <i
      className="status-dot"
      data-status={status}
      role="img"
      aria-label={STATUS[status].text}
      title={STATUS[status].text}
    >
      {STATUS[status].glyph}
    </i>
  )
}

function Body({ name, conversation }: { readonly name: string; readonly conversation: ConversationSummary | null }) {
  return (
    <span className="conversation-body">
      <strong>{name}</strong>
      <span>{previewOf(conversation)}</span>
    </span>
  )
}

function ChildItem({
  child,
  activeId,
  onOpen,
}: {
  readonly child: ChildRow
  readonly activeId: string | null
  readonly onOpen: (conversationId: string) => void
}) {
  const { conversation, node, retired } = child
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
}: {
  readonly row: FoldedRow
  readonly activeId: string | null
  readonly onOpen: (conversationId: string) => void
}) {
  const conversation = row.conversation
  if (conversation === null) return null
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
}: {
  readonly row: FoldedRow
  readonly expanded: boolean
  readonly activeId: string | null
  readonly onToggle: (rootId: string) => void
  readonly onOpen: (conversationId: string) => void
}) {
  const name = row.node?.name ?? "私聊"
  const conversation = row.conversation
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
            <ChildItem key={child.conversation.id} child={child} activeId={activeId} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function ConversationList() {
  const { state, openAndRead } = useStore()
  const [expanded, setExpanded] = useState<readonly string[]>(() => loadExpandedRoots(safeStorage()))

  const rows = useMemo(
    () => foldConversations(state.conversations, state.unreadByRoot, state.roster),
    [state.conversations, state.unreadByRoot, state.roster],
  )

  const toggle = useCallback((rootId: string) => {
    setExpanded((previous) => {
      const next = toggleExpandedRoot(previous, rootId)
      saveExpandedRoots(safeStorage(), next)
      return next
    })
  }, [])

  const open = useCallback(
    (conversationId: string) => openAndRead(conversationId),
    [openAndRead],
  )

  return (
    <ul className="conversation-list" data-testid="conversation-list">
      {rows.map((row) =>
        row.kind === "root" ? (
          <RootItem
            key={row.id}
            row={row}
            expanded={expanded.includes(row.id)}
            activeId={state.openConversationId}
            onToggle={toggle}
            onOpen={open}
          />
        ) : (
          <FlatItem key={row.id} row={row} activeId={state.openConversationId} onOpen={open} />
        ),
      )}
    </ul>
  )
}
