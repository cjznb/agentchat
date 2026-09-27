#!/usr/bin/env node
/**
 * SubagentStop hook：子代理完成时把**子节点**上报 idle、注入其积压消息并回执，
 * 随后退役该子节点（缺陷 #3/#4：子节点不再收不到待投递、运行期子节点不再永不退役）。
 *
 * 官方依据（code.claude.com/docs/en/hooks，核实 2026-09-28）：
 * - SubagentStop 输入在 Common input fields 之外含 `stop_hook_active`、`agent_id`、`agent_type`、
 *   `agent_transcript_path`、`last_assistant_message`。
 * - 「SubagentStop hooks use the same decision control format as Stop hooks, including
 *   hookSpecificOutput.additionalContext with hookEventName set to "SubagentStop" … Returning
 *   decision:"block" with a reason keeps the subagent running」→ 故用与根 Stop **相同的双通道注入**
 *   （`reason` + `hookSpecificOutput{ hookEventName:"SubagentStop", additionalContext }`）。
 * - 若继续（block），子代理仍在运行 → 子节点保留，等下一次 SubagentStop；链内 block 计数与链边界
 *   重置同根 Stop（`stop_hook_active`），防死循环。
 *
 * 归属：载荷 `agent_id` → `<home>/agents/claude-code.subs.json` 映射 → 子节点 Hub id；
 * 无映射（或子代理未注册）即跳过，**绝不误伤根节点**。
 * 退役：子任务确实完成（未 block）即 `POST /internal/retire {agentId:<子节点>}` 并清除本地映射；
 * **根保持既有 offline 语义**，不由本脚本退役。
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
  isRecord,
  loadSeen,
  readBlockCount,
  readStdinJson,
  rememberSeen,
  reportResultSafe,
  reportState,
  resolveHome,
  retire,
  runHook,
  wake,
  writeBlockCount,
} from "./common.mjs"
import { errorMessage, readJson, writeJson } from "./token.mjs"

/** 每链（同 `sub:<agent_id>` 的一串续跑）连续 block 上限。 */
const MAX_BLOCKS = 3

/** 从 subs.json 解析子代理载荷 `agent_id` → 子节点 Hub id。 */
function resolveChild(paths, claudeAgentId) {
  const subs = readJson(paths.subs)
  if (subs === undefined) return undefined
  const mapped = subs[claudeAgentId]
  return isRecord(mapped) && typeof mapped["agentId"] === "string" ? mapped["agentId"] : undefined
}

/** 清除子代理映射（退役后 busy 事件不再映射到已死节点）。 */
function removeSub(paths, claudeAgentId) {
  const subs = readJson(paths.subs)
  if (subs === undefined || !Object.prototype.hasOwnProperty.call(subs, claudeAgentId)) return
  delete subs[claudeAgentId]
  writeJson(paths.subs, subs)
}

async function main() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const input = await readStdinJson()
  const config = hubConfig(process.env)
  if (config.token === "") {
    appendLog(home, "SubagentStop: HUB_TOKEN missing; skip")
    return
  }
  const claudeAgentId = typeof input["agent_id"] === "string" ? input["agent_id"] : undefined
  const childId = claudeAgentId === undefined ? undefined : resolveChild(paths, claudeAgentId)
  if (claudeAgentId === undefined || childId === undefined) {
    appendLog(home, `SubagentStop: no mapped child for agent ${claudeAgentId ?? "<none>"}; skip`)
    return
  }

  try {
    await reportState(config, childId, "idle")
  } catch (error) {
    appendLog(home, `SubagentStop: state idle failed: ${errorMessage(error)}`)
  }

  const key = `sub:${claudeAgentId}`
  const chainContinuing = input["stop_hook_active"] === true
  const stored = readBlockCount(paths.substop, key)
  const prior = chainContinuing ? stored : 0

  /** 子任务确实完成：补回执、清映射、退役子节点（不可复活）。 */
  const finish = async () => {
    writeBlockCount(paths.substop, key, 0)
    removeSub(paths, claudeAgentId)
    try {
      await retire(config, childId)
    } catch (error) {
      appendLog(home, `SubagentStop: retire failed: ${errorMessage(error)}`)
    }
  }

  let messages
  try {
    messages = await wake(config, childId)
  } catch (error) {
    appendLog(home, `SubagentStop: wake failed: ${errorMessage(error)}`)
    await finish()
    return
  }

  const seen = loadSeen(paths)
  const fresh = messages.filter((m) => !seen.has(m.id))
  const dup = messages.filter((m) => seen.has(m.id))

  if (prior < MAX_BLOCKS && fresh.length > 0) {
    // 注入新消息并让子代理续跑；子节点保留，等下一次 SubagentStop。
    emit(injectionPayload(fresh, "SubagentStop"))
    rememberSeen(
      paths,
      fresh.map((m) => m.id),
    )
    writeBlockCount(paths.substop, key, prior + 1)
    await reportResultSafe(config, childId, [...deliveredItems(fresh), ...deliveredItems(dup)])
    return
  }

  if (dup.length > 0) await reportResultSafe(config, childId, deliveredItems(dup))
  if (fresh.length === 0 && prior !== 0) appendLog(home, `SubagentStop: backlog drained for ${childId}`)
  if (prior >= MAX_BLOCKS && fresh.length > 0) {
    appendLog(home, `SubagentStop: chain block cap ${MAX_BLOCKS} reached; finish without inject`)
  }
  await finish()
}

runHook("SubagentStop", main)
