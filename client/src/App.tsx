import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RosterNode } from "../../shared/contracts"
import { ChatView } from "./components/ChatView"
import { ContactCard } from "./components/ContactCard"
import { ConversationList } from "./components/ConversationList"
import { GroupCreate } from "./components/Groups"
import { OrgTree } from "./components/OrgTree"
import { ShoutView } from "./components/Shout"
import { parseDeepLink } from "./deeplink"
import { useStore } from "./store"
import type { ConnectionStatus } from "./ws"

const modes = [
  { id: "chat", label: "聊天", glyph: "聊", title: "会话", hint: "选择一个 Agent，开始查看消息。" },
  { id: "contacts", label: "通讯录", glyph: "联", title: "Agent 树", hint: "点选节点查看资料卡与参与会话。" },
  { id: "shout", label: "喊话", glyph: "播", title: "全员喊话", hint: "面向全部 Agent 发布一条消息。" },
] as const

type ModeId = (typeof modes)[number]["id"]
type ContentState = "loading" | "empty" | "error"

const listCopy = {
  chat: { title: "最近会话", detail: "还没有会话" },
  contacts: { title: "Agent 层级", detail: "等待 Agent 加入" },
  shout: { title: "广播记录", detail: "还没有喊话" },
} as const satisfies Record<ModeId, { readonly title: string; readonly detail: string }>

const connectionLabel = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  resync: "同步中",
} as const satisfies Record<ConnectionStatus, string>

function StatePanel({ state, title, hint }: { readonly state: ContentState; readonly title: string; readonly hint: string }) {
  if (state === "loading") {
    return <section className="state-panel" role="status"><span className="state-mark is-loading" /><h2>正在载入</h2><p>正在同步 AgentChat 数据。</p></section>
  }
  if (state === "error") {
    return <section className="state-panel is-error" role="alert"><span className="state-mark">!</span><h2>暂时无法连接</h2><p>请确认 Hub 已启动后重试。</p></section>
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
  const { state, openConversation, openAndRead, openDm, reload } = useStore()
  const [activeMode, setActiveMode] = useState<ModeId>("chat")
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
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
  const deepLinkApplied = useRef(false)

  // 深链入口（spec §11.5）：挂载时带 `?conversation=` 则自动承载该会话（消息由其内部重拉）。
  useEffect(() => {
    if (deepLinkApplied.current) return
    deepLinkApplied.current = true
    if (deepLink.conversationId !== null) openConversation(deepLink.conversationId)
  }, [deepLink.conversationId, openConversation])

  // 资料卡「发消息」：确保 DM 后切到聊天视图。
  const handleMessage = useCallback(
    (nodeId: string) => {
      void openDm(nodeId).then(() => {
        setActiveMode("chat")
        setSelectedContactId(null)
      })
    },
    [openDm],
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
          <OrgTree selectedId={selectedContactId} onSelect={setSelectedContactId} />
        ) : activeMode === "chat" ? (
          <ConversationList onCreateGroup={() => setComposeGroup(true)} />
        ) : (
          <div className="list-empty"><span aria-hidden="true">—</span><p>{list.detail}</p><small>数据接入将在后续任务完成</small></div>
        )}
      </aside>

      <section className="work-view" aria-labelledby="view-title" data-testid="right-view">
        {activeMode === "shout" ? (
          <ShoutView conversationId={shoutConversationId} />
        ) : activeMode === "chat" && composeGroup ? (
          <GroupCreate onCancel={() => setComposeGroup(false)} onCreated={handleGroupCreated} />
        ) : activeMode === "chat" && openId !== null ? (
          openSummary?.key === "shout" ? (
            <ShoutView conversationId={openId} />
          ) : (
            <ChatView conversationId={openId} focusMessageId={deepLink.messageId} />
          )
        ) : (
          <>
            <header className="view-header"><div><p>当前视图</p><h1 id="view-title">{active.title}</h1></div><span className="mode-code">{active.id.toUpperCase()}</span></header>
            <div className="view-body">
              {activeMode === "contacts" && selectedContact !== null ? (
                <ContactCard
                  node={selectedContact}
                  onClose={() => setSelectedContactId(null)}
                  onMessage={handleMessage}
                  onOpenConversation={handleOpenConversation}
                />
              ) : (
                <StatePanel state="empty" title={active.title} hint={active.hint} />
              )}
            </div>
          </>
        )}
      </section>
    </main>
  )
}
