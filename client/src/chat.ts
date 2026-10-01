/**
 * 聊天视图纯派生（spec §11.4；Plan 3 T5）——roster → 发送者视图 / 会话标题 / 时间。
 * 组件只消费，不重复解析层级与 DM key（层级归属用与 `fold.ts` 相同的 `dm:` key 规则）。
 */
import type { ConversationSummary, RosterNode } from "../../shared/contracts"

/** 单条消息发送者的展示信息。 */
export interface SenderView {
  readonly id: string
  readonly name: string
  readonly vendor: string
  /** 非根节点 → 其根祖先名（渲染 `[子·<根名>]`）；根 / 逻辑顶层 → null。 */
  readonly rootName: string | null
}

/** roster 派生：human 身份 + id→发送者视图。 */
export interface RosterView {
  readonly humanId: string | null
  readonly byId: ReadonlyMap<string, SenderView>
}

/** 展开 roster 树为 id→发送者视图；同时定位 human 节点（其后代不存在）。 */
export function buildRosterView(roster: readonly RosterNode[]): RosterView {
  const byId = new Map<string, SenderView>()
  let humanId: string | null = null
  const walk = (node: RosterNode, rootName: string, isRoot: boolean): void => {
    if (node.vendor === "human" && humanId === null) humanId = node.id
    byId.set(node.id, {
      id: node.id,
      name: node.name,
      vendor: node.vendor,
      rootName: isRoot ? null : rootName,
    })
    for (const child of node.children) walk(child, rootName, false)
  }
  for (const node of roster) walk(node, node.name, true)
  return { humanId, byId }
}

const KNOWN_VENDOR_BADGES: Readonly<Record<string, string>> = {
  opencode: "OC",
  "claude-code": "CC",
  human: "你",
}

/** 厂商徽标短名（未知厂商取大写前两位）。 */
export function vendorBadge(vendor: string): string {
  return KNOWN_VENDOR_BADGES[vendor] ?? vendor.slice(0, 2).toUpperCase()
}

/** DM `key`（`dm:<idA>_<idB>`，字典序）→ 参与方 id；段数≠2 → 空（与 fold.ts 同规则）。 */
function dmPeerIds(key: string): readonly string[] {
  if (!key.startsWith("dm:")) return []
  const parts = key.slice(3).split("_")
  return parts.length === 2 && parts.every((id) => id !== "") ? parts : []
}

/**
 * B3/F1：纯双 agent DM 参与方（key 段数=2 且均非 human；roster 无 human 身份时不判定）。
 * 含人类 DM / 群 / roster 未就绪 → null（既有规则零改动）。
 */
export function dualAgentDmIds(
  conversation: ConversationSummary | undefined,
  view: RosterView,
): readonly [string, string] | null {
  if (conversation === undefined || conversation.kind !== "dm") return null
  const peers = dmPeerIds(conversation.key)
  if (peers.length !== 2 || view.humanId === null) return null
  if (peers.some((id) => id === view.humanId)) return null
  const [idA, idB] = peers
  return idA !== undefined && idB !== undefined ? [idA, idB] : null
}

/** B3：发起方 = 会话首条非系统消息的 sender（`ConversationSummary` 无创建者字段 → 客户端派生）。 */
export function initiatorIdOf(
  messages: readonly { readonly kind: string; readonly fromAgentId: string }[],
): string | null {
  return messages.find((m) => m.kind !== "system")?.fromAgentId ?? null
}

/**
 * B3：双 agent DM 分侧——发起方居左、对向居右；own / 人类注入按非发起方侧（右）；
 * 非参与方 sender（系统/第三方）与非双 agent DM → undefined（群聊与含人类 DM 零变化）。
 */
export function dualDmSide(
  conversation: ConversationSummary | undefined,
  view: RosterView,
  initiatorId: string | null,
  message: { readonly fromAgentId: string },
  own: boolean,
): "left" | "right" | undefined {
  const peers = dualAgentDmIds(conversation, view)
  if (peers === null) return undefined
  if (own) return "right"
  if (!peers.includes(message.fromAgentId)) return undefined
  return message.fromAgentId === initiatorId ? "left" : "right"
}

/**
 * 会话标题：喊话/群用会话名；DM 取非 human 参与方名（roster 缺失 → 会话名/“私聊”）。
 * F1：纯双 agent DM → 「{发起方}和{对方}的私聊」（发起方在前；initiatorId 缺省 → key 序）。
 */
export function conversationTitle(
  conversation: ConversationSummary | undefined,
  view: RosterView,
  initiatorId: string | null = null,
): string {
  if (conversation === undefined) return "会话"
  if (conversation.key === "shout") return conversation.name ?? "全员喊话"
  if (conversation.kind === "group") return conversation.name ?? "群聊"
  const dual = dualAgentDmIds(conversation, view)
  if (dual !== null) {
    const first = view.byId.get(dual[0])
    const second = view.byId.get(dual[1])
    if (first !== undefined && second !== undefined) {
      const initiatorSecond = initiatorId !== null && initiatorId === dual[1] && initiatorId !== dual[0]
      return initiatorSecond
        ? `${second.name}和${first.name}的私聊`
        : `${first.name}和${second.name}的私聊`
    }
  }
  for (const id of dmPeerIds(conversation.key)) {
    if (id === view.humanId) continue
    const peer = view.byId.get(id)
    if (peer !== undefined) return peer.name
  }
  return conversation.name ?? "私聊"
}

/** 头像首字（CJK 取首个码点；空名回退 `?`）。 */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === "") return "?"
  return [...trimmed][0] ?? "?"
}

/** 本地时钟 `HH:MM`（气泡时间戳）。 */
export function formatClock(createdAt: number): string {
  const date = new Date(createdAt)
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}
