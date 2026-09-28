/**
 * MCP 工具注册与写侧工具（spec §9）—— 传输层（`routes/mcp.ts`）把 SDK 校验后的入参交给
 * `registerTools` 注册的闭包；本模块只做「契约 schema 二次解析取类型化入参 → 调 core」，
 * 路由层零手写类型（约束：全部 io 经 `shared/contracts.ts`）。读/策略工具在 `read-tools.ts`，
 * 请求批示工具在 `ask-tools.ts`（本模块仅分发）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  MCP_TOOLS,
  MCP_TOOL_INPUTS,
  type McpToolInput,
  type McpToolName,
} from "../../shared/contracts"
import { registerChild, registerLogical, registerRoot, RegistrationError } from "../core/agents"
import { ack, inbox, recipientsOf, receiptState, sendMessage, unreadFor } from "../core/messaging"
import { getAgent, getAgentByName, setStatusText, type Agent } from "../store/agents"
import { getConversation } from "../store/conversations"
import { getById, type Message } from "../store/messages"
import { errorResult, McpToolError, requireIdentity, sendView, toolResult, type ToolContext } from "./context"
import { runAsk, runRespondAsk } from "./ask-tools"
import { runConversation, runGroup, runRoster, runShout } from "./read-tools"

// ── register ────────────────────────────────────────────────────────

/** `parent_ref` 解析：先 id 后 name；未命中 → `RegistrationError("parent_not_found")`。 */
function resolveAgentRef(db: ToolContext["db"], ref: string): string {
  const byId = getAgent(db, ref)
  if (byId !== undefined) return byId.id
  const byName = getAgentByName(db, ref)
  if (byName !== undefined) return byName.id
  throw new RegistrationError("parent_not_found", `parent agent not found: ${ref}`)
}

function definedCard(input: McpToolInput<"register">) {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.role_tag === undefined ? {} : { roleTag: input.role_tag }),
    ...(input.remark === undefined ? {} : { remark: input.remark }),
  }
}

/** 注册分流：逻辑节点 / 子节点（需 `task_ref`）/ 根。 */
function registerAgent(
  ctx: ToolContext,
  input: McpToolInput<"register">,
  card: ReturnType<typeof definedCard>,
): { agent: Agent; joinToken?: string } {
  if (input.kind === "logical") {
    const parentId =
      input.parent_ref === undefined ? undefined : resolveAgentRef(ctx.db, input.parent_ref)
    return { agent: registerLogical(ctx.db, { ...card, ...(parentId === undefined ? {} : { parentId }) }) }
  }
  if (input.parent_ref !== undefined) {
    if (input.task_ref === undefined) {
      throw new McpToolError("task_ref_required", "task_ref is required when parent_ref is set")
    }
    const parentId = resolveAgentRef(ctx.db, input.parent_ref)
    return { agent: registerChild(ctx.db, { ...card, taskRef: input.task_ref, parentId }) }
  }
  return registerRoot(ctx.db, ctx.home, {
    ...card,
    ...(input.join_token === undefined ? {} : { joinToken: input.join_token }),
  })
}

function runRegister(ctx: ToolContext, input: McpToolInput<"register">): unknown {
  let registered: { agent: Agent; joinToken?: string }
  try {
    registered = registerAgent(ctx, input, definedCard(input))
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: agents.name")) {
      // 未提供 name 时 core 走兜底名（几乎不可能冲突）；提示仍给出可审计的入参名。
      throw new McpToolError(
        "name_taken",
        `agent name already taken: ${input.name ?? "(generated fallback name)"}`,
      )
    }
    throw error
  }
  if (ctx.agentId === undefined) ctx.agentId = registered.agent.id
  return {
    agent: registered.agent,
    unread: unreadFor(ctx.db, registered.agent.id),
    ...(registered.joinToken === undefined ? {} : { join_token: registered.joinToken }),
  }
}

// ── send / inbox / ack ──────────────────────────────────────────────

