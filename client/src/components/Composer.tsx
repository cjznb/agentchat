/**
 * 消息输入（feat/revoke-queued 自 `ChatView` 抽出，保持其 ≤250 纯行）——
 * 受控草稿 + CJK 输入法安全回车发送（`isComposing` 忽略 Enter）+ 同帧双击锁 + 失败行内提示。
 * 每会话独立实例：调用方以 `key={conversationId}` 挂载，切换会话即重置草稿与错误。
 */
import { useCallback, useRef, useState, type KeyboardEvent } from "react"
import { useStore } from "../store"

/** Composer 入参。 */
export interface ComposerProps {
  readonly conversationId: string
  /** 发送成功后回调（调用方用于贴底滚动）。 */
  readonly onSent?: () => void
}

export function Composer({ conversationId, onSent }: ComposerProps) {
  const { sendMessage } = useStore()
  const sendingRef = useRef(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSend = draft.trim().length > 0 && !sending

  const submit = useCallback((): void => {
    // 同步 ref 锁（F4②）：异步 state 更新前的同帧双击不得重复提交。
    if (draft.trim().length === 0 || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    void sendMessage(conversationId, draft)
      .then(() => {
        setDraft("")
        onSent?.()
      })
      .catch(() => {
        // 失败：乐观气泡已回滚，草稿保留供重试。
        setError("发送失败，请重试。")
      })
      .finally(() => {
        sendingRef.current = false
        setSending(false)
      })
  }, [conversationId, draft, onSent, sendMessage])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      // CJK 输入法选词回车不发送（F4①）。
      if (event.nativeEvent.isComposing) return
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    },
    [submit],
  )

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        className="composer-input"
        data-testid="composer-input"
        aria-label="消息输入框"
        placeholder="输入消息，回车发送，Shift+回车换行"
        value={draft}
        rows={1}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button className="composer-send" data-testid="composer-send" type="submit" disabled={!canSend}>
        发送
      </button>
      {error !== null ? (
        <p className="composer-error" role="alert" data-testid="composer-error">
          {error}
        </p>
      ) : null}
    </form>
  )
}
