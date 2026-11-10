/**
 * 添加成员弹窗（C2；批次2修复 C1 自 GroupInfo 拆出，行为零变化）——遮罩 + 面板内嵌
 * MemberPicker（多选树原样复用），底栏确认/取消；确认走既有 addGroupMember（逐个提交，
 * 审批/错误/刷新语义不变）；取消 / Esc / 点遮罩关闭不提交。仅在父层 pickerOpen 时挂载，
 * 卸载即清空已选（等价原 closePicker 清 picked）。
 */
import { useCallback, useEffect, useState } from "react"
import { addGroupMember, ApiError } from "../api"
import { MemberPicker } from "./MemberPicker"

export interface MemberAddDialogProps {
  readonly conversationId: string
  /** 取消 / Esc / 遮罩 / 关闭按钮：关闭弹窗（挂载态卸载即清空选择）。 */
  readonly onClose: () => void
  /** 确认提交成功：关闭弹窗并刷新（父层回调）。 */
  readonly onSuccess: () => void
}

/**
 * 拉人失败码 → 用户可自诊文案（P5）：容器被服务端 409 拒绝时不再显示"添加失败，请重试"。
 * 未知码/网络失败保持通用兜底。
 */
export function memberAddErrorMessage(code: string | undefined): string {
  if (code === "container_not_group_member") return "这是分组容器，不能加入群聊。"
  if (code === "container_not_chat_target") return "这是分组容器，不是聊天对象。"
  if (code === "agent_not_found") return "该节点不存在或已被删除。"
  if (code === "recipient_retired") return "该节点已退役，不能加入群聊。"
  if (code === "not_participant") return "你没有权限向这个群拉人。"
  return "添加失败，请重试。"
}

export function MemberAddDialog({ conversationId, onClose, onSuccess }: MemberAddDialogProps) {
  const [picked, setPicked] = useState<readonly string[]>([])
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const togglePick = useCallback((nodeId: string) => {
    setPicked((previous) =>
      previous.includes(nodeId) ? previous.filter((id) => id !== nodeId) : [...previous, nodeId],
    )
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
      onSuccess()
    } catch (error) {
      // `ApiError.code` 由 `api.ts` 从错误体透出（P5）；非 ApiError（网络失败等）→ 通用文案。
      setAddError(memberAddErrorMessage(error instanceof ApiError ? error.code : undefined))
    } finally {
      setAdding(false)
    }
  }, [picked, adding, conversationId, onSuccess])

  // Esc 关闭弹窗（不提交）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div className="member-add-overlay" data-testid="member-add-overlay" onClick={onClose}>
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
            onClick={onClose}
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
            onClick={onClose}
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
  )
}
