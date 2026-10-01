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

/** 错误 → `{isError:true}` 文本结果（`Name: message [code]`），handler 不向上抛。 */
export function errorResult(error: unknown): CallToolResult {
  const err = error instanceof Error ? error : new Error(String(error))
  const code = STABLE_CODE_BY_NAME[err.name] ?? errorCode(err)
  const suffix = code === undefined ? "" : ` [${code}]`
  return { content: [{ type: "text", text: `${err.name}: ${err.message}${suffix}` }], isError: true }
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
