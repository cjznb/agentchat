/**
 * 通知页（spec §11.5/§17.3；Plan 3 T8）——两 tab（需我处理 / 全部）、未读点、状态、
 * 点击已读 + 深链跳转到卡消息、条目内联回复（复用 `CardActions`，与聊天卡同一提交逻辑）。
 *
 * 两 tab 直接映射 REST `scope`；未读 = `readAt` 为空；卡片/跳转锚点来自 `NotificationEntry`
 * （`cardMessageId` + `conversationId`）。点击事件先乐观置已读（不阻塞跳转），再交给 App 定位。
 */
import { useCallback, useMemo, useState } from "react"
import type { NotificationEntry } from "../../../shared/contracts"
import {
  cardFromEntry,
  cardOutcome,
  cardSubject,
  entriesForTab,
  formatMoment,
  kindLabel,
  statusLabel,
  unreadCount,
  type NotificationTab,
} from "../cards"
import { buildRosterView } from "../chat"
import { useStore } from "../store"
import { CardActions } from "./Cards"

/** 发起方展示名（roster 缺失回退 id）。 */
function requesterName(entry: NotificationEntry, names: ReadonlyMap<string, string>): string {
  return names.get(entry.requesterAgentId) ?? entry.requesterAgentId
}

function NotificationItem({
  entry,
  names,
  onOpen,
}: {
  readonly entry: NotificationEntry
  readonly names: ReadonlyMap<string, string>
  readonly onOpen: () => void
}) {
  const card = cardFromEntry(entry)
  const unread = entry.readAt === undefined
  const outcome = cardOutcome(card, entry)
  return (
    <li
      className="notif-item"
      data-testid="notification-item"
      data-kind={entry.kind}
      data-status={entry.status}
      data-unread={unread}
      data-notification-id={entry.id}
      data-card-message-id={entry.cardMessageId ?? ""}
      data-conversation-id={entry.conversationId ?? ""}
    >
      <button
        type="button"
        className="notif-hit"
        data-testid="notification-open"
        onClick={onOpen}
        aria-label={`打开：${cardSubject(card)}`}
      >
        <span className="notif-dot" data-testid="notification-unread" data-unread={unread} aria-hidden="true" />
        <span className="notif-kind">{kindLabel(entry.kind)}</span>
        <span className="notif-main">
          <span className="notif-subject">{cardSubject(card)}</span>
          <span className="notif-meta">
            {requesterName(entry, names)} · {formatMoment(entry.createdAt)}
          </span>
        </span>
        <span className="notif-status" data-status={entry.status}>
          {statusLabel(entry.status)}
        </span>
      </button>
      {outcome.ended ? (
        <p className="notif-result" data-testid="notification-result">
          {outcome.resultText}
        </p>
      ) : (
        <div className="notif-reply">
          <CardActions card={card} entry={entry} />
        </div>
      )}
    </li>
  )
}

export interface NotificationsViewProps {
  /** 点击条目：把 `?conversation=&msg=` 跳转交给 App（复用 T5 深链定位）。 */
  readonly onJump: (conversationId: string, messageId: string) => void
}

export function NotificationsView({ onJump }: NotificationsViewProps) {
  const { state, markNotificationRead } = useStore()
  const [tab, setTab] = useState<NotificationTab>("actionable")
  const rosterView = useMemo(() => buildRosterView(state.roster), [state.roster])
  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, view] of rosterView.byId) map.set(id, view.name)
    return map
  }, [rosterView])
  const entries = entriesForTab(tab, state.notifications, state.notificationsAll)
  const unread = unreadCount(state.notifications)

  const open = useCallback(
    (entry: NotificationEntry): void => {
      void markNotificationRead(entry.id)
      if (entry.conversationId !== null && entry.cardMessageId !== null) {
        onJump(entry.conversationId, entry.cardMessageId)
      }
    },
    [markNotificationRead, onJump],
  )

  return (
    <section className="notif-view" data-testid="notifications-view">
      <header className="notif-head">
        <div>
          <p>通知中心</p>
          <h1>审批与批示</h1>
        </div>
        <span className="notif-count" data-testid="notification-unread-total">
          {unread} 未读
        </span>
      </header>
      <div className="notif-tabs" role="tablist" aria-label="通知范围">
        <button
          type="button"
          role="tab"
          className="notif-tab"
          data-testid="notif-tab-actionable"
          data-active={tab === "actionable"}
          aria-selected={tab === "actionable"}
          onClick={() => setTab("actionable")}
        >
          需我处理 <b>{state.notifications.length}</b>
        </button>
        <button
          type="button"
          role="tab"
          className="notif-tab"
          data-testid="notif-tab-all"
          data-active={tab === "all"}
          aria-selected={tab === "all"}
          onClick={() => setTab("all")}
        >
          全部 <b>{state.notificationsAll.length}</b>
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="notif-empty" data-testid="notifications-empty">
          {tab === "actionable" ? "没有需要你处理的单据。" : "还没有任何通知。"}
        </p>
      ) : (
        <ul className="notif-list" data-testid="notifications-list">
          {entries.map((entry) => (
            <NotificationItem
              key={entry.id}
              entry={entry}
              names={names}
              onOpen={() => open(entry)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** 中栏通知概览（rail 入口旁的读数，与右栏列表同源）。 */
export function NotificationAside() {
  const { state } = useStore()
  const pending = state.notifications.length
  const unread = unreadCount(state.notifications)
  return (
    <div className="notif-aside" data-testid="notification-aside">
      <p className="notif-aside-line">
        待处理 <b data-testid="notification-aside-pending">{pending}</b>
      </p>
      <p className="notif-aside-line">
        未读 <b data-testid="notification-aside-unread">{unread}</b>
      </p>
      <p className="notif-aside-note">点击条目已读并定位到会话中的卡。</p>
    </div>
  )
}
