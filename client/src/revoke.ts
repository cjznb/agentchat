/**
 * 撤回的界面派生（feat/revoke-queued）——纯函数，组件只消费。
 *
 * 尽力撤回语义：仅当**己方**消息**未撤回**且仍有副本未送达（收件方回执 `queued`/`sending`）
 * 时才提供撤回入口；撤回后己方显示「已撤回」占位（原正文不再展示），对方保留原文加标记。
 * 阶段枚举单源在 `shared/contracts`，此处不新增。
 */
import type { ChatMessage } from "../../shared/contracts"

/** 未送达的回执阶段（仍有排队/在途副本）。 */
const UNDELIVERED_STAGES = new Set(["queued", "sending"])

/** 是否可撤回：己方文本消息、未撤回、且至少一个收件方回执仍为 `queued`/`sending`。 */
export function canRevoke(message: ChatMessage, own: boolean): boolean {
  if (!own || message.kind !== "text") return false
  if (message.revoked_at !== undefined && message.revoked_at !== null) return false
  return (message.receipts ?? []).some((receipt) => UNDELIVERED_STAGES.has(receipt.stage))
}

/** 撤回后展示：`none` = 未撤回；`placeholder` = 己方（隐藏原文）；`marked` = 对方（保留原文加标记）。 */
export type RevokeView = "none" | "placeholder" | "marked"

export function revokeView(message: ChatMessage, own: boolean): RevokeView {
  if (message.revoked_at === undefined || message.revoked_at === null) return "none"
  return own ? "placeholder" : "marked"
}
