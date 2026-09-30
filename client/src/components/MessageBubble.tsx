/**
 * 消息气泡（spec §11.4；Plan 3 T5）——己方右 / 对方左、系统消息居中、
 * 发送者头像 + 厂商徽标 + 子节点徽标、己方四级回执。纯展示，数据全由 props 注入。
 * Task 8：正文 `@名字` 高亮（`splitMentions` 分段）+ `meta.mentions` 正文未写的提及 chip。
 */
import { Fragment } from "react"
import type { ChatMessage } from "../../../shared/contracts"
import { splitMentions, type MentionTarget } from "../../../shared/mentions"
import type { CardData } from "../cards"
import { formatClock, initialOf, vendorBadge, type SenderView } from "../chat"
import { receiptGlyph } from "../receipts"
import { canRevoke, revokeView } from "../revoke"
import { ChatCard } from "./Cards"

/** MessageBubble 入参。 */
export interface MessageBubbleProps {
  readonly message: ChatMessage
  readonly own: boolean
  readonly sender: SenderView | undefined
  /** 群聊上下文：展示头像 / 名字 / 徽标（私聊与己方隐藏）。 */
  readonly showSender: boolean
  readonly highlighted: boolean
  /** 审批/批示卡（`meta` 识别）；非卡系统消息 → null。 */
  readonly card: CardData | null
  /** 撤回回调（仅己方且有未送达副本时展示按钮）；缺省 = 不展示入口。 */
  readonly onRevoke?: () => void
  /** 撤回请求进行中（按钮禁用）。 */
  readonly revoking?: boolean
  /** 会话参与者（roster 视图映射）：`@` 高亮与提及 chip 用；缺省 = 不高亮、不出 chip。 */
  readonly participants?: readonly MentionTarget[]
  /** `[子·根名]` 层级徽标渲染开关（缺省 = true，既有渲染点零变化）；私聊传 false 仅显身份行。 */
  readonly showChildBadge?: boolean
}

/** `meta.mentions`（agentId 数组）类型收窄；无 meta / 非数组 / 非字符串元素 → 空。 */
function metaMentionIds(meta: ChatMessage["meta"]): readonly string[] {
  if (meta === undefined) return []
  const raw: unknown = meta["mentions"]
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === "string")
}

function rowClass(highlighted: boolean, extra?: string): string {
  return ["message-row", extra ?? "", highlighted ? "is-highlighted" : ""]
    .filter((token) => token !== "")
    .join(" ")
}

export function MessageBubble({
  message,
  own,
  sender,
  showSender,
  highlighted,
  card,
  onRevoke,
  revoking = false,
  participants = [],
  showChildBadge = true,
}: MessageBubbleProps) {
  const highlightAttr = highlighted ? "true" : undefined

  if (message.kind === "system") {
    if (card !== null) {
      return (
        <li
          className={rowClass(highlighted, "is-system is-card")}
          data-testid="message-card"
          data-message-id={message.id}
          data-highlight={highlightAttr}
        >
          <ChatCard card={card} />
        </li>
      )
    }
    return (
      <li
        className={rowClass(highlighted, "is-system")}
        data-testid="message-system"
        data-message-id={message.id}
        data-highlight={highlightAttr}
      >
        <span className="system-text">{message.body}</span>
      </li>
    )
  }

  const receipt =
    own && message.receipts !== undefined && message.receiptStage !== undefined
      ? receiptGlyph(message.receiptStage)
      : null
  const showIdentity = showSender && !own && sender !== undefined
  // spec §11.4 / §4.2：`[子·根名]` 徽标仅群聊（`showChildBadge`，缺省 true）；私聊只显身份行。
  const childBadge =
    !own && showChildBadge && sender !== undefined && sender.rootName !== null
      ? sender.rootName
      : null
  const revoked = revokeView(message, own)
  const showRevoke = canRevoke(message, own) && onRevoke !== undefined
  // Task 8：正文 `@` 分段高亮 + `meta.mentions` 中正文未书写的成员出 chip。
  const parts = splitMentions(message.body, participants)
  const chipNames: string[] = []
  {
    const seenIds = new Set<string>()
    for (const id of metaMentionIds(message.meta)) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const target = participants.find((p) => p.id === id)
      if (target === undefined) continue
      if (message.body.includes("@" + target.name)) continue
      chipNames.push(target.name)
    }
  }

  return (
    <li
      className={rowClass(highlighted)}
      data-testid="message-row"
      data-message-id={message.id}
      data-own={own}
      data-highlight={highlightAttr}
    >
      {showIdentity ? (
        <span className="avatar" data-vendor={sender.vendor} aria-hidden="true">
          {initialOf(sender.name)}
        </span>
      ) : null}
      <div className="bubble-col">
        {showIdentity || childBadge !== null ? (
          <header className="bubble-head">
            {showIdentity ? (
              <>
                <span className="sender-name">{sender.name}</span>
                <span className="vendor-badge" data-testid="vendor-badge">
                  {vendorBadge(sender.vendor)}
                </span>
              </>
            ) : null}
            {childBadge !== null ? (
              <span className="child-badge" data-testid="child-badge">
                [子·{childBadge}]
              </span>
            ) : null}
          </header>
        ) : null}
        {revoked === "placeholder" ? (
          <p className="bubble-body is-revoked" data-testid="revoke-placeholder">
            此消息已撤回
          </p>
        ) : (
          <p className="bubble-body">
            {parts.map((part, index) =>
              part.mention === undefined ? (
                <Fragment key={index}>{part.text}</Fragment>
              ) : (
                <mark className="mention-hit" key={index}>
                  {part.text}
                </mark>
              ),
            )}
          </p>
        )}
        <footer className="bubble-foot">
          <time className="bubble-time">{formatClock(message.createdAt)}</time>
          {revoked === "marked" ? (
            <span className="revoke-mark" data-testid="revoke-mark">
              已撤回
            </span>
          ) : null}
          {revoked === "placeholder"
            ? null
            : chipNames.map((name) => (
                <span className="mention-chip" data-testid="mention-chip" key={name}>
                  提及: {name}
                </span>
              ))}
          {receipt !== null ? (
            <span
              className="receipt"
              data-testid="receipt"
              data-stage={message.receiptStage}
              data-tone={receipt.tone}
              title={receipt.label}
            >
              <i className="receipt-glyph" aria-hidden="true">
                {receipt.glyph}
              </i>
              <span className="receipt-label">{receipt.label}</span>
            </span>
          ) : null}
          {showRevoke ? (
            <button
              className="bubble-revoke"
              data-testid="revoke-button"
              type="button"
              disabled={revoking}
              onClick={onRevoke}
            >
              {revoking ? "撤回中…" : "撤回"}
            </button>
          ) : null}
        </footer>
      </div>
    </li>
  )
}
