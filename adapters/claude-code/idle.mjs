#!/usr/bin/env node
/**
 * Stop / Notification(idle_prompt) hook：空闲时上报 idle 并注入积压消息。
 *
 * 注入路线（控制器裁决 ② + 官方文档核实，见报告 §2）：
 * - 首选 **Stop**：先 `POST /internal/state {idle}`，再 `wake` 认领积压；有**新**消息则向 stdout 输出
 *   `{"decision":"block","reason":…,"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}`，
 *   使 Claude 继续回合并按注入内容工作；随后 `/internal/result` 回执 delivered。
 * - **双通道保底**：正文**同时镜像进 `reason`**（Stop block 必被采纳字段），避免宿主拒绝/忽略
 *   `additionalContext` 时模型看不到消息；`delivered` **仅在确实产出注入载荷后**上报。
 * - **Notification(idle_prompt)**：仅上报 idle。Claude Code 的 `additionalContext` 不覆盖 Notification，
 *   且 `wake` 会认领（在途租约）消息，若无法投递会造成丢失，故此处**不 wake**、不报 delivered。
 *
 * 稳健性（review Important #2：**链内计数 + 链边界重置**，修复“永久饥饿”）：
 * - 官方语义：`stop_hook_active === true` 表示「因 Stop 注入而继续」的**同一链**；
 *   `stop_hook_active !== true`（新回合/新链）→ **计数归零**。故同一链内 ≤`MAX_BLOCKS` 次 block
 *   （防死循环），**新链可再次 block**（旧实现达上限后永久放行 → 会话再也无法被唤醒）。
 * - 宿主另设「8 连续续跑」硬上限（官方 hooks reference），与本适配器的链内上限双保险。
 * - 租约重投去重（review pull 语义）：Hub 的 `wake` 认领为 30s 在途租约，未回执则重投；
 *   故按 `messageId` 跳过已注入者，**仅补回执**，绝不重复注入（去重集合有界）。
 *
 * 任何失败只记日志、退出码 0（不得阻塞宿主）。
 */
import {
  adapterPaths,
  appendLog,
  deliveredItems,
  emit,
  hubConfig,
  injectionPayload,
  loadSeen,
  readBlockCount,
  readStdinJson,
  rememberSeen,
  reportResultSafe,
  reportState,
  resolveHome,
  runHook,
  wake,
  writeBlockCount,
} from "./common.mjs"
import { errorMessage, readText } from "./token.mjs"

/** 每链（同 `session_id` 的一串续跑）连续 block 上限；达到后放行且不再 wake。 */
const MAX_BLOCKS = 3

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

  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : undefined
  const chainContinuing = input["stop_hook_active"] === true
  const stored = readBlockCount(paths.stop, sessionId)
  if (!chainContinuing && stored !== 0) {
    // 链边界（新回合/新链）：计数归零，使新链可再次 block。
    writeBlockCount(paths.stop, sessionId, 0)
  }
  const prior = chainContinuing ? stored : 0
  if (prior >= MAX_BLOCKS) {
    appendLog(home, `idle(Stop): chain block cap ${MAX_BLOCKS} reached; pass without wake`)
    return
  }

  let messages
  try {
    messages = await wake(config, agentId)
  } catch (error) {
    appendLog(home, `idle(Stop): wake failed: ${errorMessage(error)}`)
    return
  }

  const seen = loadSeen(paths)
  const fresh = messages.filter((m) => !seen.has(m.id))
  const dup = messages.filter((m) => seen.has(m.id))

  if (messages.length === 0) {
    if (prior !== 0) writeBlockCount(paths.stop, sessionId, 0)
    return
  }
  if (fresh.length === 0) {
    // 仅租约重投的重复消息：绝不重复注入，仅补回执；链不再需要，计数归零。
    await reportResultSafe(config, agentId, deliveredItems(dup))
    if (prior !== 0) writeBlockCount(paths.stop, sessionId, 0)
    return
  }

  emit(injectionPayload(fresh, "Stop"))
  rememberSeen(
    paths,
    fresh.map((m) => m.id),
  )
  writeBlockCount(paths.stop, sessionId, prior + 1)
  await reportResultSafe(config, agentId, [...deliveredItems(fresh), ...deliveredItems(dup)])
}

runHook("idle", main)
