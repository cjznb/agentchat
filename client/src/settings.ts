/**
 * 「设置」面板的纯逻辑（无 DOM）：确认词门槛、`agentchat:` 前缀 localStorage 清理、错误码文案。
 * 与组件分离以便单测；组件仅消费这些结果与注入的 API。
 */

/** 恢复出厂设置所需的确认词（必须手工逐字输入）。 */
export const RESET_CONFIRM_WORD = "RESET"

/** 本应用写入 localStorage 的键前缀（展开态/手风琴/选人器等）。 */
export const LOCAL_STORAGE_PREFIX = "agentchat:"

/** 最小 storage 接口（`localStorage` 结构子集；便于测试注入内存实现）。 */
export interface LocalStorageLike {
  readonly length: number
  key(index: number): string | null
  removeItem(key: string): void
}

/** 确认词必须**精确**匹配（不做 trim/大小写宽容）。 */
export function isResetConfirmed(input: string): boolean {
  return input === RESET_CONFIRM_WORD
}

/** `POST /api/admin/reset` 的请求体。 */
export interface ResetRequest {
  readonly confirm: string
  readonly keepBackups?: boolean
}

/**
 * 构造恢复出厂设置的请求体：**仅在勾选**「保留 backups/」时才显式带 `keepBackups: true`；
 * 不勾 → **省略该键**（与端点 schema 的可选语义一致，缺省即清 `backups/`）。
 */
export function resetRequestPayload(confirm: string, keepBackups: boolean): ResetRequest {
  return keepBackups ? { confirm, keepBackups: true } : { confirm }
}

/** 列出属于本应用的 storage 键（前缀 `agentchat:`，保持遍历顺序）。 */
export function agentchatStorageKeys(storage: LocalStorageLike): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null && key.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(key)
  }
  return keys
}

/** 仅清掉本应用的 storage 键（不误删他人键），返回清理数量。 */
export function clearAgentchatLocalStorage(storage: LocalStorageLike): number {
  const keys = agentchatStorageKeys(storage)
  for (const key of keys) storage.removeItem(key)
  return keys.length
}

/** 服务端错误码 → 中文提示（未知/缺失回落通用文案）。 */
export function resetErrorMessage(code: string | undefined): string {
  switch (code) {
    case "forbidden":
      return "仅允许本机访问，请在本机浏览器中操作。"
    case "invalid_body":
      return "确认词不正确，请输入 RESET。"
    case "snapshot_failed":
      return "快照失败，数据未被清理，请稍后重试。"
    case "db_clear_failed":
      return "清空数据库失败，请查看 Hub 日志后重试。"
    default:
      return "重置失败，请重试。"
  }
}
