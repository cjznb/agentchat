/**
 * MCP 请求批示工具（spec §17；Task 3）—— `ask` / `respond_ask`。
 *
 * 自 `tools.ts` 拆出（MCP 工具文件 ≤250 纯行红线，controller 决议 5 授权）。
 * 复用既有审批底座：发起方 / 答复者均取连接身份（`ctx.agentId`），答案序列化与
 * core `awaitAsk` 返回对齐 —— 已决取 `ask.result` 的 `choice`/`text`，超时仅 `{timedOut:true}`。
 */
import type { McpToolInput } from "../../shared/contracts"
import { ask, respondAsk, type AskWaitResult } from "../core/permissions"
import { requireIdentity, type ToolContext } from "./context"

/** `ask` 出参：已决取 `result` 的 `choice`/`text`；超时仅 `{timedOut:true}`（spec §9）。 */
function replyView(result: AskWaitResult): { timedOut: boolean; choice?: string; text?: string } {
  if (result.timedOut) return { timedOut: true }
  const answer = result.ask.result ?? {}
  const choice = answer["choice"]
  const text = answer["text"]
  return {
    timedOut: false,
    ...(typeof choice === "string" ? { choice } : {}),
    ...(typeof text === "string" ? { text } : {}),
  }
}

/** `ask`：发起方 = 连接身份；不带 `wait` 直接返回单据，带则阻塞至答复 / 超时。 */
export function runAsk(ctx: ToolContext, input: McpToolInput<"ask">): Promise<unknown> | unknown {
  const from = requireIdentity(ctx)
  const base = {
    to: input.to,
    question: input.question,
    options: input.options,
    ...(input.allow_custom === undefined ? {} : { allowCustom: input.allow_custom }),
  }
  if (input.wait === undefined) return { ask: ask(ctx.db, from, base).ask }
  // 字面量陷阱规避（同 `runSend`）：内联重建 `{until,timeoutMs}`，不经 optional 字段透传。
  return ask(ctx.db, from, {
    ...base,
    wait: { until: input.wait.until, timeoutMs: input.wait.timeoutMs },
  }).then((result) => ({ ask: result.ask, reply: replyView(result) }))
}

/** `respond_ask`：答复者 = 连接身份；返回已决单据（`status='answered'` + `result`）。 */
export function runRespondAsk(ctx: ToolContext, input: McpToolInput<"respond_ask">): unknown {
  const responder = requireIdentity(ctx)
  return respondAsk(ctx.db, input.ask_id, responder, {
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.text === undefined ? {} : { text: input.text }),
  })
}
