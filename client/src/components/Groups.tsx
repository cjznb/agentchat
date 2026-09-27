/**
 * 建群面板（spec §11.4「群创建：通讯录多选」；Plan 3 T7）。
 *
 * - 从组织树多选成员（含子 agent 与逻辑节点；human 由 `MemberPicker`/`foldTree` 过滤）
 * - `POST /api/groups {name, member_ids}`；human 提交即时生效（零审批）
 * - 空名 / 空选禁用提交；失败提示可重试
 */
import { useCallback, useState } from "react"
import { createGroup } from "../api"
import { MemberPicker } from "./MemberPicker"

export interface GroupCreateProps {
  readonly onCancel: () => void
  readonly onCreated: (conversationId: string) => void
}

export function GroupCreate({ onCancel, onCreated }: GroupCreateProps) {
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<readonly string[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback((nodeId: string) => {
    setSelected((previous) =>
      previous.includes(nodeId) ? previous.filter((id) => id !== nodeId) : [...previous, nodeId],
    )
  }, [])

  const canSubmit = name.trim().length > 0 && selected.length > 0 && !sending

  const submit = useCallback(() => {
    if (name.trim().length === 0 || selected.length === 0 || sending) return
    setSending(true)
    setError(null)
    void createGroup(name.trim(), selected)
      .then((result) => {
        if ("group" in result) {
          onCreated(result.group.id)
          return
        }
        setError("已提交审批，待批准后生效。")
      })
      .catch(() => setError("建群失败，请重试。"))
      .finally(() => setSending(false))
  }, [name, selected, sending, onCreated])

  return (
    <section className="group-create" data-testid="group-create">
      <header className="group-head">
        <div>
          <p>新群聊</p>
          <h1 id="view-title">创建群聊</h1>
        </div>
        <button className="group-cancel" data-testid="group-cancel" onClick={onCancel} type="button">
          取消
        </button>
      </header>
      <div className="group-body">
        <label className="group-name">
          <span>群聊名称</span>
          <input
            className="group-name-input"
            data-testid="group-name-input"
            value={name}
            placeholder="例如：发布协调群"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="group-picker">
          <p className="group-picker-title">从通讯录选择成员</p>
          <MemberPicker selected={selected} onToggle={toggle} />
        </div>
      </div>
      <footer className="group-foot">
        <span className="member-count" data-testid="member-count">
          已选 {selected.length} 名
        </span>
        {error !== null ? (
          <p className="group-error" role="alert" data-testid="group-error">
            {error}
          </p>
        ) : null}
        <button
          className="group-submit"
          data-testid="group-create-submit"
          type="button"
          disabled={!canSubmit}
          onClick={submit}
        >
          建群
        </button>
      </footer>
    </section>
  )
}
