/**
 * 聊天视图（spec §11.4；Plan 3 T5）——消息流 + 滚顶上翻分页 + 深链定位 + 发送。
 * 派生逻辑在 `chat.ts` / `receipts.ts` / `deeplink.ts` 纯函数；本组件只管交互与滚动。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { ChatMessage } from "../../../shared/contracts"
import { buildRosterView, conversationTitle } from "../chat"
import { useStore } from "../store"
import { GroupInfo } from "./GroupInfo"
import { MessageBubble } from "./MessageBubble"

/** 分页页大小（与服务端 `DEFAULT_HISTORY_LIMIT` 对齐）。 */
const PAGE_SIZE = 50
/** 距顶阈值（px）内触发上翻。 */
const TOP_THRESHOLD = 24
/** 贴底判定（px）：新消息仅在贴底时跟随滚动，不打断上翻阅读。 */
const BOTTOM_THRESHOLD = 80
/** 深链命中高亮时长（spec §11.4：2s）。 */
const HIGHLIGHT_MS = 2000

const EMPTY_MESSAGES: readonly ChatMessage[] = []

/** ChatView 入参。 */
export interface ChatViewProps {
  readonly conversationId: string
  /** 深链目标消息短 id（`?msg=`）；命中滚动 + 高亮 2s，未命中静默。 */
  readonly focusMessageId: string | null
}

export function ChatView({ conversationId, focusMessageId }: ChatViewProps) {
  const { state, loadOlder, sendMessage } = useStore()
  const rosterView = useMemo(() => buildRosterView(state.roster), [state.roster])
  const messages = state.messages.get(conversationId) ?? EMPTY_MESSAGES
  const conversation = state.conversations.find((item) => item.id === conversationId)
  const title = conversationTitle(conversation, rosterView)
  const isGroup = conversation?.kind === "group"
  const isGroupChat = isGroup && conversation?.key !== "shout"

  const scrollRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const nearBottomRef = useRef(true)
  const handledFocusRef = useRef<string | null>(null)
  const highlightTimerRef = useRef<number | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [showGroupInfo, setShowGroupInfo] = useState(false)

  const scrollToBottom = useCallback((): void => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [])

  // 切换会话：重置分页游标 / 草稿 / 高亮，并滚到底部；卸载/切会话时清掉高亮计时器（复审 I1）。
  useEffect(() => {
    hasMoreRef.current = true
    nearBottomRef.current = true
    handledFocusRef.current = null
    setDraft("")
    setError(null)
    setHighlightId(null)
    setShowGroupInfo(false)
    scrollToBottom()
    return () => {
      if (highlightTimerRef.current !== undefined) {
        window.clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = undefined
      }
    }
  }, [conversationId, scrollToBottom])

  // 新消息到达：贴底时跟随（不打断上翻阅读）。
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom()
  }, [messages.length, scrollToBottom])

  const onScroll = useCallback((): void => {
    const node = scrollRef.current
    if (node === null) return
    nearBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_THRESHOLD
    if (loadingRef.current || node.scrollTop > TOP_THRESHOLD) return
    if (!hasMoreRef.current) return
    const earliest = messages[0]
    if (earliest === undefined) return
    if (messages.length < PAGE_SIZE) {
      hasMoreRef.current = false
      return
    }
    loadingRef.current = true
    setLoading(true)
    const previousHeight = node.scrollHeight
    void loadOlder(conversationId, earliest.seq)
      .then((count) => {
        if (count < PAGE_SIZE) hasMoreRef.current = false
      })
      .catch(() => {
        hasMoreRef.current = false
      })
      .finally(() => {
        loadingRef.current = false
        setLoading(false)
        // 保留阅读位置：补入的高度使 scrollTop 下移等量。
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el !== null) el.scrollTop = el.scrollHeight - previousHeight
        })
      })
  }, [conversationId, loadOlder, messages])

  // 深链定位：目标载入后滚动 + 高亮 2s；每次会话仅定位一次，未命中静默。
  // 高亮计时器存 ref 且**不注册 effect cleanup**——2s 窗口内任何 refetch 换了 `messages`
  // 引用都不得取消/延长高亮；清除只由计时器或会话切换/卸载触发（复审 I1）。
  useEffect(() => {
    if (focusMessageId === null || handledFocusRef.current === focusMessageId) return
    if (!messages.some((message) => message.id === focusMessageId)) return
    handledFocusRef.current = focusMessageId
    setHighlightId(focusMessageId)
    const target = scrollRef.current?.querySelector(`[data-message-id="${focusMessageId}"]`)
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "center" })
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightId(null)
      highlightTimerRef.current = undefined
    }, HIGHLIGHT_MS)
  }, [focusMessageId, messages])

  const canSend = draft.trim().length > 0 && !sending

  const submit = useCallback((): void => {
    if (draft.trim().length === 0 || sending) return
    setSending(true)
    setError(null)
    void sendMessage(conversationId, draft)
      .then(() => {
        setDraft("")
        nearBottomRef.current = true
        requestAnimationFrame(scrollToBottom)
      })
      .catch(() => {
        setError("发送失败，请重试。")
      })
      .finally(() => setSending(false))
  }, [conversationId, draft, scrollToBottom, sendMessage, sending])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    },
    [submit],
  )

  return (
    <section className="chat-view" data-testid="chat-view" data-conversation-id={conversationId}>
      <header className="chat-header">
        <div>
          <p>{isGroup ? "群聊" : "私聊"}</p>
          <h1 id="view-title">{title}</h1>
        </div>
        <div className="chat-header-actions">
          {isGroupChat ? (
            <button
              className="chat-group-info-toggle"
              data-testid="group-info-toggle"
              aria-pressed={showGroupInfo}
              onClick={() => setShowGroupInfo((value) => !value)}
              type="button"
            >
              群资料
            </button>
          ) : null}
          <span className="chat-count" data-testid="message-count">
            {messages.length}
          </span>
        </div>
      </header>
      <div className="chat-scroll" data-testid="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {loading ? (
          <p className="chat-loading" data-testid="chat-loading">
            正在载入更早的消息…
          </p>
        ) : null}
        {messages.length === 0 ? (
          <p className="chat-empty">还没有消息，说点什么吧。</p>
        ) : (
          <ul className="message-list" data-testid="message-list">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                own={rosterView.humanId !== null && message.fromAgentId === rosterView.humanId}
                sender={rosterView.byId.get(message.fromAgentId)}
                showSender={isGroup}
                highlighted={highlightId === message.id}
              />
            ))}
          </ul>
        )}
      </div>
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
      {isGroupChat && showGroupInfo ? (
        <GroupInfo conversationId={conversationId} onClose={() => setShowGroupInfo(false)} />
      ) : null}
    </section>
  )
}
