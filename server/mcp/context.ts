/**
 * MCP 工具共用上下文与结果渲染（spec §9）—— `tools.ts`（写工具）与
 * `read-tools.ts`（读/策略工具）共享的类型、错误契约与 `send` 结果序列化。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Receipt, SendMessageResult } from "../core/messaging"
import { maskRevokedForReader } from "../core/revoke"
import type { WaitResult } from "../core/wait"
import type { Db } from "../db"

/** MCP 会话上下文：共享库句柄 + join_token 落盘目录 + 可选已识别身份（`x-agent-id`，register 起可写）。 */
export interface ToolContext {
  readonly db: Db
  readonly home: string
  agentId?: string
}

/** 工具错误（带稳定 `code`，经 `errorResult` 渲染进文本）。 */
export class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "McpToolError"
  }
}

export function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

/** 窄类型守卫：Error 上可选的字符串 `code`（core 域错误的契约字段）。 */
function errorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined
  const value: unknown = error.code
  return typeof value === "string" ? value : undefined
}

/**
 * 稳定码补映射（错误映射审计）：以下类在工具路径会被抛出但**无** `code`
 * （或携带驱动层原始 code），原样透出即 raw —— 按类名归一为稳定错误码；
 * 自带 `code` 的域错误（RecipientNotFound / SelfSendError / RegistrationError…）不经此表。
 */
const STABLE_CODE_BY_NAME: Record<string, string> = {
  AgentNotFoundError: "agent_not_found",
  SqliteError: "storage_error",
  ZodError: "invalid_input",
}

/**
 * 常见稳定码 → 「下一步」（P4 可发现性）：错误只报"是什么"不够，agent 需要"然后呢"。
 * 未列出的码不加尾注（保持既有文案逐字不变）。
 */
const NEXT_STEP_BY_CODE: Record<string, string> = {
  identity_required: "先调用 register 取得身份（或用 initialize 的 x-agent-id / 逐调用 x-agentchat-session）再重试。",
  name_taken: "换一个 name 重试，或带 task_ref 认领既有节点。",
  parent_not_found: "先用 roster 取父节点的 id 或系统名后重试。",
  task_ref_required: "带 parent_ref 时必须同时提供 task_ref（通常=会话 id）。",
  agent_not_found: "用 roster 确认 agent id 后重试。",
  recipient_not_found: "用 roster 取正确的 agent id；发群消息请用群会话 id。",
  not_participant: "先用 group{op:list} 找到群与 is_member，再 group{op:add} 把自己拉进群（可能需人工批准）。",
  use_shout_tool: 'send 不接受 "*"：要全员广播请改用 shout 工具。',
  container_not_chat_target: "分组容器不是聊天对象：改发给真实节点或会话。",
  container_not_group_member: "分组容器不能入群/当群成员：成员请用真实 agent。",
  container_cannot_send: "容器身份不能发言：请以会话节点身份调用工具。",
  invalid_input: "按参数 description 修正入参后重试。",
  storage_error: "稍后重试；若持续失败请告知人类（可能是库锁或外键约束）。",
  ask_already_answered: "该 ask 已答复过（首答生效），不要再答。",
  invalid_choice: "choice 必须取自 ask 的 options；自由答复请改用 text 且该 ask 需 allow_custom=true。",
  mentions_required: "群 ask 必须给 mentions（@ 群成员）。",
  mention_not_found: "mentions 里的名字/id 在该群没匹配到：先用 group{op:list} 核对成员。",
  mention_not_participant: "被 @ 的人不在该群：先 group{op:add} 拉人，或改 @ 群内成员。",
  self_send: "不要给自己发消息：改发给对方或所在群。",
}

/** 错误 → `{isError:true}` 文本结果（`Name: message｜下一步：… [code]`），handler 不向上抛。 */
export function errorResult(error: unknown): CallToolResult {
  const err = error instanceof Error ? error : new Error(String(error))
  const code = STABLE_CODE_BY_NAME[err.name] ?? errorCode(err)
  const next = code === undefined ? undefined : NEXT_STEP_BY_CODE[code]
  const suffix = code === undefined ? "" : ` [${code}]`
  // 顺序不可换：`[code]` 必须留在**行尾**（adapters/dsh/lib/mcp.js 用 `/\[([a-z_]+)\]\s*$/` 解析）。
  const hint = next === undefined ? "" : `｜下一步：${next}`
  return { content: [{ type: "text", text: `${err.name}: ${err.message}${hint}${suffix}` }], isError: true }
}

/** 除 `register` 外全部工具要求已识别身份（`x-agent-id`）。 */
export function requireIdentity(ctx: ToolContext): string {
  if (ctx.agentId === undefined) {
    throw new McpToolError("identity_required", "session has no identity; pass x-agent-id at initialize")
  }
  return ctx.agentId
}

/** `send`/`shout` 结果视图（`reply` 仅在带 `wait` 时出现）。 */
export interface SendResultView extends SendMessageResult {
  readonly reply?: WaitResult<Receipt>
}

/**
 * `send`/`shout` 结果序列化（唯一出参渲染点）。
 * `reply.messages` 逐条过 `maskRevokedForReader`（reader = 调用方），堵死「未投递等待者
 * 经 wait 回复读到撤回原文」的泄漏路径——与 `inbox`/`conversation` 共用同一决策点。
 */
export function sendView(db: Db, result: SendResultView, readerId: string): Record<string, unknown> {
  return {
    message: result.message,
    receipts: result.receipts,
    readReceipts: result.receipts.filter((r) => r.stage === "read"),
    // 提及回声（spec §3.3；仅群会话产出 → DM/喊话出参逐字节不变）。
    ...(result.mentions === undefined ? {} : { mentions: result.mentions }),
    ...(result.reply === undefined
      ? {}
      : { reply: maskReply(db, result.reply, readerId) }),
  }
}

/** `wait` 回复消息按读者遮蔽（撤回原文对未投递读者隐藏）。 */
function maskReply(db: Db, reply: WaitResult<Receipt>, readerId: string): WaitResult<Receipt> {
  return { ...reply, messages: reply.messages.map((m) => maskRevokedForReader(db, m, readerId)) }
}
