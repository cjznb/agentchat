#!/usr/bin/env node
/**
 * SessionEnd hook：**只停跟踪，绝不 `retire`**（指南 §6 铁律）。
 *
 * 依据：WorkBuddy **没有"会话被删除"事件**，`SessionEnd(reason)` 只表示"这一轮会话收尾"
 * （`clear` / `logout` / `prompt_input_exit` / `other`…）。而 `retire` 是**单向门**——退役后同
 * `task_ref` 的再注册**永久被拒**（`RegistrationError("retired")`），把"关闭"当"删除"会让用户
 * 重开同一会话时再也注册不上。
 *
 * 本适配器无长驻定时器需要停（hook 是一次性进程），故这里只做两件事：
 * 1. 记一行可诊断的日志（含 `reason`，便于真机排障）；
 * 2. 补一次 `idle` 心跳，让节点在 `last_seen` 阈值前保持"刚刚还在"的合理状态。
 *
 * 节点最终消失由 Hub 侧 `last_seen` 自然过期；**子节点不能主动报 `offline`**（`child_never_offline`）。
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
  const reason = typeof input["reason"] === "string" ? input["reason"] : "other"
  log(`SessionEnd: reason=${reason}; keep tracking, do NOT retire (node expires via last_seen)`)
  if (config.token === "" || sessionId === undefined) return
  const node = await ensureSession(config, paths, { sessionId, cwd }, log)
  if (node === undefined) return
  await heartbeat(config, node.agentId, node.containerId, "idle", log)
}

runHook("SessionEnd", (message) => appendLog(resolveHome(process.env), message, "SessionEnd"), main)
