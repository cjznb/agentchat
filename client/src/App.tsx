import { useState } from "react"
import { ConversationList } from "./components/ConversationList"
import { useStore } from "./store"
import type { ConnectionStatus } from "./ws"

const modes = [
  { id: "chat", label: "聊天", glyph: "聊", title: "会话", hint: "选择一个 Agent，开始查看消息。" },
  { id: "contacts", label: "通讯录", glyph: "联", title: "Agent 树", hint: "Agent 层级将在这里展开。" },
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

export function App() {
  const { state } = useStore()
  const [activeMode, setActiveMode] = useState<ModeId>("chat")
  const active = modes.find((mode) => mode.id === activeMode) ?? modes[0]
  const list = listCopy[activeMode]
  const showConversations = activeMode === "chat" && state.conversations.length > 0

  return (
    <main className="app-shell" data-testid="app-shell">
      <nav className="mode-rail" aria-label="主要功能" data-testid="icon-rail">
        <div className="brand-mark" aria-label="AgentChat" role="img">AC</div>
        <div className="rail-actions">
          {modes.map((mode) => (
            <button className="rail-button" data-active={mode.id === activeMode} aria-pressed={mode.id === activeMode} key={mode.id} onClick={() => setActiveMode(mode.id)} type="button">
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
        {showConversations ? (
          <ConversationList />
        ) : (
          <div className="list-empty"><span aria-hidden="true">—</span><p>{list.detail}</p><small>数据接入将在后续任务完成</small></div>
        )}
      </aside>

      <section className="work-view" aria-labelledby="view-title" data-testid="right-view">
        <header className="view-header"><div><p>当前视图</p><h1 id="view-title">{active.title}</h1></div><span className="mode-code">{active.id.toUpperCase()}</span></header>
        <div className="view-body"><StatePanel state="empty" title={active.title} hint={active.hint} /></div>
      </section>
    </main>
  )
}
