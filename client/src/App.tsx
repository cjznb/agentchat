import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RosterNode } from "../../shared/contracts"
import { unreadCount } from "./cards"
import { ChatView } from "./components/ChatView"
import { ContactCard } from "./components/ContactCard"
import { ConversationList } from "./components/ConversationList"
import { GroupCreate } from "./components/Groups"
import { NotificationAside, NotificationsView } from "./components/Notifications"
import { OrgTree } from "./components/OrgTree"
import { Settings } from "./components/Settings"
import { ShoutView } from "./components/Shout"
import { parseDeepLink } from "./deeplink"
import { useStore } from "./store"
import { isContainerNode } from "./treeFold"
import type { ConnectionStatus } from "./ws"

const modes = [
  { id: "chat", label: "聊天", glyph: "聊", title: "会话", hint: "选择一个 Agent，开始查看消息。" },
  { id: "contacts", label: "通讯录", glyph: "联", title: "Agent 树", hint: "点选节点查看资料卡与参与会话。" },
  { id: "notifications", label: "通知", glyph: "铃", title: "通知中心", hint: "审批与批示集中在这里。" },
  { id: "shout", label: "喊话", glyph: "播", title: "全员喊话", hint: "面向全部 Agent 发布一条消息。" },
  { id: "settings", label: "设置", glyph: "设", title: "设置", hint: "查看数据位置，或清除本地状态、恢复出厂设置。" },
] as const

type ModeId = (typeof modes)[number]["id"]
type ContentState = "loading" | "empty" | "error"

const listCopy = {
  chat: { title: "最近会话", detail: "还没有会话" },
  contacts: { title: "Agent 层级", detail: "等待 Agent 加入" },
  notifications: { title: "通知中心", detail: "没有需要处理的单据" },
  shout: { title: "广播记录", detail: "还没有喊话" },
  settings: { title: "设置", detail: "数据位置与恢复出厂设置" },
} as const satisfies Record<ModeId, { readonly title: string; readonly detail: string }>

const connectionLabel = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  resync: "同步中",
  retrying: "后台重试中",
  error: "连接失败",
} as const satisfies Record<ConnectionStatus, string>

function StatePanel({
  state,
  title,
  hint,
  onRetry,
}: {
  readonly state: ContentState
  readonly title: string
  readonly hint: string
  readonly onRetry: () => void
}) {
  if (state === "loading") {
    return <section className="state-panel" role="status"><span className="state-mark is-loading" /><h2>正在载入</h2><p>正在同步 AgentChat 数据。</p></section>
  }
  if (state === "error") {
    return (
      <section className="state-panel is-error" role="alert" data-testid="state-panel-error">
        <span className="state-mark">!</span>
        <h2>暂时无法连接</h2>
        <p>请确认 Hub 已启动后重试。</p>
        <button type="button" className="state-retry" data-testid="state-retry" onClick={onRetry}>重试</button>
      </section>
    )
  }
  return <section className="state-panel"><span className="state-mark">+</span><h2>{title}</h2><p>{hint}</p></section>
}

/** 在 roster 森林中按 id 定位节点（资料卡数据源）。 */
function findRosterNode(nodes: readonly RosterNode[], id: string): RosterNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findRosterNode(node.children, id)
    if (found !== null) return found
  }
  return null
}

