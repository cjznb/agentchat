/**
 * 会话行原子组件（Task 8 C2 抽取）——自 `ConversationList.tsx` 纯搬移，不改行为：
 * 预览文案 / 未读徽标 / 被@标记 / 状态点 / 行内容体。
 */
import type { AgentStatus, ConversationSummary } from "../../../shared/contracts"

const STATUS = {
  online: { glyph: "●", text: "在线" },
  busy: { glyph: "◐", text: "忙碌" },
  offline: { glyph: "○", text: "离线" },
  retired: { glyph: "◌", text: "退役" },
} as const satisfies Record<AgentStatus, { readonly glyph: string; readonly text: string }>

function previewOf(conversation: ConversationSummary | null): string {
  return conversation?.lastMessage?.body ?? "暂无消息"
}

export function Badge({ count }: { readonly count: number }) {
  if (count <= 0) return null
  return (
    <em className="unread-badge" data-testid="unread-badge" aria-label={`${count} 条未读`}>
      {count}
    </em>
  )
}

/** Task 8：最新消息 @到人类 → 会话行标记（与未读徽标并列，不参与计数）。 */
export function MentionBadge() {
  return (
    <em className="mention-badge" data-testid="mention-badge" aria-label="被提及">
      @
    </em>
  )
}

export function StatusDot({ status }: { readonly status: AgentStatus }) {
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

export function Body({ name, conversation }: { readonly name: string; readonly conversation: ConversationSummary | null }) {
  return (
    <span className="conversation-body">
      <strong>{name}</strong>
      <span>{previewOf(conversation)}</span>
    </span>
  )
}
