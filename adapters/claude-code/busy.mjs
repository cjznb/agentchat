#!/usr/bin/env node
/**
 * PreToolUse / PostToolUse hook：把宿主正在执行工具（即「忙碌」）上报为 `busy`。
 *
 * 语义（控制器裁决 ②）：`POST /internal/state {busy}`。
 * - 节点归属：若载荷含 `agent_id`（在子代理内触发的工具事件）且 `<home>/agents/claude-code.subs.json`
 *   有映射，则上报该子节点；否则回落到根节点 id 文件。
 * - 同态重复上报在 Hub 侧等价心跳触碰（server `applyAgentState`），故不本地去重。
 *
 * 任何失败只记日志、退出码 0（不得阻塞宿主；PreToolUse 尤其不得误 block）。
 */
import {
  adapterPaths,
  appendLog,
  hubConfig,
  isRecord,
  readStdinJson,
  reportState,
  resolveHome,
  runHook,
} from "./common.mjs"
import { readJson, readText } from "./token.mjs"

function resolveNode(paths, claudeAgentId) {
  if (claudeAgentId !== undefined) {
    const subs = readJson(paths.subs)
    if (subs !== undefined) {
      const mapped = subs[claudeAgentId]
      if (isRecord(mapped) && typeof mapped["agentId"] === "string") return mapped["agentId"]
    }
  }
  return readText(paths.agentId)
}

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "busy: HUB_TOKEN missing; skip")
    return
  }
  const claudeAgentId = typeof input["agent_id"] === "string" ? input["agent_id"] : undefined
  const agentId = resolveNode(paths, claudeAgentId)
  if (agentId === undefined) {
    appendLog(home, "busy: no mapped agent for this hook call; skip")
    return
  }
  await reportState(config, agentId, "busy")
}

runHook("busy", main)
