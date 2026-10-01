/**
 * 解散群聊 danger 区（批次2修复 C1 自 GroupInfo 拆出，行为零变化）——底部 danger 按钮 +
 * alertdialog 显式确认（确认解散/取消，照 settings/prune 惯例）；确认走 dissolveGroup，
 * 成功回调父层（本地移除会话并回列表），取消/遮罩/关闭零副作用；忙态禁用确认按钮。
 * 按钮不复用青色 group-add-button，走 danger 族 token（styles.css group-danger*）。
 */
import { useCallback, useState } from "react"
import { dissolveGroup } from "../api"

export interface GroupDangerZoneProps {
  readonly conversationId: string
  /** 解散成功：父层负责本地移除该会话并回到列表。 */
  readonly onSuccess: () => void
}

export function GroupDangerZone({ conversationId, onSuccess }: GroupDangerZoneProps) {
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [dissolveBusy, setDissolveBusy] = useState(false)
  const [dissolveError, setDissolveError] = useState<string | null>(null)

  // 解散群聊——成功后交父层收尾（本地移除该会话并回到列表）。
  const confirmDissolve = useCallback(async () => {
    if (dissolveBusy) return
    setDissolveBusy(true)
    setDissolveError(null)
    try {
      await dissolveGroup(conversationId)
      onSuccess()
    } catch {
      setDissolveError("解散失败，请重试。")
    } finally {
      setDissolveBusy(false)
    }
  }, [conversationId, dissolveBusy, onSuccess])

  return (
    <div className="group-danger">
      <button
        className="group-danger-button"
        data-testid="group-dissolve-open"
        type="button"
        onClick={() => setDissolveOpen(true)}
      >
        解散群聊
      </button>
      {dissolveOpen ? (
        <div
          className="member-add-overlay"
          data-testid="dissolve-overlay"
          onClick={() => setDissolveOpen(false)}
        >
          <div
            className="member-add-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="解散群聊"
            data-testid="dissolve-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="member-add-head">
              <span>解散群聊</span>
              <button
                className="member-add-close"
                data-testid="dissolve-close"
                aria-label="关闭"
                onClick={() => setDissolveOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="member-add-body">
              <p data-testid="dissolve-body">
                解散后群聊与消息将被删除，全部成员将被移出。此操作不可撤销。
              </p>
              {dissolveError !== null ? (
                <p className="group-info-error" role="alert" data-testid="dissolve-error">
                  {dissolveError}
                </p>
              ) : null}
            </div>
            <div className="member-add-foot">
              <button
                className="member-add-cancel"
                data-testid="dissolve-cancel"
                type="button"
                onClick={() => setDissolveOpen(false)}
              >
                取消
              </button>
              <button
                className="member-add-confirm"
                data-testid="dissolve-confirm"
                type="button"
                disabled={dissolveBusy}
                onClick={() => {
                  void confirmDissolve()
                }}
              >
                确认解散
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
