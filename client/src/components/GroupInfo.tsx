/**
 * 群资料面板（spec §11.4「群创建/拉人：群资料页 +」；Plan 3 T7）——`GET /api/groups` 取群 + 成员，
 * 成员按所属根树状展示（`groups.groupMembers`），加成员 `POST /api/groups/:id/members`。
 * 添加成功后重拉群列表 → 成员树即时更新。
 *
 * 批次2 轮C (C2)：「添加成员」入口由内联 `<select>` 改为**模态弹窗**——遮罩 + 面板
 * 内嵌现有 `MemberPicker`（多选树原样复用），底栏确认/取消；确认走既有 addGroupMember
 * action（语义不变，仅搬家），取消 / Esc / 点遮罩关闭不提交。弹窗内 picker
 * max-height + 滚动，显示区域大于原内联面板。
 */
import { useCallback, useEffect, useState } from "react"
import type { GroupEntry } from "../../../shared/contracts"
import { addGroupMember, listGroups } from "../api"
import { useRenameEditor } from "../actions"
import { vendorBadge } from "../chat"
import { groupMembers } from "../groups"
import { useStore } from "../store"
import { statusGlyph, statusLabel } from "../treeFold"
import { MemberPicker } from "./MemberPicker"

export interface GroupInfoProps {
  readonly conversationId: string
  readonly onClose: () => void
}

export function GroupInfo({ conversationId, onClose }: GroupInfoProps) {
  const { state } = useStore()
  const [entry, setEntry] = useState<GroupEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // C2：添加成员弹窗（打开态 + 已选节点）。
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picked, setPicked] = useState<readonly string[]>([])
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
  const memberTotal = groups.reduce((sum, group) => sum + group.members.length, 0)

  const togglePick = useCallback((nodeId: string) => {
    setPicked((previous) =>
      previous.includes(nodeId) ? previous.filter((id) => id !== nodeId) : [...previous, nodeId],
    )
  }, [])

  /** 取消 / Esc / 遮罩：关闭弹窗并清空选择，不提交。 */
  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setPicked([])
  }, [])

  // 确认：复用既有加成员 action（addGroupMember 逐个提交，审批/错误/刷新语义不变）。
  const confirmAdd = useCallback(async () => {
    if (picked.length === 0 || adding) return
    setAdding(true)
    setAddError(null)
    try {
      for (const nodeId of picked) {
        const result = await addGroupMember(conversationId, nodeId)
        if ("approval" in result) {
          setAddError("已提交审批，待批准后生效。")
          return
        }
      }
      setPicked([])
      setPickerOpen(false)
      refresh()
    } catch {
      setAddError("添加失败，请重试。")
    } finally {
      setAdding(false)
    }
  }, [picked, adding, conversationId, refresh])

  // Esc 关闭弹窗（不提交）。
  useEffect(() => {
    if (!pickerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [pickerOpen, closePicker])

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
        <button
          className="group-add-button"
          data-testid="group-add-open"
          type="button"
          onClick={() => setPickerOpen(true)}
        >
          添加成员
        </button>
      </div>
      {pickerOpen ? (
        <div
          className="member-add-overlay"
          data-testid="member-add-overlay"
          onClick={closePicker}
        >
          <div
            className="member-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="添加成员"
            data-testid="member-add-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="member-add-head">
              <span>添加成员</span>
              <button
                className="member-add-close"
                data-testid="member-add-close"
                aria-label="关闭"
                onClick={closePicker}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="member-add-body">
              <MemberPicker selected={picked} onToggle={togglePick} />
            </div>
            <div className="member-add-foot">
              {addError !== null ? (
                <p className="group-info-error" role="alert" data-testid="group-add-error">
                  {addError}
                </p>
              ) : null}
              <button
                className="member-add-cancel"
                data-testid="member-add-cancel"
                type="button"
                onClick={closePicker}
              >
                取消
              </button>
              <button
                className="member-add-confirm"
                data-testid="member-add-confirm"
                type="button"
                disabled={picked.length === 0 || adding}
                onClick={() => {
                  void confirmAdd()
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
