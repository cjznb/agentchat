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

export function runRoster(ctx: ToolContext, input: McpToolInput<"roster">): unknown {
  const requester = requireIdentity(ctx)
  // Task 5：`conversation` → 只返回该会话成员（带成员闸门，非成员 agent → not_participant）。
  const tree =
    input.conversation === undefined
      ? rosterTree(ctx.db)
      : conversationRoster(ctx.db, requester, input.conversation)
  const needle = input.filter?.toLowerCase()
  const onlineOnly = input.online_only === true
  if (needle === undefined && !onlineOnly) return tree
  // 单一 prune：自身命中或任一子命中即保留（祖先链不丢）。
  const keep = (node: RosterNode): boolean =>
    (needle === undefined || node.name.toLowerCase().includes(needle)) &&
    (!onlineOnly || node.status === "online")
  const prune = (nodes: readonly RosterNode[]): RosterNode[] =>
    nodes.flatMap((node) => {
      const children = prune(node.children)
      return keep(node) || children.length > 0 ? [{ ...node, children }] : []
    })
  return prune(tree)
}

export function runConversation(ctx: ToolContext, input: McpToolInput<"conversation">): unknown {
  const reader = requireIdentity(ctx)
  // 撤回消息对未投递读者遮蔽正文（与 MCP inbox / UI 会话消息接口同一单点）。
  return {
    messages: history(ctx.db, input.id, input.before, input.limit).map((message) =>
      maskRevokedForReader(ctx.db, message, reader),
    ),
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
      const groups = listConversations(ctx.db)
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
      return { groups }
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
