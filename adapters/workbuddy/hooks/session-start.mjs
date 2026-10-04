#!/usr/bin/env node
/**
 * SessionStart hook：注册（实例容器 + 本会话节点）→ 上报 online → **兜底拉取**积压消息。
 *
 * 为什么是"兜底"：WorkBuddy 的 hook 是**一次性进程**，没有任何常驻推送通道；真正的空闲期
 * 收件靠宿主内建会话级 cron（见 README §空闲期唤醒）。本 hook 负责把"会话一开就把排队中的
 * 消息投出去"这条最短路径走通（指南 §7 坑 3：**登记成功即拉一次**）。
 *
 * 注入通道：`hookSpecificOutput.additionalContext`（`hookEventName` 必须写成 `SessionStart`）。
 * 任何失败只记日志、退出码 0（不得阻塞宿主）。
 */
import { loadContext } from "../lib/context.mjs"
import { flush } from "../lib/flush.mjs"
import { emit, runHook } from "../lib/hook-io.mjs"
import { appendLog } from "../lib/log.mjs"
import { resolveHome } from "../lib/paths.mjs"
import { ensureSession } from "../lib/register.mjs"
import { writeJson } from "../lib/token.mjs"
import { envFlag } from "../lib/util.mjs"

/**
 * 「空闲期自动收件」的开通提示（**默认关闭**，`AGENTCHAT_CRON_ARM=1` 开启）。
 *
 * 为什么是"提示"而不是直接装上：宿主的内建 cron 只能经 **`CronCreate` 工具**创建，hook 进程
 * 无权调用宿主工具（不是 API 缺失，而是权限模型如此）。故这里把开通动作交给模型自己执行一次。
 * SessionStart 的 `additionalContext` 官方语义偏"显示给用户"，**送达模型不保证** —— 因此这是
 * 尽力而为的开通路径，可靠路径是用户在会话里执行 `/loop 1m [AgentChat] poll`（见 README）。
 */
function cronArmNotice(intervalMs) {
  const minutes = Math.max(1, Math.round(intervalMs / 60000))
  return [
    "[AgentChat] 若需要「会话完全空闲时也能自动收件」，请立即调用一次 CronCreate 工具开通轮询：",
    `  cron: "*/${minutes} * * * *"（本地时间，按需调整）, prompt: "[AgentChat] poll", recurring: true`,
    "注意：recurring 任务 3 天后自动过期，需要重新挂；也可以由用户执行 /loop 1m [AgentChat] poll。",
  ].join("\n")
}

async function main() {
  const { paths, config, input, sessionId, cwd, log } = await loadContext()
  if (config.token === "") {
    log("SessionStart: hub token missing (start the Hub first); skip registration")
    return
  }
  if (sessionId === undefined) {
    log("SessionStart: payload has no session_id; skip registration")
    return
  }

  const node = await ensureSession(config, paths, { sessionId, cwd }, log)
  if (node === undefined) {
    log("SessionStart: node registration failed; skip")
    return
  }
  writeJson(paths.root, { sessionId, agentId: node.agentId, containerId: node.containerId, at: Date.now() })

  let injected
  const result = await flush({
    config,
    paths,
    agentId: node.agentId,
    containerId: node.containerId,
    state: "online",
    deliver: (_messages, text) => {
      injected = text
      return true
    },
    log,
  })

  const cronArm = envFlag(process.env, "AGENTCHAT_CRON_ARM", false)
  const notice = cronArm ? cronArmNotice(Number.parseInt(process.env["AGENTCHAT_CRON_MS"] ?? "60000", 10) || 60000) : undefined
  const parts = [injected, notice].filter((value) => typeof value === "string" && value !== "")
  if (parts.length === 0) {
    log(`SessionStart: ${node.degraded === true ? "degraded to container identity; " : ""}no backlog`)
    return
  }
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } })
  if (result.fresh.length > 0) log(`SessionStart: injected ${result.fresh.length} message(s)`)
  else log(`SessionStart: emitted cron-arm notice (${input["source"] ?? "unknown"} source)`)
}

runHook("SessionStart", (message) => appendLog(resolveHome(process.env), message, "SessionStart"), main)
