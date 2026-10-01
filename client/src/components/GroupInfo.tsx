/**
 * 群资料面板（spec §11.4「群创建/拉人：群资料页 +」；Plan 3 T7）——`GET /api/groups` 取群 + 成员，
 * 成员按所属根树状展示（`groups.groupMembers`），加成员 `POST /api/groups/:id/members`。
 * 添加成功后重拉群列表 → 成员树即时更新。
 *
 * 批次2 轮C (C2)：「添加成员」入口由内联 `<select>` 改为**模态弹窗**——遮罩 + 面板
 * 内嵌现有 `MemberPicker`（多选树原样复用），底栏确认/取消；确认走既有 addGroupMember
 * action（语义不变，仅搬家），取消 / Esc / 点遮罩关闭不提交。弹窗内 picker
 * max-height + 滚动，显示区域大于原内联面板。
 *
 * 批次2 轮D (F2)：成员行 hover 可见「移出群聊」按钮（两步确认防误点）+ 底部 danger 区
 * 「解散群聊」（alertdialog 显式确认）；移除成功复用既有 refresh 回调，解散成功本地
 * 移除并回列表。
 *
 * 批次2 修复 (C1)：成员行（MemberRow）、添加弹窗（MemberAddDialog）、解散 danger 区
 * （GroupDangerZone）抽成子组件，本文件组合之；行为零变化。
 */
import { useCallback, useEffect, useState } from "react"
import type { GroupEntry } from "../../../shared/contracts"
import { listGroups, removeGroupMember } from "../api"
import { useRenameEditor } from "../actions"
import { groupMembers } from "../groups"
import { useStore } from "../store"
import { GroupDangerZone } from "./GroupDangerZone"
import { MemberAddDialog } from "./MemberAddDialog"
import { MemberRow } from "./MemberRow"

export interface GroupInfoProps {
  readonly conversationId: string
  readonly onClose: () => void
}

export function GroupInfo({ conversationId, onClose }: GroupInfoProps) {
  const { state } = useStore()
  const [entry, setEntry] = useState<GroupEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // C2：添加成员弹窗打开态（已选/提交态在 MemberAddDialog 内，卸载即清）。
  const [pickerOpen, setPickerOpen] = useState(false)
  // F2：移除成员（跨行互斥的待确认目标 + 面板级错误提示）。
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
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

  /** 取消 / Esc / 遮罩：关闭弹窗（弹窗卸载即清空选择，不提交）。 */
  const closePicker = useCallback(() => setPickerOpen(false), [])

  // 添加成功：关闭弹窗并重拉群列表（成员树即时更新）。
  const onAddSuccess = useCallback(() => {
    setPickerOpen(false)
    refresh()
  }, [refresh])

  // F2：两步确认后移除成员，成功复用既有 refresh 回调（成员树即时更新）。
  const confirmRemove = useCallback(
    async (nodeId: string) => {
      setRemoveError(null)
      try {
        await removeGroupMember(conversationId, nodeId)
        setRemovingId(null)
        refresh()
      } catch {
        setRemoveError("移除失败，请重试。")
      }
    },
    [conversationId, refresh],
  )

  // F2：解散成功 → 本地移除该会话并回到列表（onClose）。
  const onDissolveSuccess = useCallback(() => {
    setEntry(null)
    onClose()
  }, [onClose])

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
      {removeError !== null ? (
        <p className="group-info-error" role="alert" data-testid="group-remove-error">
          {removeError}
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
              <MemberRow
                key={member.id}
                member={member}
                rename={rename}
                removing={removingId === member.id}
                onRequestRemove={setRemovingId}
                onCancelRemove={() => setRemovingId(null)}
                onConfirmRemove={(nodeId) => {
                  void confirmRemove(nodeId)
                }}
              />
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
      <GroupDangerZone conversationId={conversationId} onSuccess={onDissolveSuccess} />
      {pickerOpen ? (
        <MemberAddDialog
          conversationId={conversationId}
          onClose={closePicker}
          onSuccess={onAddSuccess}
        />
      ) : null}
    </aside>
  )
}
