/**
 * 聊天视图（spec §11.4/§11.5；Plan 3 T5）——消息流 + 滚顶上翻分页 + 深链定位 + 发送。
 * 派生逻辑在 `chat.ts` / `receipts.ts` / `deeplink.ts` / `revoke.ts` 纯函数；本组件只管交互与滚动。
 *
 * 终审修复：
 * - F2 深链：未命中时**有界向前分页**（复用 `loadOlder`，上限 `MAX_FOCUS_PAGES` 页）；
 *   历史耗尽仍未命中 → 显式「消息不可定位」（不静默）；DOM 定位按 `dataset.messageId` 集合
 *   比较（不再把 `msg` 拼进 `querySelector`，含引号不抛 `DOMException`）。
 * - F4 输入：输入框与发送逻辑抽至 `Composer`（本文件 ≤250 纯行；同帧双击锁 / CJK 安全回车不变）。
 * - feat/revoke-queued：己方气泡撤回入口 + 行内错误；派生在 `revoke.ts`，编排在 store 动作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChatMessage } from "../../../shared/contracts"
import { readCardMessage } from "../cards"
import { buildRosterView, conversationTitle } from "../chat"
import { useStore } from "../store"
import { Composer } from "./Composer"
import { GroupInfo } from "./GroupInfo"
import { MessageBubble } from "./MessageBubble"

/** 分页页大小（与服务端 `DEFAULT_HISTORY_LIMIT` 对齐）。 */
const PAGE_SIZE = 50
/** 深链向前分页上限（页）：最多 5 页 / 250 条，找到即停（F2 有界）。 */
const MAX_FOCUS_PAGES = 5
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
  /** 深链目标消息短 id（`?msg=`）；命中滚动 + 高亮 2s，未命中则分页查找，耗尽后显式提示。 */
  readonly focusMessageId: string | null
}

/** 按 `data-message-id` 集合比较定位目标（不拼接选择器，任何字符都安全）。 */
function findMessageNode(container: HTMLElement | null, messageId: string): HTMLElement | undefined {
  if (container === null) return undefined
  return Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
    (element) => element.dataset["messageId"] === messageId,
  )
}

export function ChatView({ conversationId, focusMessageId }: ChatViewProps) {
  const { state, loadOlder, revokeMessage } = useStore()
  const rosterView = useMemo(() => buildRosterView(state.roster), [state.roster])
  const messages = state.messages.get(conversationId) ?? EMPTY_MESSAGES
  const messagesLoaded = state.messages.has(conversationId)
  const conversation = state.conversations.find((item) => item.id === conversationId)
  const title = conversationTitle(conversation, rosterView)
  const isGroup = conversation?.kind === "group"
  const isGroupChat = isGroup && conversation?.key !== "shout"

  const scrollRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const nearBottomRef = useRef(true)
  const handledFocusRef = useRef<string | null>(null)
  const focusPagesRef = useRef(0)
  const highlightTimerRef = useRef<number | undefined>(undefined)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [focusMiss, setFocusMiss] = useState<string | null>(null)
  const [showGroupInfo, setShowGroupInfo] = useState(false)

  const scrollToBottom = useCallback((): void => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [])

  // 切换会话：重置分页游标 / 高亮 / 深链进度 / 撤回错误，并滚到底部；
  // 卸载/切会话时清掉高亮计时器（复审 I1）。草稿由 `Composer key` 重挂载自复位。
  useEffect(() => {
    hasMoreRef.current = true
    nearBottomRef.current = true
    handledFocusRef.current = null
    focusPagesRef.current = 0
    setRevokingId(null) // 切会话清撤回中态（评审 Minor #4）：避免旧会话的「撤回中…」残留
    setRevokeError(null)
    setHighlightId(null)
    setFocusMiss(null)
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

  // 深链定位（F2）：目标已加载 → 滚动 + 高亮 2s；未加载 → 有界向前分页；
  // 历史耗尽仍未命中 → 显式提示「消息不可定位」（不静默）。
  // 高亮计时器存 ref 且**不注册 effect cleanup**——2s 窗口内任何 refetch 换了 `messages`
  // 引用都不得取消/延长高亮；清除只由计时器或会话切换/卸载触发（复审 I1）。
  useEffect(() => {
    if (focusMessageId === null || handledFocusRef.current === focusMessageId) return
    if (!messagesLoaded) return // 历史尚未载入：等待，勿误判不可定位
    if (messages.some((message) => message.id === focusMessageId)) {
      handledFocusRef.current = focusMessageId
      setFocusMiss(null)
      setHighlightId(focusMessageId)
      const target = findMessageNode(scrollRef.current, focusMessageId)
      if (target !== undefined) target.scrollIntoView({ block: "center" })
      if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightId(null)
        highlightTimerRef.current = undefined
      }, HIGHLIGHT_MS)
      return
    }
    // 未加载：有界向前分页（找到即停；页耗尽或已达上限 → 判定不可定位）。
    const exhausted = focusPagesRef.current >= MAX_FOCUS_PAGES || !hasMoreRef.current
    const earliest = messages[0]
    if (exhausted || messages.length < PAGE_SIZE || earliest === undefined) {
      handledFocusRef.current = focusMessageId
      setFocusMiss(focusMessageId)
      return
    }
    focusPagesRef.current += 1
    void loadOlder(conversationId, earliest.seq)
      .then((count) => {
        if (count < PAGE_SIZE) hasMoreRef.current = false
      })
      .catch(() => {
        hasMoreRef.current = false
      })
  }, [focusMessageId, messages, messagesLoaded, conversationId, loadOlder])

  // 发送成功：贴底跟随（Composer 持有草稿/发送态，本层只管滚动）。
  const onSent = useCallback((): void => {
    nearBottomRef.current = true
    requestAnimationFrame(scrollToBottom)
  }, [scrollToBottom])

  // 撤回：成功经 store 动作重拉该会话消息（带出 revoked_at / 系统提醒），失败行内提示。
  const onRevoke = useCallback(
    (messageId: string): void => {
      setRevokingId(messageId)
      setRevokeError(null)
      void revokeMessage(conversationId, messageId)
        .catch(() => setRevokeError("撤回失败，请重试。"))
        .finally(() => setRevokingId(null))
    },
    [conversationId, revokeMessage],
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
        {focusMiss !== null && focusMiss === focusMessageId ? (
          <p className="chat-focus-miss" role="status" data-testid="focus-missing">
            消息不可定位
          </p>
        ) : null}
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
                card={readCardMessage(message)}
                revoking={revokingId === message.id}
                onRevoke={() => onRevoke(message.id)}
              />
            ))}
          </ul>
        )}
      </div>
      {revokeError !== null ? (
        <p className="chat-revoke-error" role="alert" data-testid="revoke-error">
          {revokeError}
        </p>
      ) : null}
      <Composer key={conversationId} conversationId={conversationId} onSent={onSent} />
      {isGroupChat && showGroupInfo ? (
        <GroupInfo conversationId={conversationId} onClose={() => setShowGroupInfo(false)} />
      ) : null}
    </section>
  )
}
