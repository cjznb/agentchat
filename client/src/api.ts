/**
 * REST 客户端（Plan 3 T3）——前端唯一数据入口。
 *
 * - 出参一律经 `shared/contracts` 的 zod schema 边界解析（服务端类型唯一来源，
 *   前端零手写重复类型）；非 2xx 抛 `ApiError`（含状态码），调用方记录并继续
 * - `loadReload(plan)` 汇总 store 声明的重拉意图，供 WS 事件后的对账式刷新复用
 */
import {
  agentCardSchema,
  approvalDecisionResultSchema,
  approvalDecisionSchema,
  approvalListSchema,
  conversationListSchema,
  conversationReadResultSchema,
  ensureDmResultSchema,
  groupCreateResultSchema,
  groupListSchema,
  groupMemberResultSchema,
  messageHistorySchema,
  notificationListSchema,
  notificationReadResultSchema,
  respondAskInputSchema,
  respondAskResultSchema,
  rosterTreeSchema,
  sendMessageResultSchema,
  shoutResultSchema,
  type AgentCard,
  type ApprovalDecision,
  type ApprovalDecisionResult,
  type ApprovalEntry,
  type ChatMessage,
  type ConversationList,
  type ConversationReadResult,
  type EnsureDmResult,
  type GroupCreateResult,
  type GroupEntry,
  type GroupMemberResult,
  type MessageHistory,
  type NotificationEntry,
  type NotificationReadResult,
  type RespondAskInput,
  type RespondAskResult,
  type RosterNode,
  type SendMessageResult,
  type ShoutResult,
} from "../../shared/contracts"

/** 通知范围（通知页两 tab）。 */
export type NotificationScope = "actionable" | "all"

/** 非 2xx 出参：携带路径与状态码，供调用方记录/告警。 */
export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`request failed: ${status} ${path}`)
    this.name = "ApiError"
  }
}

const JSON_HEADERS = { "content-type": "application/json" } as const

/** 只依赖 `parse`，避免与 zod 泛型参数协变纠缠。 */
interface Parser<T> {
  parse(value: unknown): T
}

async function request<T>(path: string, schema: Parser<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new ApiError(path, response.status)
  return schema.parse(await response.json())
}

function postInit(body: unknown): RequestInit {
  return { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }
}

function signalInit(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal === undefined ? undefined : { signal }
}

export function loadRoster(signal?: AbortSignal): Promise<readonly RosterNode[]> {
  return request("/api/roster", rosterTreeSchema, signalInit(signal))
}

export function loadConversations(signal?: AbortSignal): Promise<ConversationList> {
  return request("/api/conversations", conversationListSchema, signalInit(signal))
}

export function loadMessages(
  conversationId: string,
  before?: number,
  signal?: AbortSignal,
): Promise<readonly ChatMessage[]> {
  const query = before === undefined ? "" : `?before=${before}`
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    messageHistorySchema,
    signalInit(signal),
  ).then((history: MessageHistory) => history.messages)
}

export function sendMessage(conversationId: string, body: string): Promise<SendMessageResult> {
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    sendMessageResultSchema,
    postInit({ body }),
  )
}

