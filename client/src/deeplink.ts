/**
 * 聊天视图深链解析（spec §11.5；Plan 3 T5 决议 3）——纯函数。
 *
 * 通知页点击经 `?conversation=<会话id>&msg=<消息短id>` 跳转会话并滚动到该消息；
 * 缺参 / 空白值 → `null`（调用方静默，不崩）。
 */

/** 深链目标（各自可缺省）。 */
export interface DeepLink {
  readonly conversationId: string | null
  readonly messageId: string | null
}

function normalized(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * 解析 location.search（可带或不带前导 `?`）。未知参数忽略；
 * URI 编码（`URLSearchParams` 自动解码）与重复参数（取首个）由标准库处理。
 */
export function parseDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search)
  return {
    conversationId: normalized(params.get("conversation")),
    messageId: normalized(params.get("msg")),
  }
}
