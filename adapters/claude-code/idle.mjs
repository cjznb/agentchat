#!/usr/bin/env node
/**
 * Stop / Notification(idle_prompt) hook：空闲时上报 idle 并注入积压消息。
 *
 * 注入路线（控制器裁决 ② + 官方文档核实，见报告 §2）：
 * - 首选 **Stop**：先 `POST /internal/state {idle}`，再 `wake` 认领积压；有消息则向 stdout 输出
 *   `{"decision":"block","reason":…,"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}`，
 *   使 Claude 继续回合并按注入内容工作；随后 `/internal/result` 回执 delivered。
 * - **双通道保底（review Important #1）**：消息正文**同时镜像进 `reason`**（Stop block 的必被采纳字段），
 *   避免宿主拒绝/忽略 `additionalContext` 时模型看不到消息；`delivered` **仅在确实产出注入载荷后**上报。
 * - **Notification(idle_prompt)**：仅上报 idle。Claude Code 的 `additionalContext` 不覆盖 Notification，
 *   且 `wake` 会认领（job→accepted）消息，若无法投递会造成丢失，故此处**不 wake**、不报 delivered，
 *   注入统一交由 Stop 承担（文档明示降级策略）。
 * - **稳健性（review Important #2）**：`stop_hook_active === true` → 立即放行（不 wake、不 block）；
 *   每会话连续 block 计数上限 `MAX_BLOCKS`，超限放行且**不再 wake**（避免认领后无法投递）；
 *   无消息时把计数归零。
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
import { errorMessage, readJson, readText, writeJson } from "./token.mjs"

/** 每会话连续 block 上限；达到后放行且不再 wake（消息留待下次正常 Stop）。 */
const MAX_BLOCKS = 3

/** 注入载荷：`reason` 与 `additionalContext` 双通道都带正文（reason 为保底通道）。 */
export function injectionPayload(messages) {
  return {
    decision: "block",
    reason: `[AgentChat] 你收到了 ${messages.length} 条来自其他 agent 的待处理消息；请阅读并响应后再结束回合。\n${formatMessages(messages)}`,
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: formatMessages(messages) },
  }
}

function stopCount(paths, sessionId) {
  const state = readJson(paths.stop)
  if (state === undefined || typeof state["count"] !== "number") return 0
  return state["sessionId"] === sessionId ? state["count"] : 0
}

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

  // 上一个 Stop 已 block 续跑：立即放行，避免死循环。
  if (input["stop_hook_active"] === true) {
    appendLog(home, "idle(Stop): stop_hook_active; pass without wake/block")
    return
  }

  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : undefined
  const prior = stopCount(paths, sessionId)
  if (prior >= MAX_BLOCKS) {
    appendLog(home, `idle(Stop): block cap ${MAX_BLOCKS} reached; pass without wake`)
    return
  }

  let messages
  try {
    messages = await wake(config, agentId)
  } catch (error) {
    appendLog(home, `idle(Stop): wake failed: ${errorMessage(error)}`)
    return
  }
  if (messages.length === 0) {
    if (prior !== 0) writeJson(paths.stop, { sessionId, count: 0, at: Date.now() })
    return
  }

  emit(injectionPayload(messages))
  writeJson(paths.stop, { sessionId, count: prior + 1, at: Date.now() })
  try {
    await reportResult(config, agentId, deliveredItems(messages))
  } catch (error) {
    appendLog(home, `idle(Stop): result report failed: ${errorMessage(error)}`)
  }
}

runHook("idle", main)
