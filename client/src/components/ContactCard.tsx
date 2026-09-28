/**
 * 节点资料卡（spec §11.1/§11.2；Plan 3 T6）——点击组织树节点后的悬浮卡。
 *
 * - 字段：名字 / 厂商+模型 / 状态(+`status_text`) / `role_tag` / 备注 / 工作概述 / 技能 chips
 * - 操作：`发消息`（确保 human↔节点 DM 并打开）、`查看它的会话`（该节点参与会话的过滤视图）
 * - 会话来自 `GET /api/agents/:id`（`agentCard.conversations`），点条目经 `onOpenConversation` 打开
 * - 退役节点：`发消息` 禁用（不可开聊），仍可查看资料与会话
 * - **容器节点**（`role_tag === "container"`）：隐藏 `发消息`，显示「容器」徽标与
 *   「分组容器，不是聊天对象」说明；仅 `查看它的会话` 可用。
 */
import { useCallback, useEffect, useState } from "react"
import type { AgentCard, RosterNode } from "../../../shared/contracts"
import { loadAgentCard } from "../api"
import { initialOf } from "../chat"
import { roleTone, statusGlyph, statusLabel } from "../treeFold"

type ContactConversation = AgentCard["conversations"][number]

export interface ContactCardProps {
  readonly node: RosterNode
  readonly onClose: () => void
  readonly onMessage: (nodeId: string) => void
  readonly onOpenConversation: (conversationId: string) => void
  /** 「发消息」失败（含退役目标 409）时的错误文案；不切空视图，仅就地提示（F3）。 */
  readonly actionError?: string | null
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="contact-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function ContactCard({
  node,
  onClose,
  onMessage,
  onOpenConversation,
  actionError = null,
}: ContactCardProps) {
  const [showConversations, setShowConversations] = useState(false)
  const [conversations, setConversations] = useState<readonly ContactConversation[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 切换节点：重置过滤视图（含已载入会话）。
  useEffect(() => {
    setShowConversations(false)
    setConversations(null)
    setError(null)
  }, [node.id])

  // 首次展开过滤视图时惰性载入该节点参与的会话。
  useEffect(() => {
    if (!showConversations || conversations !== null) return
    let cancelled = false
    setLoading(true)
    loadAgentCard(node.id)
      .then((card) => {
        if (!cancelled) setConversations(card.conversations)
      })
      .catch(() => {
        if (!cancelled) setError("会话列表载入失败。")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showConversations, conversations, node.id])

  const toggleConversations = useCallback(() => setShowConversations((value) => !value), [])
  const retired = node.status === "retired"
  const isContainer = node.role_tag === "container"
  const role = roleTone(node.role_tag)
  const skills = node.skills

  return (
    <aside
      className="contact-card"
      data-testid="contact-card"
      data-node-id={node.id}
      data-vendor={node.vendor}
      data-retired={retired}
      aria-label={`${node.name} 资料卡`}
    >
      <header className="contact-head">
        <span className="contact-avatar" data-vendor={node.vendor} aria-hidden="true">
          {initialOf(node.name)}
        </span>
        <div className="contact-ident">
          <p className="contact-kind">{node.kind === "logical" ? "逻辑节点" : "运行时节点"}</p>
          <h2 data-testid="contact-name">{node.name}</h2>
        </div>
        <button
          className="contact-close"
          data-testid="contact-close"
          aria-label="关闭资料卡"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>

      <p className="contact-sub">
        <span className="vendor-badge" data-testid="contact-vendor">
          {node.vendor}
        </span>
        <span className="contact-model" data-testid="contact-model">
          {node.model}
        </span>
      </p>

      <p className="contact-status" data-status={node.status} data-testid="contact-status">
        <i aria-hidden="true">{statusGlyph(node.status)}</i>
        <span>{statusLabel(node.status)}</span>
        {node.status_text !== null && !retired ? (
          <span className="contact-status-text" data-testid="contact-status-text">
            {node.status_text}
          </span>
        ) : null}
      </p>

      <dl className="contact-fields">
        <Field label="角色标签">
          {role === "none" ? (
            <span className="contact-empty">未设置</span>
          ) : (
            <span className="role-tag" data-tone={role} data-testid="contact-role">
              {node.role_tag}
            </span>
          )}
        </Field>
        <Field label="用户备注">
          {node.remark === null ? <span className="contact-empty">无</span> : node.remark}
        </Field>
        <Field label="工作概述">
          {node.purpose === null ? <span className="contact-empty">无</span> : node.purpose}
        </Field>
      </dl>

      <section className="contact-skills">
        <h3>技能</h3>
        {skills.length > 0 ? (
          <ul className="skill-chips" data-testid="contact-skills">
            {skills.map((skill) => (
              <li className="skill-chip" key={skill}>
                {skill}
              </li>
            ))}
          </ul>
        ) : (
          <p className="contact-empty">暂无技能</p>
        )}
      </section>

      <div className="contact-actions">
        {isContainer ? (
          <p className="contact-container-note" data-testid="contact-container-note">
            <span className="container-badge" title="分组容器，不是聊天对象">
              容器
            </span>
            这是分组容器，不能发起对话。
          </p>
        ) : (
          <button
            className="contact-action is-primary"
            data-testid="contact-message"
            disabled={retired}
            onClick={() => onMessage(node.id)}
            type="button"
          >
            发消息
          </button>
        )}
        <button
          className="contact-action"
          data-testid="contact-conversations"
          aria-pressed={showConversations}
          onClick={toggleConversations}
          type="button"
        >
          查看它的会话
        </button>
      </div>

      {actionError !== null ? (
        <p className="contact-error" role="alert" data-testid="contact-action-error">
          {actionError}
        </p>
      ) : null}

      {showConversations ? (
        <section className="contact-conversations" data-testid="contact-conversation-list">
          {loading ? <p className="contact-empty">载入中…</p> : null}
          {error !== null ? (
            <p className="contact-error" role="alert" data-testid="contact-error">
              {error}
            </p>
          ) : null}
          {conversations !== null && conversations.length === 0 ? (
            <p className="contact-empty">暂无参与会话</p>
          ) : null}
          {conversations !== null && conversations.length > 0 ? (
            <ul>
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    className="contact-conversation"
                    data-testid="contact-conversation"
                    data-conversation-id={conversation.id}
                    onClick={() => onOpenConversation(conversation.id)}
                    type="button"
                  >
                    <span className="contact-conversation-kind">
                      {conversation.kind === "group" ? "群" : "私聊"}
                    </span>
                    <span>{conversation.name ?? "未命名会话"}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </aside>
  )
}