export function App() {
  const { state, openConversation, openAndRead, openDm, reload, retry } = useStore()
  const [activeMode, setActiveMode] = useState<ModeId>("chat")
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [contactActionError, setContactActionError] = useState<string | null>(null)
  const [composeGroup, setComposeGroup] = useState(false)
  const active = modes.find((mode) => mode.id === activeMode) ?? modes[0]
  const list = listCopy[activeMode]
  const openId = state.openConversationId
  const openSummary = state.conversations.find((item) => item.id === openId)
  const shoutConversationId = state.conversations.find((item) => item.key === "shout")?.id ?? null
  const selectedContact = useMemo(
    () => (selectedContactId === null ? null : findRosterNode(state.roster, selectedContactId)),
    [state.roster, selectedContactId],
  )
  const deepLink = useMemo(
    () => parseDeepLink(typeof window === "undefined" ? "" : window.location.search),
    [],
  )
  // 通知跳转目标：初值取挂载时深链 `?msg=`，条目标记后由 `handleJump` 改写（ChatView 滚动 + 高亮）。
  const [focusMessageId, setFocusMessageId] = useState<string | null>(deepLink.messageId)
  const deepLinkApplied = useRef(false)
  // rail「通知」徽标 = actionable 未读数（未读 = `readAt` 为空）；0 → 隐藏。
  const notificationBadge = unreadCount(state.notifications)
  // 首屏/重连期间数据未就绪：空态面板显示加载态（真实可达路径，替代 T2 不可达骨架）。
  const initialSync = state.connection !== "connected"
  // 错误态真实可达：REST 重拉失败（`loadError`）或连接失败/后台重试（`retrying`，缺陷 B——不再永久无提示）。
  const disconnected = state.connection === "error" || state.connection === "retrying"
  const contentState: ContentState =
    state.loadError || disconnected ? "error" : initialSync ? "loading" : "empty"

  // 深链入口（spec §11.5）：挂载时带 `?conversation=` 则自动承载该会话（消息由其内部重拉）。
  useEffect(() => {
    if (deepLinkApplied.current) return
    deepLinkApplied.current = true
    if (deepLink.conversationId !== null) openConversation(deepLink.conversationId)
  }, [deepLink.conversationId, openConversation])

  // 通知条目跳转：打开会话（按需载入消息 + 标已读）→ 切聊天视图 → 定位卡消息；并同步地址栏深链。
  const handleJump = useCallback(
    (conversationId: string, messageId: string) => {
      openAndRead(conversationId)
      setFocusMessageId(messageId)
      setActiveMode("chat")
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href)
        url.searchParams.set("conversation", conversationId)
        url.searchParams.set("msg", messageId)
        window.history.replaceState(null, "", url.toString())
      }
    },
    [openAndRead],
  )

  // 选中/关闭资料卡：同步清掉上次的操作错误。
  const selectContact = useCallback((id: string | null) => {
    setContactActionError(null)
    setSelectedContactId(id)
  }, [])

  // 资料卡「发消息」：确保 DM 后切到聊天视图；失败（含退役目标 409）显示错误且不切视图（F3③）。
  // 容器节点（`isContainerNode`）不可 DM 作聊天对象（spec §11.2 Task 2）。
  const handleMessage = useCallback(
    (nodeId: string) => {
      const target = findRosterNode(state.roster, nodeId)
      if (target !== null && isContainerNode(target)) {
        setContactActionError("这是分组容器，不能发起私聊。")
        return
      }
      setContactActionError(null)
      void openDm(nodeId)
        .then(() => {
          setActiveMode("chat")
          setSelectedContactId(null)
        })
        .catch(() => setContactActionError("无法发起会话，对方可能已退役或连接失败。"))
    },
    [openDm, state.roster],
  )

  // 资料卡「查看它的会话」条目：打开该会话并切到聊天视图。
  const handleOpenConversation = useCallback(
    (conversationId: string) => {
      openAndRead(conversationId)
      setActiveMode("chat")
      setSelectedContactId(null)
    },
    [openAndRead],
  )

  // 建群成功：关面板、切聊天、重拉会话列表（新群可见）并打开新会话。
  const handleGroupCreated = useCallback(
    (conversationId: string) => {
      setComposeGroup(false)
      setActiveMode("chat")
      reload({
        roster: false,
        conversations: true,
        notifications: false,
        approvals: false,
        messages: [],
      })
      openAndRead(conversationId)
    },
    [openAndRead, reload],
  )

  return (
    <main className="app-shell" data-testid="app-shell">
      <nav className="mode-rail" aria-label="主要功能" data-testid="icon-rail">
        <div className="brand-mark" aria-label="AgentChat" role="img">AC</div>
        <div className="rail-actions">
          {modes.map((mode) => (
            <button className="rail-button" data-active={mode.id === activeMode} aria-pressed={mode.id === activeMode} key={mode.id} onClick={() => { setActiveMode(mode.id); if (mode.id !== "chat") setComposeGroup(false) }} type="button">
              <span className="rail-glyph" aria-hidden="true">{mode.glyph}</span>
              <span>{mode.label}</span>
              {mode.id === "notifications" && notificationBadge > 0 ? (
                <span className="rail-badge" data-testid="notification-badge">{notificationBadge}</span>
              ) : null}
            </button>
          ))}
        </div>
        <span className="hub-status" data-testid="connection-badge" data-state={state.connection}>
          <i aria-hidden="true" />{connectionLabel[state.connection]}
        </span>
      </nav>

      <aside className="context-list" aria-labelledby="context-title" data-testid="middle-list">
        <header><p>AGENTCHAT</p><h1 id="context-title">{list.title}</h1></header>
        {activeMode === "contacts" ? (
          <OrgTree selectedId={selectedContactId} onSelect={selectContact} />
        ) : activeMode === "chat" ? (
          <ConversationList onCreateGroup={() => setComposeGroup(true)} />
        ) : activeMode === "notifications" ? (
          <NotificationAside />
        ) : (
          <div className="list-empty"><span aria-hidden="true">—</span><p>{list.detail}</p><small>数据接入将在后续任务完成</small></div>
        )}
      </aside>

      <section className="work-view" aria-labelledby="view-title" data-testid="right-view">
        {activeMode === "notifications" ? (
          <NotificationsView onJump={handleJump} />
        ) : activeMode === "shout" ? (
          <ShoutView conversationId={shoutConversationId} />
        ) : activeMode === "settings" ? (
          <Settings />
        ) : activeMode === "chat" && composeGroup ? (
          <GroupCreate onCancel={() => setComposeGroup(false)} onCreated={handleGroupCreated} />
        ) : activeMode === "chat" && openId !== null ? (
          openSummary?.key === "shout" ? (
            <ShoutView conversationId={openId} />
          ) : (
            <ChatView conversationId={openId} focusMessageId={focusMessageId} />
          )
        ) : (
          <>
            <header className="view-header"><div><p>当前视图</p><h1 id="view-title">{active.title}</h1></div><span className="mode-code">{active.id.toUpperCase()}</span></header>
            <div className="view-body">
              {activeMode === "contacts" && selectedContact !== null ? (
                <ContactCard
                  node={selectedContact}
                  onClose={() => selectContact(null)}
                  onMessage={handleMessage}
                  onOpenConversation={handleOpenConversation}
                  actionError={contactActionError}
                />
              ) : (
                <StatePanel state={contentState} title={active.title} hint={active.hint} onRetry={retry} />
              )}
            </div>
          </>
        )}
      </section>
    </main>
  )
}
