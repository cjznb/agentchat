#!/usr/bin/env node
/**
 * SubagentStart hook：把 Claude Code 派生的子代理注册为 Hub 子节点。
 *
 * 语义（控制器裁决 ② + review Important #3）：
 * - `register{vendor, purpose, parent_ref, task_ref}`。
 * - `parent_ref` **父回合窗口兜底**：Claude Code 的 SubagentStart 载荷**不含父引用字段**
 *   （官方文档 Common input fields 仅新增 `agent_id`/`agent_type`，见报告 §3），故按
 *   `<home>/agents/claude-code.root.json` 的「当前活跃根回合」关联。
 *   **必须 `root.sessionId === input.session_id`** 才使用，否则跳过并 warn——避免多终端共享
 *   `AGENTCHAT_HOME` 时后写覆盖导致子节点错挂到别家根。
 * - `task_ref`：优先载荷 `agent_id`（子代理唯一 id）；缺失时用**该会话内的单调序号**
 *   `<home>/agents/claude-code.subseq.json`（`sub-<n>`），保证同会话内唯一，避免退化为
 *   裸 `session_id` 导致多个无 `agent_id` 子代理撞键。
 * - 记录 `<home>/agents/claude-code.subs.json` 的 `agent_id → Hub 节点 id` 映射，供 busy 归属。
 * - 上报该子节点 `busy`（新派生即开工）。
 *
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

function nextSessionSeq(paths, sessionId) {
  const seqs = readJson(paths.subseq) ?? {}
  const current = typeof seqs[sessionId] === "number" ? seqs[sessionId] : 0
  const next = current + 1
  seqs[sessionId] = next
  writeJson(paths.subseq, seqs)
  return `sub-${next}`
}

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "SubagentStart: HUB_TOKEN missing; skip registration")
    return
  }

  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : undefined
  const root = readJson(paths.root)
  const rootAgentId = root !== undefined && typeof root["agentId"] === "string" ? root["agentId"] : undefined
  const rootSessionId = root !== undefined && typeof root["sessionId"] === "string" ? root["sessionId"] : undefined
  if (rootAgentId === undefined || rootSessionId === undefined || rootSessionId !== sessionId) {
    appendLog(
      home,
      `SubagentStart: no matching root turn window for session ${sessionId ?? "<none>"}; skip child registration`,
    )
    return
  }

  const claudeAgentId = typeof input["agent_id"] === "string" ? input["agent_id"] : undefined
  const agentType = typeof input["agent_type"] === "string" ? input["agent_type"] : undefined
  const taskRef = claudeAgentId ?? nextSessionSeq(paths, sessionId)

  const registered = await mcpRegister(config, {
    vendor: "claude-code",
    purpose: agentType ?? "subagent",
    parent_ref: rootAgentId,
    task_ref: taskRef,
  })

  if (claudeAgentId !== undefined) {
    const subs = readJson(paths.subs) ?? {}
    subs[claudeAgentId] = {
      agentId: registered.agentId,
      agentType: agentType ?? null,
      sessionId,
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
