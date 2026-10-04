#!/usr/bin/env node
/**
 * Notification hook（matcher `idle_prompt`）：**只上报空闲心跳，不取件**。
 *
 * 为什么不在这里取件：`Notification` 的 `hookSpecificOutput` **没有 `additionalContext` 槽位**
 * （官方行为表：仅"显示给用户"），而 `wake` 是**在途租约**——在此认领却无法投递，会让消息在
 * 租约到期前处于"已认领但未交付"的悬空态。故取件统一由 `Stop` / `UserPromptSubmit` / `SessionStart`
 * 承担（与 Claude Code 适配器同一取舍）。
 *
 * 另注：WorkBuddy 的 `idle_prompt` 是**一次性的 60s 定时器**触发，不是周期事件 → 只能当状态信号，
 * 不能当轮询器（空闲期轮询见 README §空闲期唤醒）。
 *
 * 任何失败只记日志、退出码 0。
 */
import { loadContext } from "../lib/context.mjs"
import { heartbeat } from "../lib/flush.mjs"
import { runHook } from "../lib/hook-io.mjs"
import { appendLog } from "../lib/log.mjs"
import { resolveHome } from "../lib/paths.mjs"
import { ensureSession } from "../lib/register.mjs"

async function main() {
  const { paths, config, input, sessionId, cwd, log } = await loadContext()
  const type = typeof input["notification_type"] === "string" ? input["notification_type"] : ""
  if (type !== "idle_prompt") {
    log(`Notification: ${type === "" ? "unknown" : type} ignored (only idle_prompt handled)`)
    return
  }
  if (config.token === "") {
    log("Notification(idle_prompt): hub token missing; skip")
    return
  }
  if (sessionId === undefined) {
    log("Notification(idle_prompt): payload has no session_id; skip")
    return
  }
  const node = await ensureSession(config, paths, { sessionId, cwd }, log)
  if (node === undefined) return
  await heartbeat(config, node.agentId, node.containerId, "idle", log)
}

runHook("Notification", (message) => appendLog(resolveHome(process.env), message, "Notification"), main)
