/**
 * 手风琴展开态纯原语（Plan 3 T4/T6 共用）——会话列表与组织树折叠共用同一模式：
 * 默认收起、单开（手风琴）、`localStorage` 持久化、坏 JSON 容错。
 *
 * 存储键由调用方注入（列表 `agentchat:expandedRoots` / 组织树 `agentchat:expandedTree`），
 * 故两处折叠态互不串扰；原语本身与业务无关，只做「id 集合」的读写与切换。
 */

/** 可注入的存储面（浏览器 `Storage` 与测试假实现皆满足）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 读取展开 id；坏 JSON / 非字符串数组 / 存储异常 → 空数组（容错）。 */
export function loadExpanded(storage: StorageLike | null, storageKey: string): readonly string[] {
  if (storage === null) return []
  try {
    const raw = storage.getItem(storageKey)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as readonly unknown[]).filter((value): value is string => typeof value === "string")
  } catch {
    return [] // 坏 JSON：忽略持久化，回到默认收起
  }
}

/** 写入展开 id；配额/隐私模式异常吞掉（持久化失败不影响交互）。 */
export function saveExpanded(
  storage: StorageLike | null,
  storageKey: string,
  ids: readonly string[],
): void {
  if (storage === null) return
  try {
    storage.setItem(storageKey, JSON.stringify(ids))
  } catch {
    /* 存储不可用：忽略 */
  }
}

/** 手风琴：展开新项只保留它；再点已展开的项则收起。 */
export function toggleExpanded(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? [] : [id]
}
