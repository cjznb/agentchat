#!/usr/bin/env node
/**
 * UserPromptSubmit hook：会话存活心跳（`busy`）+ 补拉积压消息，并把待投内容并入本轮提示。
 *
 * 两个作用：
 * 1. **懒注册兜底**：插件可能在会话已开始后才被启用 —— 这里补一次 `ensureSession`，
 *    使"错过 SessionStart"的会话也能成为 Hub 里的可寻址节点（指南 §7 坑 4）。
 * 2. **cron 哨兵回路**（README §空闲期唤醒 形态②）：若 `CronCreate` 定时投递的 prompt 走本
 *    hook，则取件逻辑留在 hook（可离线、可测），有件即注入、无件则让本轮快速空跑。
 *
 * 注入通道：`hookSpecificOutput.additionalContext`（`hookEventName="UserPromptSubmit"`）。
 * 任何失败只记日志、退出码 0。
 */
import { loadContext } from "../lib/context.mjs"
import { flush } from "../lib/flush.mjs"
import { emit, runHook } from "../lib/hook-io.mjs"
import { appendLog } from "../lib/log.mjs"
import { resolveHome } from "../lib/paths.mjs"
import { ensureSession } from "../lib/register.mjs"

async function main() {
  const { paths, config, input, sessionId, cwd, log } = await loadContext()
  if (config.token === "") {
    log("UserPromptSubmit: hub token missing; skip")
    return
  }
  if (sessionId === undefined) {
    log("UserPromptSubmit: payload has no session_id; skip")
    return
  }

  const node = await ensureSession(config, paths, { sessionId, cwd }, log)
  if (node === undefined) return

  let injected
  await flush({
    config,
    paths,
    agentId: node.agentId,
    containerId: node.containerId,
    state: "busy",
    deliver: (_messages, text) => {
      injected = text
      return true
    },
    log,
  })
  if (injected === undefined) {
    log(`UserPromptSubmit: heartbeat ok (prompt ${String(input["prompt"] ?? "").slice(0, 40)}…)`)
    return
  }
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: injected } })
}

runHook("UserPromptSubmit", (message) => appendLog(resolveHome(process.env), message, "UserPromptSubmit"), main)
