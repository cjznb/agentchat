/**
 * MCP 读 / 策略工具：`roster` / `conversation` / `group` / `shout` / `whoami`（spec §9）。
 * 群与喊话入口经 core 审批闸门（Task 7）：返回 `{approval}` 时不执行，交人审批。
 */
import type { McpToolInput } from "../../shared/contracts"
import { conversationRoster, memberCards, rosterTree, type RosterNode } from "../core/agents"
import {
  addParticipant,
  createGroup,
  history,
  shout,
  unreadFor,
  type ShoutApprovalWaitResult,
} from "../core/messaging"
import type { ApprovalRequested } from "../core/permissions"
import { maskRevokedForReader } from "../core/revoke"
import { agentDisplayName, getAgent } from "../store/agents"
import { listConversations, listParticipants, SHOUT_KEY } from "../store/conversations"
import {
  McpToolError,
  requireIdentity,
  sendView,
  type SendResultView,
  type ToolContext,
} from "./context"

/**
 * `whoami`：读**自己**的身份卡。
 *
 * 为什么（真机反馈）：agent 不知道自己的**展示名**（昵称）是什么——`register` 出参里的 `agent.name`
 * 是机器唯一名（如 `agent-470b943b`），而人类在 UI 里看到/改的是展示名 `COALESCE(custom_name, name)`；
 * 注入头也只带发送者 id。于是 agent 既说不出自己叫什么，也不知道该拿哪个名字跟人对账。
 */
export function runWhoami(ctx: ToolContext): unknown {
  const requester = requireIdentity(ctx)
  const agent = getAgent(ctx.db, requester)
  if (agent === undefined) throw new McpToolError("agent_not_found", `unknown agent: ${requester}`)
  return {
    agent_id: agent.id,
    name: agent.name,
    display_name: agentDisplayName(agent),
    vendor: agent.vendor,
    kind: agent.kind,
    status: agent.status,
    role_tag: agent.roleTag ?? null,
    parent_id: agent.parentId ?? null,
    unread: unreadFor(ctx.db, agent.id),
  }
}

/** `roster` compact 视图的默认分页大小（节点数）。 */
const COMPACT_ROSTER_LIMIT = 100
/** `conversation` 正文预览默认字符数（`preview_chars:0` = 全文）。 */
const DEFAULT_PREVIEW_CHARS = 300

/**
 * 正文预览：按**码点**截断并标记 `truncated`/`body_chars`，让调用方知道"还有更多"而不是以为正文就这么短。
 * 全量正文用 `conversation{preview_chars:0}` 或按 id 精读。
 */
export function previewMessages(
  messages: readonly { readonly body: string }[],
  previewChars: number,
): Record<string, unknown>[] {
  if (previewChars <= 0) return messages as unknown as Record<string, unknown>[]
  return messages.map((message) => {
    const chars = [...message.body]
    if (chars.length <= previewChars) return message as unknown as Record<string, unknown>
    return {
      ...(message as unknown as Record<string, unknown>),
      body: `${chars.slice(0, previewChars).join("")}…`,
      truncated: true,
      body_chars: chars.length,
    }
  })
}

/** 扁平化 + 默认剔除离线/退役；**祖先链保留**（子节点在则父节点也在，层级不丢）。 */
function flattenRoster(
  nodes: readonly RosterNode[],
  options: { readonly includeOffline: boolean; readonly includeRetired: boolean },
): Record<string, unknown>[] {
  const allowed = (node: RosterNode): boolean =>
    (options.includeOffline || node.status !== "offline") &&
    (options.includeRetired || node.status !== "retired")
  const walk = (list: readonly RosterNode[], depth: number): Record<string, unknown>[] => {
    const rows: Record<string, unknown>[] = []
    for (const node of list) {
      const children = walk(node.children, depth + 1)
      if (!allowed(node) && children.length === 0) continue
      rows.push({
        id: node.id,
        name: node.name,
        status: node.status,
        vendor: node.vendor,
        kind: node.kind,
        parent_id: node.parent_id,
        role_tag: node.role_tag,
        unread: node.unread,
        depth,
      })
      rows.push(...children)
    }
    return rows
  }
  return walk(nodes, 0)
}

/** `summary` 视图：只给计数与根节点概览（约 100 B），要谁再 `filter` 精确定位。 */
function summarizeRoster(tree: readonly RosterNode[]): Record<string, unknown> {
  const nodes: RosterNode[] = []
  const walk = (list: readonly RosterNode[]): void => {
    for (const node of list) {
      nodes.push(node)
      walk(node.children)
    }
  }
  walk(tree)
  const byVendor: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const node of nodes) {
    byVendor[node.vendor] = (byVendor[node.vendor] ?? 0) + 1
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1
  }
  return {
    view: "summary",
    total: nodes.length,
    by_vendor: byVendor,
    by_status: byStatus,
    roots: tree.map((node) => ({
      id: node.id,
      name: node.name,
      vendor: node.vendor,
      status: node.status,
      children_count: node.children.length,
    })),
  }
}

/** 名称/在线过滤（既有语义）：自身命中或任一子命中即保留，祖先链不丢。 */
function pruneRoster(
  nodes: readonly RosterNode[],
  needle: string | undefined,
  onlineOnly: boolean,
): RosterNode[] {
  const keep = (node: RosterNode): boolean =>
    (needle === undefined || node.name.toLowerCase().includes(needle)) &&
    (!onlineOnly || node.status === "online")
  return nodes.flatMap((node) => {
    const children = pruneRoster(node.children, needle, onlineOnly)
    return keep(node) || children.length > 0 ? [{ ...node, children }] : []
  })
}

