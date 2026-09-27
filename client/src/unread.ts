/**
 * 未读聚合纯函数（Plan 3 终审 F1）——把**human 观察者**口径统一到单一来源。
 *
 * 规格（spec §5.4/§11.2/§11.3）：会话列表根行徽标与组织树各折叠行徽标 = **全子树未读**
 * （该节点自身 + 全部后代会话的 human 侧未读之和）；展开后子行各显各的。
 *
 * 算法：对每个会话取其归属 owner（复用 `ownership.ts` 的 `dm:` 归属规则），把该会话的
 * **human 侧** `conversation.unread` 沿 `parent` 链累加到 owner 及其全部祖先——
 * 于是根 = 全子树、中间节点 = 其子树；打开子会话使 `conversation.unread` 归零后，
 * 祖先徽标同步下降（展开前后一致，满足超级观察者语义）。
 *
 * 服务端与 MCP roster 的 **agent 侧** `unread` 契约不动（本函数只在客户端派生展示值）。
 */
import type { ConversationSummary, RosterNode } from "../../shared/contracts"
import { buildRosterIndex, resolveOwner } from "./ownership"

/**
 * `agentId → 全子树 human 侧未读`。仅含 >0 的项（缺省即 0）。
 * 群聊 / 喊话（不可归属任何 agent）不计入任何子树。
 */
export function aggregateUnread(
  conversations: readonly ConversationSummary[],
  roster: readonly RosterNode[],
): Map<string, number> {
  const index = buildRosterIndex(roster)
  const parentOf = new Map<string, string>()
  for (const info of index.nodes.values()) {
    if (info.node.parent_id !== null) parentOf.set(info.node.id, info.node.parent_id)
  }
  const totals = new Map<string, number>()
  for (const conversation of conversations) {
    if (conversation.unread <= 0) continue
    const owner = resolveOwner(conversation.key, index)
    if (owner === undefined) continue
    let current: string | undefined = owner.node.id
    while (current !== undefined) {
      totals.set(current, (totals.get(current) ?? 0) + conversation.unread)
      current = parentOf.get(current)
    }
  }
  return totals
}
