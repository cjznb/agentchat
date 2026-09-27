#!/usr/bin/env node
/**
 * Stop / Notification(idle_prompt) hook：空闲时上报 idle 并注入积压消息。
 *
 * 注入路线（控制器裁决 ② + 官方文档核实，见报告 §2）：
 * - 首选 **Stop**：先 `POST /internal/state {idle}`，再 `wake` 认领积压；有消息则向 stdout 输出
 *   `{"decision":"block","reason":…,"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}`，
 *   使 Claude 继续回合并按注入内容工作；随后 `/internal/result` 回执 delivered。
 * - **Notification(idle_prompt)**：仅上报 idle。Claude Code 的 `additionalContext` 只在
 *   SessionStart/Setup/SubagentStart、UserPromptSubmit、PreToolUse/PostToolUse、Stop/SubagentStop 生效，
 *   Notification 无注入位；且 `wake` 会认领（job→accepted）消息，若无法投递会造成丢失。
 *   故此处**不 wake**，注入统一交由 Stop 承担（文档明示降级策略）。
 * - 防死循环：仅当 `wake` 确有消息时才 block；消息 delivered 后下次 wake 为空 → 自然终止。
 *
 * 任何失败只记日志、退出码 0（不得阻塞宿主）。
 */
import {
  adapterPaths,
  appendLog,
  deliveredItems,
  emit,
  formatMessages,
  hubConfig,
  readStdinJson,
  reportResult,
  reportState,
  resolveHome,
  runHook,
  wake,
} from "./common.mjs"
import { errorMessage, readText } from "./token.mjs"

const blockReason = (count) =>
  `[AgentChat] 你收到了 ${count} 条来自其他 agent 的待处理消息；请阅读并响应后再结束回合。`

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "idle: HUB_TOKEN missing; skip")
    return
  }
  const event = typeof input["hook_event_name"] === "string" ? input["hook_event_name"] : "Stop"
  const agentId = readText(paths.agentId)
  if (agentId === undefined) {
    appendLog(home, `idle(${event}): no registered agent; skip`)
    return
  }

  try {
    await reportState(config, agentId, "idle")
  } catch (error) {
    appendLog(home, `idle(${event}): state idle failed: ${errorMessage(error)}`)
  }

  if (event !== "Stop") {
    appendLog(home, `idle(${event}): injection delegated to Stop hook (no additionalContext slot)`)
    return
  }

  let messages
  try {
    messages = await wake(config, agentId)
  } catch (error) {
    appendLog(home, `idle(Stop): wake failed: ${errorMessage(error)}`)
    return
  }
  if (messages.length === 0) return

  emit({
    decision: "block",
    reason: blockReason(messages.length),
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: formatMessages(messages) },
  })
  try {
    await reportResult(config, agentId, deliveredItems(messages))
  } catch (error) {
    appendLog(home, `idle(Stop): result report failed: ${errorMessage(error)}`)
  }
}

runHook("idle", main)
