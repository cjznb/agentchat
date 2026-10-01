/**
 * 群成员行（批次2修复 C1 自 GroupInfo 拆出，行为零变化）——图标/展示名/状态点/
 * 改名入口（表单态原样保留）/「移出群聊」两步确认（✕ → 移出|取消）。
 * 移出确认态由父层 `removing` 单值驱动（跨行互斥语义与原实现一致）。
 */
import { useRenameEditor } from "../actions"
import { vendorBadge } from "../chat"
import { statusGlyph, statusLabel } from "../treeFold"

export interface MemberRowProps {
  readonly member: {
    readonly id: string
    readonly name: string
    readonly kind: string
    readonly vendor: Parameters<typeof vendorBadge>[0]
    readonly status: Parameters<typeof statusLabel>[0]
  }
  readonly rename: ReturnType<typeof useRenameEditor>
  /** 本行是否处于移出确认态（父层 removingId === member.id）。 */
  readonly removing: boolean
  readonly onRequestRemove: (nodeId: string) => void
  readonly onCancelRemove: () => void
  readonly onConfirmRemove: (nodeId: string) => void
}

export function MemberRow({
  member,
  rename,
  removing,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: MemberRowProps) {
  return (
    <li className="member-item" data-testid="group-member" data-node-id={member.id}>
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
        <>
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
          {removing ? (
            <span className="member-remove-confirm" data-testid="member-remove-confirm">
              <button
                className="member-remove-yes"
                data-testid="member-remove-yes"
                aria-label="确认移出群聊"
                title="确认移出"
                onClick={() => onConfirmRemove(member.id)}
                type="button"
              >
                移出
              </button>
              <button
                className="member-remove-no"
                data-testid="member-remove-no"
                aria-label="取消移出"
                title="取消"
                onClick={onCancelRemove}
                type="button"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              className="member-rename member-remove"
              data-testid="member-remove"
              aria-label="移出群聊"
              title="移出群聊"
              onClick={() => onRequestRemove(member.id)}
              type="button"
            >
              ✕
            </button>
          )}
        </>
      )}
    </li>
  )
}
