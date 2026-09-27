#!/usr/bin/env node
/**
 * SubagentStart hook：把 Claude Code 派生的子代理注册为 Hub 子节点。
 *
 * 语义（控制器裁决 ②）：`register{vendor, purpose, parent_ref, task_ref}`。
 * - `task_ref` = 载荷 `agent_id`（子代理唯一 id；缺失时退回 `session_id`）。
 * - `parent_ref` **兜底②「父回合窗口」**：Claude Code 的 SubagentStart 载荷**不含父引用字段**
 *   （官方文档 Common input fields 仅新增 `agent_id`/`agent_type`，见报告 §4），故按
 *   `<home>/agents/claude-code.root.json` 记录的「当前活跃根回合」关联；无则跳过（绝不误挂）。
 * - 记录 `<home>/agents/claude-code.subs.json` 的 `agent_id → Hub 节点 id` 映射，供 busy 上报归属。
 * - 上报该子节点 `busy`（新派生即开工）。
 *
 * TODO(待真机核实)：SubagentStart 载荷是否加入父/会话关联字段；若加入，应优先使用并保留本兜底。
 * 任何失败只记日志、退出码 0。
 */
import {
  adapterPaths,
  appendLog,
  hubConfig,
  mcpRegister,
  readStdinJson,
  reportState,
  resolveHome,
  runHook,
} from "./common.mjs"
import { errorMessage, readJson, writeJson } from "./token.mjs"

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "SubagentStart: HUB_TOKEN missing; skip registration")
    return
  }

  const root = readJson(paths.root)
  const parentRef = root !== undefined && typeof root["agentId"] === "string" ? root["agentId"] : undefined
  if (parentRef === undefined) {
    appendLog(home, "SubagentStart: no active root turn window; skip child registration")
    return
  }

  const claudeAgentId = typeof input["agent_id"] === "string" ? input["agent_id"] : undefined
  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : undefined
  const agentType = typeof input["agent_type"] === "string" ? input["agent_type"] : undefined
  const taskRef = claudeAgentId ?? sessionId ?? `sub-${Date.now()}`

  const registered = await mcpRegister(config, {
    vendor: "claude-code",
    purpose: agentType ?? "subagent",
    parent_ref: parentRef,
    task_ref: taskRef,
  })

  if (claudeAgentId !== undefined) {
    const subs = readJson(paths.subs) ?? {}
    subs[claudeAgentId] = {
      agentId: registered.agentId,
      agentType: agentType ?? null,
      sessionId: sessionId ?? null,
      at: Date.now(),
    }
    writeJson(paths.subs, subs)
  }

  try {
    await reportState(config, registered.agentId, "busy")
  } catch (error) {
    appendLog(home, `SubagentStart: state busy failed: ${errorMessage(error)}`)
  }
}

runHook("SubagentStart", main)
