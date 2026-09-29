/**
 * MCP 请求批示工具（spec §17/§3；Task 3 → Task 4 群形态）—— `ask` / `respond_ask`。
 *
 * 自 `tools.ts` 拆出（MCP 工具文件 ≤250 纯行红线，controller 决议 5 授权）。
 * 复用既有审批底座：发起方 / 答复者均取连接身份（`ctx.agentId`），答案序列化与
 * core `awaitAsk` 返回对齐 —— 已决取 `ask.result` 的 `choice`/`text`，超时仅 `{timedOut:true}`。
 * Task 4：`to` 为群会话 id → `askGroup`（一目标一卡、`scope` 聚合等待）出参 `{asks, reply?}`；
 * DM / `human` 出参 `{ask, reply?}` 形状逐字节不变。
 */
import type { McpToolInput } from "../../shared/contracts"
import { askGroup } from "../core/ask-group"
import { ask, groupConversation, respondAsk, type AskWaitResult } from "../core/permissions"
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

/** `ask`：发起方 = 连接身份；群会话 id 走 `askGroup`，其余（DM/`human`）走既有单卡路径。 */
export function runAsk(ctx: ToolContext, input: McpToolInput<"ask">): Promise<unknown> | unknown {
  const from = requireIdentity(ctx)
  const base = {
    to: input.to,
    question: input.question,
    options: input.options,
    ...(input.allow_custom === undefined ? {} : { allowCustom: input.allow_custom }),
  }
  if (groupConversation(ctx.db, input.to) !== undefined) {
    const groupBase = {
      ...base,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    }
    if (input.wait === undefined) return askGroup(ctx.db, from, groupBase)
    // 字面量陷阱规避（同 `runSend`）：内联重建 `{until,timeoutMs,scope}`，不经 optional 透传。
    const wait = {
      until: input.wait.until,
      timeoutMs: input.wait.timeoutMs,
      ...(input.wait.scope === undefined ? {} : { scope: input.wait.scope }),
    }
    return askGroup(ctx.db, from, { ...groupBase, wait })
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
