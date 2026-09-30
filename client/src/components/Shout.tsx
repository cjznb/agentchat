/**
 * 喊话频道视图（spec §11.4「喊话频道：`*` 寻址可视化，发出后显示每节点投递汇总」；Plan 3 T7）。
 *
 * - 发送经 `POST /api/shout`（human 即时执行），消息入既有喊话广播会话
 * - 逐节点投递汇总由 `summarizeShout` 纯函数聚合会话内**最新己方消息**的逐收件方回执：
 *   随 WS `receipt` 事件触发的消息重拉自动刷新（`planReload` 对已加载会话重拉）
 * - 汇总以「投递带」呈现：按 在线 / 排队 / 离场 占比分段 + 读数
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { ChatMessage } from "../../../shared/contracts"
import { buildRosterView } from "../chat"
import { summarizeShout, type ShoutSummary } from "../shout"
import { useStore } from "../store"
import { MessageBubble } from "./MessageBubble"

const EMPTY_MESSAGES: readonly ChatMessage[] = []

export interface ShoutViewProps {
  /** 喊话广播会话 id；尚无喊话时会话不存在（null），首条发送后由返回值补齐。 */
  readonly conversationId: string | null
}

function DeliverySummary({ summary }: { readonly summary: ShoutSummary }) {
  const segments = [
    { bucket: "online", count: summary.online },
    { bucket: "queued", count: summary.queued },
    { bucket: "left", count: summary.left },
  ].filter((segment) => segment.count > 0)
  return (
    <section className="delivery" data-testid="shout-summary" aria-label="逐节点投递汇总">
      <p className="delivery-label">投递汇总</p>
      <div className="delivery-ribbon" aria-hidden="true">
        {segments.length === 0 ? <span className="delivery-seg is-empty" /> : null}
        {segments.map((segment) => (
          <span
            key={segment.bucket}
            className="delivery-seg"
            data-bucket={segment.bucket}
            style={{ flexGrow: segment.count }}
          />
        ))}
      </div>
      <dl className="delivery-readout">
        <div data-bucket="online">
          <dt>在线</dt>
          <dd data-testid="shout-online">{summary.online}</dd>
        </div>
        <div data-bucket="queued">
          <dt>排队</dt>
          <dd data-testid="shout-queued">{summary.queued}</dd>
        </div>
        <div data-bucket="left">
          <dt>离场</dt>
          <dd data-testid="shout-left">{summary.left}</dd>
        </div>
        {summary.unknown > 0 ? (
          <div data-bucket="unknown">
            <dt>其他</dt>
            <dd data-testid="shout-unknown">{summary.unknown}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  )
}

export function ShoutView({ conversationId }: ShoutViewProps) {
  const { state, reload, shoutBroadcast } = useStore()
  const [sentId, setSentId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeId = conversationId ?? sentId
  const rosterView = useMemo(() => buildRosterView(state.roster), [state.roster])
  const messages =
    activeId === null ? EMPTY_MESSAGES : (state.messages.get(activeId) ?? EMPTY_MESSAGES)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)

  const summary = useMemo(() => {
    const latest = [...messages]
      .reverse()
      .find((message) => message.receipts !== undefined && message.receipts.length > 0)
    return latest?.receipts === undefined ? null : summarizeShout(latest.receipts)
  }, [messages])

  // 已有喊话会话但尚未载入消息 → 拉一页（含己方回执）以便汇总与列表渲染。
  useEffect(() => {
    if (activeId === null || state.messages.has(activeId)) return
    reload({
      roster: false,
      conversations: false,
      notifications: false,
      approvals: false,
      messages: [activeId],
    })
  }, [activeId, state.messages, reload])

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, summary])

  const submit = useCallback(() => {
    // 同步 ref 锁（F4②）：异步 state 更新前的同帧双击不得重复提交。
    if (draft.trim().length === 0 || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    void shoutBroadcast(draft)
      .then((result) => {
        if (!("message" in result)) {
          setError("已提交审批，待批准后生效。")
          return
        }
        setDraft("")
        setSentId(result.message.conversationId)
      })
      .catch(() => setError("发送失败，请重试。"))
      .finally(() => {
        sendingRef.current = false
        setSending(false)
      })
  }, [draft, shoutBroadcast])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    <section className="shout-view" data-testid="shout-view">
      <header className="chat-header">
        <div>
          <p>喊话频道</p>
          <h1 id="view-title">全员喊话</h1>
        </div>
        <span className="shout-reach" data-testid="shout-reach">
          全部节点
        </span>
      </header>
      <div className="chat-scroll" data-testid="shout-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="chat-empty">还没有喊话，向所有节点发第一条。</p>
        ) : (
          <ul className="message-list" data-testid="shout-list">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                participants={Array.from(rosterView.byId.values(), ({ id, name }) => ({ id, name }))}
              own={rosterView.humanId !== null && message.fromAgentId === rosterView.humanId}
                sender={rosterView.byId.get(message.fromAgentId)}
                showSender
                highlighted={false}
                card={null}
              />
            ))}
          </ul>
        )}
      </div>
      {summary !== null ? <DeliverySummary summary={summary} /> : null}
      <form
        className="composer"
        data-testid="shout-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          className="composer-input"
          data-testid="shout-input"
          aria-label="喊话输入框"
          placeholder="向所有节点喊话，回车发送，Shift+回车换行"
          value={draft}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="composer-send"
          data-testid="shout-send"
          type="submit"
          disabled={draft.trim().length === 0 || sending}
        >
          发送
        </button>
        {error !== null ? (
          <p className="composer-error" role="alert" data-testid="shout-error">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  )
}
