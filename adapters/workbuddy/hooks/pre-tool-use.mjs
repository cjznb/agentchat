#!/usr/bin/env node
/**
 * PreToolUse hook（matcher 收窄到本适配器 MCP 工具）：**逐会话出站身份**的唯一实现路径
 * （指南 §5 第 1 条）——把当前 `session_id` 写进工具入参，桥剥离并转 `x-agentchat-session` 头。
 *
 * 两条必须守住的红线（都已核实宿主源码 `codebuddy-lite-wb.mjs`）：
 * 1. 宿主用 `c.modifiedInput && (n = c.modifiedInput)` **整体替换**工具入参 → 必须回传**完整**
 *    对象（原字段 + 我们那一个键），而不是增量子集；
 * 2. **只在会话节点已注册时**才注入。Hub 对 `x-agentchat-session` 的语义是"解析不到即等同无身份、
 *    **不回落容器**"（指南 §1.3）——若给一个未注册的会话塞这个头，工具会直接 `identity_required`。
 *    未注册时**省略该键**，让桥退回实例容器身份，调用照常可用（精度降级，而不是报错）。
 *
 * 任何失败只记日志、退出码 0（PreToolUse 尤其不得误 block）。
 */
import { loadContext } from "../lib/context.mjs"
import { emit, runHook } from "../lib/hook-io.mjs"
import { appendLog } from "../lib/log.mjs"
import { resolveHome } from "../lib/paths.mjs"
import { mappedSessionAgentId } from "../lib/register.mjs"
import { injectSessionHint, isOurTool } from "../lib/session-hint.mjs"

async function main() {
  const { paths, input, sessionId, log } = await loadContext()
  const toolName = typeof input["tool_name"] === "string" ? input["tool_name"] : ""
  if (!isOurTool(toolName)) return
  if (sessionId === undefined) {
    log(`PreToolUse(${toolName}): no session_id; keep container identity`)
    return
  }
  if (mappedSessionAgentId(paths, sessionId) === undefined) {
    log(`PreToolUse(${toolName}): session ${sessionId} not registered yet; keep container identity`)
    return
  }
  const rewritten = injectSessionHint(toolName, input["tool_input"], sessionId)
  if (rewritten === undefined) return
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // 显式 allow：宿主对 MCP 工具会先看 `!allowed || permissionDecision==="deny"` 再决定放行，
      // 且 `updatedInput` 仅在 allow 时被采纳。本 hook 只服务于自家工具，绝不 deny 用户操作。
      permissionDecision: "allow",
      modifiedInput: rewritten,
    },
  })
}

runHook("PreToolUse", (message) => appendLog(resolveHome(process.env), message, "PreToolUse"), main)
