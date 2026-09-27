/**
 * MCP 读 / 策略工具：`roster` / `conversation` / `group` / `shout`（spec §9）。
 * 群与喊话入口经 core 审批闸门（Task 7）：返回 `{approval}` 时不执行，交人审批。
 */
import type { McpToolInput } from "../../shared/contracts"
import { rosterTree, type RosterNode } from "../core/agents"
import { addParticipant, createGroup, history, shout } from "../core/messaging"
import type { ApprovalRequested } from "../core/permissions"
import { listConversations, listParticipants, SHOUT_KEY } from "../store/conversations"
import {
  isApproval,
  requireIdentity,
  sendView,
  type SendResultView,
  type ToolContext,
} from "./context"

export function runRoster(ctx: ToolContext, input: McpToolInput<"roster">): unknown {
  requireIdentity(ctx)
  const tree = rosterTree(ctx.db)
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
  requireIdentity(ctx)
  return { messages: history(ctx.db, input.id, input.before, input.limit) }
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
      return isApproval(result) ? { approval: result.approval } : { group: result }
    }
    case "add": {
      const result = addParticipant(ctx.db, {
        conversationId: input.group,
        agentId: input.member,
        invitedBy: actor,
      })
      return result === undefined ? { ok: true } : { approval: result.approval }
    }
    case "list": {
      const groups = listConversations(ctx.db)
        .filter((conversation) => conversation.kind === "group" && conversation.key !== SHOUT_KEY)
        .map((conversation) => ({
          id: conversation.id,
          name: conversation.name ?? null,
          created_by: conversation.createdBy,
          members: listParticipants(ctx.db, conversation.id).map((participant) => participant.agentId),
        }))
      return { groups }
    }
  }
}

export function runShout(ctx: ToolContext, input: McpToolInput<"shout">): Promise<unknown> | unknown {
  const from = requireIdentity(ctx)
  const result =
    input.wait === undefined
      ? shout(ctx.db, from, input.body)
      : shout(ctx.db, from, input.body, { until: input.wait.until, timeoutMs: input.wait.timeoutMs })
  const render = (resolved: SendResultView | ApprovalRequested): Record<string, unknown> =>
    isApproval(resolved) ? { approval: resolved.approval } : sendView(resolved)
  return result instanceof Promise ? result.then(render) : render(result)
}
