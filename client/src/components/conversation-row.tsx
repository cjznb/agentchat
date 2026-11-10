/**
 * 会话行原子组件（Task 8 C2 抽取）——自 `ConversationList.tsx` 纯搬移，不改行为：
 * 预览文案 / 未读徽标 / 被@标记 / 状态点 / 行内容体。
 *
 * UI-1 ②-5（信息层级）：新增 `RowAvatar`（头像/标识）与 `RowTime`（分级短时间戳）——
 * 与消息气泡同款 `.avatar`（厂商底色 + 首字），时间走 `formatListTime` 纯函数。
 */
import type { AgentStatus, ConversationSummary } from "../../../shared/contracts"
import { formatListTime, initialOf } from "../chat"

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

/**
 * 行首标识（UI-1 ②-5）：群/喊话给语义字，节点给厂商底色 + 名字首字（与 `.avatar` 同款）。
 * `aria-hidden`：名字文本就在旁边，头像纯装饰，不给读屏加噪声。
 */
export function RowAvatar({
  name,
  vendor,
  kind,
}: {
  readonly name: string
  /** `exactOptionalPropertyTypes` 下显式含 `undefined`（调用方传 `node?.vendor`）。 */
  readonly vendor?: string | null | undefined
  readonly kind: "group" | "shout" | "node"
}) {
  const glyph = kind === "group" ? "群" : kind === "shout" ? "播" : initialOf(name)
  return (
    <span
      className="avatar row-avatar"
      data-testid="row-avatar"
      data-kind={kind}
      {...(kind === "node" ? { "data-vendor": vendor ?? "unknown" } : {})}
      aria-hidden="true"
    >
      {glyph}
    </span>
  )
}

/** 行尾分级时间戳（UI-1 ②-5）：`dateTime` 给机器读，文本给人读。 */
export function RowTime({ createdAt }: { readonly createdAt: number }) {
  return (
    <time
      className="conversation-time"
      data-testid="conversation-time"
      dateTime={new Date(createdAt).toISOString()}
    >
      {formatListTime(createdAt)}
    </time>
  )
}

export function Body({ name, conversation }: { readonly name: string; readonly conversation: ConversationSummary | null }) {
  return (
    <span className="conversation-body">
      <strong>{name}</strong>
      <span data-testid="conversation-preview">{previewOf(conversation)}</span>
    </span>
  )
}

/** 行尾聚合（UI-1 ②-5）：被@ / 时间 / 未读徽标收进同一列，避免挤压标题。 */
export function Side({
  conversation,
  unread,
  mentioned,
}: {
  readonly conversation: ConversationSummary | null
  readonly unread: number
  readonly mentioned: boolean
}) {
  return (
    <span className="conversation-side">
      {mentioned ? <MentionBadge /> : null}
      {conversation === null ? null : (
        <RowTime createdAt={conversation.lastMessage?.createdAt ?? conversation.createdAt} />
      )}
      <Badge count={unread} />
    </span>
  )
}
