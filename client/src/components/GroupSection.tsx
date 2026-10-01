/**
 * 「群聊」分组区（C1；批次2修复 C1 自 ConversationList 拆出，行为零变化）——
 * 不可点击 header + 箭头切换、默认收起、展开态持久化 `agentchat:groupSectionExpanded`
 * （键沿 `agentchat:` 前缀，风格照 fold.ts 绑定）；行渲染经 children 传入（父层复用 FlatItem）。
 * 等价性：缺省/坏值/隐私模式禁用存储 → 收起且静默跳过写；展开态持久化走 F6 幂等模式
 * （StrictMode 双挂载同值不重复写）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { StorageLike } from "../fold"

export const GROUP_SECTION_KEY = "agentchat:groupSectionExpanded"

// 隐私模式兜底：与 ConversationList.safeStorage 同语义（各管各的存储读取，避免组件循环导入）。
function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式禁用存储：不持久化展开态
  }
}

/** 读取分组展开态：缺省 / 坏值 → 收起（默认收起是冻结语义）。 */
function loadGroupSection(storage: StorageLike | null): boolean {
  if (storage === null) return false
  try {
    return storage.getItem(GROUP_SECTION_KEY) === "true"
  } catch {
    return false
  }
}

/** 写入分组展开态；隐私模式禁用存储时静默跳过。 */
function saveGroupSection(storage: StorageLike | null, open: boolean): void {
  if (storage === null) return
  try {
    storage.setItem(GROUP_SECTION_KEY, String(open))
  } catch {
    /* 忽略写入失败 */
  }
}

export function GroupSection({ children }: { readonly children?: ReactNode }) {
  const [groupOpen, setGroupOpen] = useState<boolean>(() => loadGroupSection(safeStorage()))

  // 分组展开态持久化（同 F6 幂等模式）：值未变不重复持久化。
  const groupPersistedRef = useRef<string | null>(null)
  useEffect(() => {
    const serialized = String(groupOpen)
    if (groupPersistedRef.current === serialized) return
    groupPersistedRef.current = serialized
    saveGroupSection(safeStorage(), groupOpen)
  }, [groupOpen])

  return (
    <li className="group-section" data-testid="group-section">
      <div className="group-section-header" data-testid="group-section-header">
        <button
          className="group-section-toggle"
          data-testid="group-section-toggle"
          aria-expanded={groupOpen}
          aria-label={`${groupOpen ? "收起" : "展开"}群聊分组`}
          onClick={() => setGroupOpen((previous) => !previous)}
          type="button"
        >
          <span aria-hidden="true">{groupOpen ? "▾" : "▸"}</span>
        </button>
        <span className="group-section-title">群聊</span>
      </div>
      {groupOpen ? <ul className="group-section-rows">{children}</ul> : null}
    </li>
  )
}
