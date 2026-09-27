/**
 * 审批卡 / 批示卡（spec §11.4/§11.5/§17；Plan 3 T8）。
 *
 * - `ChatCard`：会话消息流内的卡（`ChatMessage.meta` 识别，权威状态查 `notificationsAll`）
 * - `CardActions`：`ChatCard` 与通知页条目**共用**同一提交逻辑（决议 4，勿复制）——
 *   审批 → `POST /api/approvals/:id`；批示 → `POST /api/asks/:id/respond`
 * - 提交中禁用；成功后本地乐观置已决并隐藏按钮；409/404 显示明确提示且不改本地已决态
 * - UI 绝不把 ask id 打去审批端点（`card.kind` 分流，批示卡无同意/拒绝按钮）
 */
import { useCallback, useState, type FormEvent } from "react"
import type { ApprovalEntry, ApprovalKind, NotificationEntry } from "../../../shared/contracts"
import { ApiError } from "../api"
import {
  cardDetail,
  cardErrorText,
  cardOutcome,
  cardSubject,
  type CardData,
} from "../cards"
import { useStore } from "../store"

function errorStatus(error: unknown): number {
  return error instanceof ApiError ? error.status : 0
}

/** CardActions 入参：卡视图 + 权威通知条目（缺省即 pending）。 */
export interface CardActionsProps {
  readonly card: CardData
  readonly entry: NotificationEntry | undefined
}

/**
 * 卡内回复控件（聊天卡 / 通知条目共用）。本地 `submitted` 覆盖权威条目：提交成功立即
 * 显示已决态；服务端二次校验被拒（409）时保留原态并提示（不改本地已决态）。
 */
export function CardActions({ card, entry }: CardActionsProps) {
  const { decideApproval, respondAsk } = useStore()
  const [submitted, setSubmitted] = useState<ApprovalEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState("")
  const outcome = cardOutcome(card, submitted ?? entry)
  const kind: ApprovalKind = card.kind === "ask" ? "ask" : "action"

  // F6：任务体只做异步请求（纯 promise），状态更新一律在 `.then` 解析回调里发生——
  // 不在 updater / render 期产生副作用；`onSuccess` 承载提交成功后的本地清理（如清空自定义输入）。
  const run = useCallback(
    (task: () => Promise<ApprovalEntry>, onSuccess?: () => void): void => {
      if (busy) return
      setBusy(true)
      setError(null)
      void task()
        .then((approval) => {
          setSubmitted(approval)
          onSuccess?.()
        })
        .catch((cause: unknown) => setError(cardErrorText(kind, errorStatus(cause))))
        .finally(() => setBusy(false))
    },
    [busy, kind],
  )

  if (card.kind === "approval") {
    return (
      <div className="card-actions" data-kind="approval" data-state={outcome.ended ? "ended" : "open"}>
        {outcome.ended ? (
          <p className="card-verdict" data-testid="card-verdict" data-status={outcome.status}>
            {outcome.resultText}
          </p>
        ) : (
          <div className="card-buttons">
            <button
              type="button"
              className="card-button is-approve"
              data-testid="card-approve"
              disabled={busy}
              onClick={() => run(() => decideApproval(card.id, "approve"))}
            >
              同意
            </button>
            <button
              type="button"
              className="card-button is-reject"
              data-testid="card-reject"
              disabled={busy}
              onClick={() => run(() => decideApproval(card.id, "reject"))}
            >
              拒绝
            </button>
          </div>
        )}
        {error !== null ? (
          <p className="card-error" role="alert" data-testid="card-error">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  const respond = (answer: { readonly choice?: string; readonly text?: string }): void => {
    if (outcome.ended) return
    run(() => respondAsk(card.id, answer), () => setCustom(""))
  }

  const submitCustom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = custom.trim()
    if (text === "" || outcome.ended) return
    respond({ text })
  }

  return (
    <div className="card-actions" data-kind="ask" data-state={outcome.ended ? "ended" : "open"}>
      {card.options.length > 0 ? (
        <ul className="card-choices">
          {card.options.map((option) => (
            <li key={option}>
              <button
                type="button"
                className="card-choice"
                data-testid="card-choice"
                data-selected={outcome.selectedChoice === option}
                disabled={busy || outcome.ended}
                onClick={() => respond({ choice: option })}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {card.allowCustom && !outcome.ended ? (
        <form className="card-custom" onSubmit={submitCustom}>
          <input
            className="card-custom-input"
            data-testid="card-custom-input"
            aria-label="自定义答复"
            placeholder="或输入你的答复"
            value={custom}
            disabled={busy}
            onChange={(event) => setCustom(event.target.value)}
          />
          <button
            type="submit"
            className="card-custom-send"
            data-testid="card-custom-send"
            disabled={busy || custom.trim() === ""}
          >
            答复
          </button>
        </form>
      ) : null}
      {outcome.ended ? (
        <p className="card-verdict" data-testid="card-verdict" data-status={outcome.status}>
          {outcome.resultText}
        </p>
      ) : null}
      {error !== null ? (
        <p className="card-error" role="alert" data-testid="card-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** 会话内卡（消息流内联）：类别信号条 + 单据主题 + 共用回复控件。 */
export function ChatCard({ card }: { readonly card: CardData }) {
  const { state } = useStore()
  const entry = state.notificationsAll.find((item) => item.id === card.id)
  const detail = card.kind === "approval" ? cardDetail(card) : null
  return (
    <article
      className="card"
      data-testid="chat-card"
      data-kind={card.kind}
      data-status={cardOutcome(card, entry).status}
    >
      <header className="card-head">
        <span className="card-mark" aria-hidden="true">
          {card.kind === "ask" ? "❓" : "🔒"}
        </span>
        <div className="card-head-text">
          <p className="card-eyebrow">{card.kind === "ask" ? "请求批示" : "审批请求"}</p>
          <h3 className="card-subject">{cardSubject(card)}</h3>
          {detail !== null ? <p className="card-detail">{detail}</p> : null}
        </div>
      </header>
      <CardActions card={card} entry={entry} />
    </article>
  )
}
