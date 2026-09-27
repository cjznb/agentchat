#!/usr/bin/env node
/**
 * SessionStart hook：注册/重连本会话节点并上报 online，同时作为「空闲注入」的兜底拉取。
 *
 * 语义（控制器裁决 ②）：
 * - 有 token → MCP `register{join_token}` **认领重连**；陈旧 token（`invalid_join_token`）
 *   → 清除后按「无 token 首次注册」重新注册为根并写回新 token（此路径不产生重复根）。
 * - 无 token → MCP `register` 根；把返回的 `join_token` 写 `<home>/agents/claude-code.token`(0600)。
 * - 落盘节点 agent id 与「当前根回合窗口」`claude-code.root.json`（供 SubagentStart 父关联兜底）。
 * - `POST /internal/state {online}`。
 * - 兜底：`wake` 拉取积压并以 `hookSpecificOutput.additionalContext` 注入（Stop 注入不可用时的降级路径）。
 *
 * 任何失败只记日志、退出码 0（不得阻塞宿主）。
 */
import {
  adapterPaths,
  appendLog,
  deliveredItems,
  emit,
  formatMessages,
  HubToolError,
  hubConfig,
  mcpRegister,
  readStdinJson,
  reportResult,
  reportState,
  resolveHome,
  runHook,
  wake,
} from "./common.mjs"
import { errorMessage, readText, removeFile, writeJson, writeText, writeToken } from "./token.mjs"

const REGISTER_ROOT = { vendor: "claude-code", purpose: "coding-agent" }

async function registerWithClaim(config, home) {
  const tokenPath = adapterPaths(home).token
  const existing = readText(tokenPath)
  const args = existing === undefined ? REGISTER_ROOT : { ...REGISTER_ROOT, join_token: existing }
  try {
    return await mcpRegister(config, args)
  } catch (error) {
    if (existing !== undefined && error instanceof HubToolError && error.code === "invalid_join_token") {
      appendLog(home, "SessionStart: stale join_token rejected; clearing and re-registering as root")
      removeFile(tokenPath)
      return mcpRegister(config, REGISTER_ROOT)
    }
    throw error
  }
}

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "SessionStart: HUB_TOKEN missing; skip registration")
    return
  }

  const registered = await registerWithClaim(config, home)
  const idWrite = writeText(paths.agentId, registered.agentId)
  if (!idWrite.ok) appendLog(home, `SessionStart: agent id write failed: ${idWrite.error}`)
  if (registered.joinToken !== undefined) {
    const tokenWrite = writeToken(paths.token, registered.joinToken)
    if (!tokenWrite.ok) appendLog(home, `SessionStart: token write failed: ${tokenWrite.error}`)
  }
  writeJson(paths.root, {
    agentId: registered.agentId,
    sessionId: typeof input["session_id"] === "string" ? input["session_id"] : undefined,
    at: Date.now(),
  })

  try {
    await reportState(config, registered.agentId, "online")
  } catch (error) {
    appendLog(home, `SessionStart: state online failed: ${errorMessage(error)}`)
  }

  // 兜底拉取：Stop 注入不可用时消息不会丢失（见到即注入并回执 delivered）。
  try {
    const messages = await wake(config, registered.agentId)
    if (messages.length > 0) {
      emit({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: formatMessages(messages),
        },
      })
      await reportResult(config, registered.agentId, deliveredItems(messages))
    }
  } catch (error) {
    appendLog(home, `SessionStart: backlog pull failed: ${errorMessage(error)}`)
  }
}

runHook("SessionStart", main)
