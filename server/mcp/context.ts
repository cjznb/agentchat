/**
 * MCP 工具共用上下文与结果渲染（spec §9）—— `tools.ts`（写工具）与
 * `read-tools.ts`（读/策略工具）共享的类型、错误契约与 `send` 结果序列化。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { SendMessageResult } from "../core/messaging"
import type { ApprovalRequested } from "../core/permissions"
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

/** 错误 → `{isError:true}` 文本结果（`Name: message [code]`），handler 不向上抛。 */
export function errorResult(error: unknown): CallToolResult {
  const err = error instanceof Error ? error : new Error(String(error))
  const code = errorCode(err)
  const suffix = code === undefined ? "" : ` [${code}]`
  return { content: [{ type: "text", text: `${err.name}: ${err.message}${suffix}` }], isError: true }
}

export function isApproval(value: object): value is ApprovalRequested {
  return "approval" in value
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
  readonly reply?: { readonly timedOut: boolean }
}

export function sendView(result: SendResultView): Record<string, unknown> {
  return {
    message: result.message,
    receipts: result.receipts,
    readReceipts: result.receipts.filter((r) => r.stage === "read"),
    ...(result.reply === undefined ? {} : { reply: result.reply }),
  }
}
