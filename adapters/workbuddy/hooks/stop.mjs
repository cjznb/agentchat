#!/usr/bin/env node
/**
 * Stop hook：**入站唤醒的主入口**（指南 §3 Q2）。
 *
 * 两条等价的注入向量，本适配器采用第 1 条（已核实宿主源码）：
 * ```
 * !1 === t.continue && (i.shouldContinue = !1, i.stopReason = t.stopReason)
 * ```
 * 即 `{"continue":false,"stopReason":"…"}` → **阻止停止、把正文交给模型、继续对话**；
 * 第 2 条（退出码 2 + stderr）作为文档中的备选，本实现不依赖它。
 *
 * 正文**同时镜像**进 `stopReason` 与 `hookSpecificOutput.additionalContext`（双通道保底：
 * 宿主可能只采纳其中一个）。
 *
 * 防自激（两道锁）：
 * 1. `stop_hook_active === true` = "因 Stop 注入而续跑的**同一链**" → 链内计数，上限 {@link MAX_BLOCKS}；
 *    `false` = 新回合/新链 → 计数归零（保证**新链仍可被唤醒**，不会像早期实现那样永久放行）；
 * 2. 与 `stop_hook_active` 无关的**滚动窗口**计数（60s 内最多 `MAX_BLOCKS` 次注入）——防止
 *    宿主在某版本下不传该字段时出现"注入-停止"活锁。
 *
 * 任何失败只记日志、退出码 0。
 */
import { loadContext } from "../lib/context.mjs"
import { flush } from "../lib/flush.mjs"
import { emit, runHook } from "../lib/hook-io.mjs"
import { appendLog } from "../lib/log.mjs"
import { resolveHome } from "../lib/paths.mjs"
import { pollUntil } from "../lib/poll.mjs"
import { ensureSession } from "../lib/register.mjs"
import { readJson, writeJson } from "../lib/token.mjs"
import { envInt } from "../lib/util.mjs"

/** 同一链内连续注入上限（宿主另有"8 连续续跑"硬上限，本值与之双保险）。 */
export const MAX_BLOCKS = 3
/** 滚动窗口：`stop_hook_active` 不可用时的兜底计数窗口。 */
export const WINDOW_MS = 60_000

function readStopState(paths, sessionId) {
  const state = readJson(paths.stop)
  if (state === undefined || state.sessionId !== sessionId) return { count: 0, at: 0 }
  return { count: typeof state.count === "number" ? state.count : 0, at: typeof state.at === "number" ? state.at : 0 }
}

function writeStopState(paths, sessionId, count) {
  writeJson(paths.stop, { sessionId, count, at: Date.now() })
}

async function main() {
  const { paths, config, input, sessionId, cwd, log } = await loadContext()
  if (config.token === "") {
    log("Stop: hub token missing; pass through")
    return
  }
  if (sessionId === undefined) {
    log("Stop: payload has no session_id; pass through")
    return
  }

  const chainContinuing = input["stop_hook_active"] === true
  const stored = readStopState(paths, sessionId)
  // 链边界：新回合/新链 → 归零，使新链仍可被唤醒（修复"达上限后永久饥饿"）。
  if (!chainContinuing && stored.count !== 0) writeStopState(paths, sessionId, 0)
  const chainUsed = chainContinuing ? stored.count : 0
  const windowUsed = Date.now() - stored.at < WINDOW_MS ? stored.count : 0
  const used = Math.max(chainUsed, windowUsed)
  if (used >= MAX_BLOCKS) {
    log(`Stop: injection cap ${MAX_BLOCKS} reached (chain/window); pass through`)
    return
  }

  const node = await ensureSession(config, paths, { sessionId, cwd }, log)
  if (node === undefined) return

  /** 取一次件并在有**新**消息时产出注入正文；无新件 → `undefined`。 */
  const deliverOnce = async () => {
    let text
    const result = await flush({
      config,
      paths,
      agentId: node.agentId,
      containerId: node.containerId,
      state: "idle",
      deliver: (_messages, value) => {
        text = value
        return true
      },
      log,
    })
    return result.fresh.length > 0 ? text : undefined
  }

  let text = await deliverOnce()
  const longPollMs = envInt(process.env, "AGENTCHAT_STOP_LONGPOLL_MS", 0, 0, 120_000)
  if (text === undefined && longPollMs > 0) {
    log(`Stop: no fresh messages; bounded long-poll up to ${longPollMs}ms before handing control back`)
    text = await pollUntil({
      timeoutMs: longPollMs,
      intervalMs: 1000,
      probe: deliverOnce,
      onError: (error) => log(`Stop: long-poll probe failed: ${error}`),
    })
  }
  if (text === undefined) return

  emit({
    continue: false,
    stopReason: text,
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: text },
  })
  writeStopState(paths, sessionId, used + 1)
  log(`Stop: injected and continuing conversation (${used + 1}/${MAX_BLOCKS})`)
}

runHook("Stop", (message) => appendLog(resolveHome(process.env), message, "Stop"), main)