function runSend(ctx: ToolContext, input: McpToolInput<"send">): unknown {
  const from = requireIdentity(ctx)
  if (input.to === "*") throw new McpToolError("use_shout_tool", "use the shout tool to broadcast")
  const base = {
    from,
    to: input.to,
    body: input.body,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
  if (input.wait === undefined) return sendView(sendMessage(ctx.db, base))
  return sendMessage(ctx.db, {
    ...base,
    wait: { until: input.wait.until, timeoutMs: input.wait.timeoutMs },
  }).then(sendView)
}

function filterConversation(messages: readonly Message[], id: string | undefined): Message[] {
  return id === undefined ? [...messages] : messages.filter((m) => m.conversationId === id)
}

function runInbox(ctx: ToolContext, input: McpToolInput<"inbox">): Promise<unknown> | unknown {
  const id = requireIdentity(ctx)
  const paging = {
    ...(input.after === undefined ? {} : { after: input.after }),
  }
  if (input.timeout !== undefined) {
    return inbox(ctx.db, id, { ...paging, wait: { until: "either", timeoutMs: input.timeout } }).then(
      (result) => {
        const messages = filterConversation(result.messages, input.conversation)
        if (input.ack === true) ack(ctx.db, id, messages.map((m) => m.id))
        return { messages, unread: unreadFor(ctx.db, id), timedOut: result.timedOut }
      },
    )
  }
  const messages = filterConversation(inbox(ctx.db, id, paging), input.conversation)
  if (input.ack === true) ack(ctx.db, id, messages.map((m) => m.id))
  return { messages, unread: unreadFor(ctx.db, id) }
}

function runAck(ctx: ToolContext, input: McpToolInput<"ack">): unknown {
  return { confirmed: ack(ctx.db, requireIdentity(ctx), input.message_ids) }
}

// ── status / message_status ─────────────────────────────────────────

function runStatus(ctx: ToolContext, input: McpToolInput<"status">): unknown {
  const agent = setStatusText(ctx.db, requireIdentity(ctx), input.text)
  return { id: agent.id, status_text: agent.statusText ?? null }
}

function runMessageStatus(ctx: ToolContext, input: McpToolInput<"message_status">): unknown {
  requireIdentity(ctx)
  const results: { id: string; receipts: { agentId: string; stage: string }[] }[] = []
  for (const id of input.ids) {
    const message = getById(ctx.db, id)
    const conversation =
      message === undefined ? undefined : getConversation(ctx.db, message.conversationId)
    if (message === undefined || conversation === undefined) continue
    results.push({
      id,
      receipts: recipientsOf(ctx.db, conversation, message.fromAgentId).map((agentId) => ({
        agentId,
        stage: receiptState(ctx.db, message, agentId),
      })),
    })
  }
  return results
}

// ── 注册与分发 ──────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  register: "注册或认领节点（根 / 子 / 逻辑节点）",
  send: "向节点或会话发送消息，可阻塞等待回信",
  inbox: "读取收件箱，可阻塞等待新消息",
  ack: "将消息标记为已读",
  roster: "读取层级树与联系人卡",
  conversation: "读取会话历史分页",
  group: "创建群聊 / 拉人 / 列出群聊",
  shout: "全员喊话（根节点，需审批）",
  status: "更新自身状态文本",
  message_status: "查询消息各收件方回执",
  ask: "向用户或节点发起带选项的请求批示，可阻塞等待答复",
  respond_ask: "答复一条请求批示（选项或自由文本，首答生效）",
}

function runTool(name: McpToolName, args: unknown, ctx: ToolContext): Promise<unknown> | unknown {
  switch (name) {
    case "register":
      return runRegister(ctx, MCP_TOOL_INPUTS.register.parse(args))
    case "send":
      return runSend(ctx, MCP_TOOL_INPUTS.send.parse(args))
    case "inbox":
      return runInbox(ctx, MCP_TOOL_INPUTS.inbox.parse(args))
    case "ack":
      return runAck(ctx, MCP_TOOL_INPUTS.ack.parse(args))
    case "roster":
      return runRoster(ctx, MCP_TOOL_INPUTS.roster.parse(args))
    case "conversation":
      return runConversation(ctx, MCP_TOOL_INPUTS.conversation.parse(args))
    case "group":
      return runGroup(ctx, MCP_TOOL_INPUTS.group.parse(args))
    case "shout":
      return runShout(ctx, MCP_TOOL_INPUTS.shout.parse(args))
    case "status":
      return runStatus(ctx, MCP_TOOL_INPUTS.status.parse(args))
    case "message_status":
      return runMessageStatus(ctx, MCP_TOOL_INPUTS.message_status.parse(args))
    case "ask":
      return runAsk(ctx, MCP_TOOL_INPUTS.ask.parse(args))
    case "respond_ask":
      return runRespondAsk(ctx, MCP_TOOL_INPUTS.respond_ask.parse(args))
  }
}

/** 按 `MCP_TOOLS` 顺序注册十二工具；入参 schema 一律取 `MCP_TOOL_INPUTS[name]`。 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const name of MCP_TOOLS) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: MCP_TOOL_INPUTS[name] },
      async (args: unknown) => {
        try {
          return toolResult(await runTool(name, args, ctx))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  }
}
