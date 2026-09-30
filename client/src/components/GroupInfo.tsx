/**
 * 群资料面板（spec §11.4「群创建/拉人：群资料页 +」；Plan 3 T7）——`GET /api/groups` 取群 + 成员，
 * 成员按所属根树状展示（`groups.groupMembers`），下拉拉人 `POST /api/groups/:id/members`。
 * 添加成功后重拉群列表 → 成员树即时更新。
 */
import { useCallback, useEffect, useState } from "react"
import type { GroupEntry } from "../../../shared/contracts"
import { addGroupMember, listGroups } from "../api"
import { useRenameEditor } from "../actions"
import { vendorBadge } from "../chat"
import { addableMembers, groupMembers } from "../groups"
import { useStore } from "../store"
import { statusGlyph, statusLabel } from "../treeFold"

export interface GroupInfoProps {
  readonly conversationId: string
  readonly onClose: () => void
}

export function GroupInfo({ conversationId, onClose }: GroupInfoProps) {
  const { state } = useStore()
  const [entry, setEntry] = useState<GroupEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState("")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const rename = useRenameEditor()

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    listGroups()
      .then((groups) => setEntry(groups.find((group) => group.id === conversationId) ?? null))
      .catch(() => setError("群资料载入失败。"))
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const groups = entry === null ? [] : groupMembers(entry.members, state.roster)
  const options = entry === null ? [] : addableMembers(state.roster, entry.members)
  const memberTotal = groups.reduce((sum, group) => sum + group.members.length, 0)

  const add = useCallback(() => {
    if (pick === "" || adding) return
    setAdding(true)
    setAddError(null)
    void addGroupMember(conversationId, pick)
      .then((result) => {
        if ("approval" in result) {
          setAddError("已提交审批，待批准后生效。")
          return
        }
        setPick("")
        refresh()
      })
      .catch(() => setAddError("添加失败，请重试。"))
      .finally(() => setAdding(false))
  }, [pick, adding, conversationId, refresh])

  return (
    <aside className="group-info" data-testid="group-info" aria-label="群资料">
      <header className="group-info-head">
        <div>
          <p>群资料</p>
          <h2 data-testid="group-info-name">{entry?.name ?? "群聊"}</h2>
        </div>
        <button
          className="group-info-close"
          data-testid="group-info-close"
          aria-label="关闭群资料"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <p className="group-info-count" data-testid="group-member-count">
        成员 {memberTotal}
      </p>
      {loading ? <p className="group-info-note">载入中…</p> : null}
      {error !== null ? (
        <p className="group-info-error" role="alert" data-testid="group-info-error">
          {error}
        </p>
      ) : null}
      {entry !== null && groups.length === 0 ? (
        <p className="group-info-note" data-testid="group-member-empty">
          暂无其他成员
        </p>
      ) : null}
      {groups.map((group) => (
        <section className="member-group" key={group.rootId} data-testid="member-group">
          <h3 className="member-group-head">{group.rootName}</h3>
          <ul className="member-list">
            {group.members.map((member) => (
              <li
                className="member-item"
                data-testid="group-member"
                data-node-id={member.id}
                key={member.id}
              >
                <span
                  className={member.kind === "logical" ? "member-icon is-logical" : "member-icon"}
                  data-vendor={member.vendor}
                  aria-hidden="true"
                >
                  {member.kind === "logical" ? "◆" : vendorBadge(member.vendor)}
                </span>
                <span className="member-name">{rename.renamed(member.id) ?? member.name}</span>
                <i
                  className="node-dot"
                  role="img"
                  aria-label={statusLabel(member.status)}
                  title={statusLabel(member.status)}
                >
                  {statusGlyph(member.status)}
                </i>
                {rename.targetId === member.id ? (
                  <form className="member-rename-form" data-testid="member-rename-form" onSubmit={rename.submit}>
                    <input
                      className="member-rename-input"
                      data-testid="member-rename-input"
                      aria-label="新展示名"
                      value={rename.draft}
                      onChange={(event) => rename.setDraft(event.target.value)}
                    />
                    <button
                      className="member-rename-submit"
                      data-testid="member-rename-submit"
                      type="submit"
                      disabled={rename.busy || rename.draft.trim() === ""}
                    >
                      保存
                    </button>
                    <button
                      className="member-rename-cancel"
                      data-testid="member-rename-cancel"
                      type="button"
                      disabled={rename.busy}
                      onClick={rename.cancel}
                    >
                      取消
                    </button>
                    {rename.error !== null ? (
                      <p className="group-info-error" role="alert" data-testid="member-rename-error">
                        {rename.error}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <button
                    className="member-rename"
                    data-testid="member-rename"
                    aria-label="修改展示名"
                    title="修改展示名"
                    onClick={() => rename.start(member.id, rename.renamed(member.id) ?? member.name)}
                    type="button"
                  >
                    ✎
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="group-add">
        <label className="group-add-field">
          <span>添加成员</span>
          <select
            className="group-add-select"
            data-testid="group-add-select"
            value={pick}
            disabled={options.length === 0 || adding}
            onChange={(event) => setPick(event.target.value)}
          >
            <option value="">选择节点…</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="group-add-button"
          data-testid="group-add-submit"
          type="button"
          disabled={pick === "" || adding}
          onClick={add}
        >
          添加
        </button>
      </div>
      {addError !== null ? (
        <p className="group-info-error" role="alert" data-testid="group-add-error">
          {addError}
        </p>
      ) : null}
    </aside>
  )
}