export function markConversationRead(conversationId: string): Promise<ConversationReadResult> {
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/read`,
    conversationReadResultSchema,
    postInit({}),
  )
}

export function loadNotifications(
  scope: NotificationScope,
  signal?: AbortSignal,
): Promise<readonly NotificationEntry[]> {
  return request(`/api/notifications?scope=${scope}`, notificationListSchema, signalInit(signal))
}

export function loadApprovals(signal?: AbortSignal): Promise<readonly ApprovalEntry[]> {
  return request("/api/approvals", approvalListSchema, signalInit(signal))
}

export function listGroups(signal?: AbortSignal): Promise<readonly GroupEntry[]> {
  return request("/api/groups", groupListSchema, signalInit(signal)).then(
    (list: { readonly groups: readonly GroupEntry[] }) => list.groups,
  )
}

export function createGroup(
  name: string,
  memberIds?: readonly string[],
): Promise<GroupCreateResult> {
  return request(
    "/api/groups",
    groupCreateResultSchema,
    postInit(memberIds === undefined ? { name } : { name, memberIds: [...memberIds] }),
  )
}

export function addGroupMember(
  conversationId: string,
  agentId: string,
): Promise<GroupMemberResult> {
  return request(
    `/api/groups/${encodeURIComponent(conversationId)}/members`,
    groupMemberResultSchema,
    postInit({ agentId }),
  )
}

export function shout(body: string): Promise<ShoutResult> {
  return request("/api/shout", shoutResultSchema, postInit({ body }))
}

export function loadAgentCard(id: string, signal?: AbortSignal): Promise<AgentCard> {
  return request(`/api/agents/${encodeURIComponent(id)}`, agentCardSchema, signalInit(signal))
}

/** 确保 human↔节点 DM（取或建，幂等）——资料卡「发消息」用。 */
export function ensureDm(to: string): Promise<EnsureDmResult> {
  return request("/api/conversations", ensureDmResultSchema, postInit({ to }))
}

export function markNotificationRead(id: string): Promise<NotificationReadResult> {
  return request(
    `/api/notifications/${encodeURIComponent(id)}/read`,
    notificationReadResultSchema,
    postInit({}),
  )
}

export function respondAsk(id: string, answer: RespondAskInput): Promise<RespondAskResult> {
  return request(
    `/api/asks/${encodeURIComponent(id)}/respond`,
    respondAskResultSchema,
    postInit(respondAskInputSchema.parse(answer)),
  )
}

export function decideApproval(
  id: string,
  decision: ApprovalDecision,
): Promise<ApprovalDecisionResult> {
  return request(
    `/api/approvals/${encodeURIComponent(id)}`,
    approvalDecisionResultSchema,
    postInit({ decision: approvalDecisionSchema.parse(decision) }),
  )
}

// ── 重拉计划（store 声明的对账意图；WS 事件驱动） ─────────────────────

/** 一次重拉需要触达的数据面（由 `reducers.planReload` 纯函数产出）。 */
export interface ReloadPlan {
  readonly roster: boolean
  readonly conversations: boolean
  readonly notifications: boolean
  readonly approvals: boolean
  readonly messages: readonly string[]
}

/** 单会话消息重拉结果。 */
export interface ReloadMessages {
  readonly conversationId: string
  readonly messages: readonly ChatMessage[]
}

/** `loadReload` 出参：仅含计划命中的字段。 */
export interface ReloadResult {
  readonly roster?: readonly RosterNode[]
  readonly conversations?: ConversationList
  readonly notifications?: readonly NotificationEntry[]
  readonly notificationsAll?: readonly NotificationEntry[]
  readonly approvals?: readonly ApprovalEntry[]
  readonly messages?: readonly ReloadMessages[]
}

/** 首屏（挂载）全量重拉计划。 */
export const INITIAL_RELOAD_PLAN: ReloadPlan = {
  roster: true,
  conversations: true,
  notifications: true,
  approvals: true,
  messages: [],
}

/** 按计划并发拉取；任一请求失败即整体拒绝（调用方 `warn` 并继续，不崩）。 */
export async function loadReload(plan: ReloadPlan, signal?: AbortSignal): Promise<ReloadResult> {
  const result: {
    roster?: readonly RosterNode[]
    conversations?: ConversationList
    notifications?: readonly NotificationEntry[]
    notificationsAll?: readonly NotificationEntry[]
    approvals?: readonly ApprovalEntry[]
    messages?: readonly ReloadMessages[]
  } = {}
  const tasks: Promise<void>[] = []
  if (plan.roster) {
    tasks.push(loadRoster(signal).then((roster) => { result.roster = roster }))
  }
  if (plan.conversations) {
    tasks.push(loadConversations(signal).then((conversations) => { result.conversations = conversations }))
  }
  if (plan.notifications) {
    tasks.push(
      Promise.all([loadNotifications("actionable", signal), loadNotifications("all", signal)]).then(
        ([actionable, all]) => {
          result.notifications = actionable
          result.notificationsAll = all
        },
      ),
    )
  }
  if (plan.approvals) {
    tasks.push(loadApprovals(signal).then((approvals) => { result.approvals = approvals }))
  }
  if (plan.messages.length > 0) {
    tasks.push(
      Promise.all(
        plan.messages.map((conversationId) =>
          loadMessages(conversationId, undefined, signal).then((messages) => ({
            conversationId,
            messages,
          })),
        ),
      ).then((messages) => { result.messages = messages }),
    )
  }
  await Promise.all(tasks)
  return result
}