export function runRoster(ctx: ToolContext, input: McpToolInput<"roster">): unknown {
  const requester = requireIdentity(ctx)
  const conversationMode = input.conversation !== undefined
  // Task 5：`conversation` → 只返回该会话成员（带成员闸门，非成员 agent → not_participant）。
  const base =
    input.conversation === undefined
      ? rosterTree(ctx.db)
      : conversationRoster(ctx.db, requester, input.conversation)
  const needle = input.filter?.toLowerCase()
  const onlineOnly = input.online_only === true
  const tree = needle === undefined && !onlineOnly ? base : pruneRoster(base, needle, onlineOnly)
  // 成员树模式保持旧形状（view 不适用）。
  if (conversationMode) return tree

  const view = input.view ?? "compact"
  if (view === "tree") return tree
  if (view === "summary") return summarizeRoster(tree)

  const rows = flattenRoster(tree, {
    includeOffline: input.include_offline === true,
    includeRetired: input.include_retired === true,
  })
  const limit = input.limit ?? COMPACT_ROSTER_LIMIT
  const cursor = input.cursor ?? 0
  const page = rows.slice(cursor, cursor + limit)
  const hasMore = cursor + page.length < rows.length
  return {
    view: "compact",
    nodes: page,
    total: rows.length,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: cursor + page.length } : {}),
  }
}

export function runConversation(ctx: ToolContext, input: McpToolInput<"conversation">): unknown {
  const reader = requireIdentity(ctx)
  const limit = input.limit ?? 20
  const previewChars = input.preview_chars ?? DEFAULT_PREVIEW_CHARS
  // 多取一条判断 has_more（store history 升序返回，多出的那条是最早的）。
  const raw = history(ctx.db, input.id, input.before, limit + 1)
  const hasMore = raw.length > limit
  const page = hasMore ? raw.slice(1) : raw
  const masked = page.map((message) => maskRevokedForReader(ctx.db, message, reader))
  const first = masked[0]?.seq
  return {
    messages: previewMessages(masked, previewChars),
    has_more: hasMore,
    ...(hasMore && first !== undefined ? { next_before: first } : {}),
  }
}

export function runGroup(ctx: ToolContext, input: McpToolInput<"group">): unknown {
  const actor = requireIdentity(ctx)
  switch (input.op) {
    case "create": {
      const result = createGroup(ctx.db, {
        name: input.name,
        createdBy: actor,
        ...(input.member_ids === undefined ? {} : { memberIds: input.member_ids }),
      })
      return "approved" in result ? { group: result.approved } : { approval: result.approval }
    }
    case "add": {
      const result = addParticipant(ctx.db, {
        conversationId: input.group,
        agentId: input.member,
        invitedBy: actor,
      })
      return "approved" in result ? { ok: true } : { approval: result.approval }
    }
    case "list": {
      const all = listConversations(ctx.db)
        .filter((conversation) => conversation.kind === "group" && conversation.key !== SHOUT_KEY)
        .map((conversation) => {
          const members = listParticipants(ctx.db, conversation.id).map(
            (participant) => participant.agentId,
          )
          return {
            id: conversation.id,
            name: conversation.name ?? null,
            created_by: conversation.createdBy,
            // Task 5：`members` id 数组形状不变；`member_cards` additive（id+名+展示态）。
            members,
            member_cards: memberCards(ctx.db, conversation.id),
            // P4 additive：调用者是否已在群 —— 否则"看得见、发不出、看不出为什么"（发言要 not_participant）。
            is_member: members.includes(actor),
          }
        })
      // P3：群多时分页（缺省 50），避免 `group{op:list}` 随群数线性膨胀。
      const limit = input.limit ?? 50
      const cursor = input.cursor ?? 0
      const groups = all.slice(cursor, cursor + limit)
      const hasMore = cursor + groups.length < all.length
      return {
        groups,
        has_more: hasMore,
        ...(hasMore ? { next_cursor: cursor + groups.length } : {}),
      }
    }
  }
}

/**
 * `shout` 结果渲染（裁决 D2 反向判别）：`{approved}` 即时投递 / `{approval}` 审批语义
 * （可带 `timedOut` 表示闸后等待超时）。
 */
function renderShout(
  ctx: ToolContext,
  readerId: string,
  resolved:
    | SendResultView
    | { readonly approved: SendResultView }
    | ApprovalRequested
    | ShoutApprovalWaitResult,
): Record<string, unknown> {
  if ("approved" in resolved) return sendView(ctx.db, resolved.approved, readerId)
  if ("message" in resolved) return sendView(ctx.db, resolved, readerId)
  return "timedOut" in resolved
    ? { approval: resolved.approval, timedOut: true }
    : { approval: resolved.approval }
}

export function runShout(ctx: ToolContext, input: McpToolInput<"shout">): Promise<unknown> | unknown {
  const from = requireIdentity(ctx)
  // P6：urgency 是 additive 第 5 参；无 wait 时第 4 参显式 undefined（审批 payload 亦带 urgency）。
  const result =
    input.wait === undefined
      ? shout(ctx.db, from, input.body, undefined, input.urgency)
      : shout(
          ctx.db,
          from,
          input.body,
          { until: input.wait.until, timeoutMs: input.wait.timeoutMs },
          input.urgency,
        )
  return result instanceof Promise
    ? result.then((resolved) => renderShout(ctx, from, resolved))
    : renderShout(ctx, from, result)
}
