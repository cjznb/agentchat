/**
 * 消息气泡（spec §11.4；Plan 3 T5）——己方右 / 对方左、系统消息居中、
 * 发送者头像 + 厂商徽标 + 子节点徽标、己方四级回执。纯展示，数据全由 props 注入。
 */
import type { ChatMessage } from "../../../shared/contracts"
import type { CardData } from "../cards"
import { formatClock, initialOf, vendorBadge, type SenderView } from "../chat"
import { receiptGlyph } from "../receipts"
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
}

function rowClass(highlighted: boolean, extra?: string): string {
  return ["message-row", extra ?? "", highlighted ? "is-highlighted" : ""]
    .filter((token) => token !== "")
    .join(" ")
}

export function MessageBubble({ message, own, sender, showSender, highlighted, card }: MessageBubbleProps) {
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
  // spec §11.4：子消息带 `[子·根名]` 徽标（不限群聊）；私聊亦显示，仅身份行（头像/名字/厂商）随 showSender。
  const childBadge = !own && sender !== undefined && sender.rootName !== null ? sender.rootName : null

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
        <p className="bubble-body">{message.body}</p>
        <footer className="bubble-foot">
          <time className="bubble-time">{formatClock(message.createdAt)}</time>
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
        </footer>
      </div>
    </li>
  )
}
