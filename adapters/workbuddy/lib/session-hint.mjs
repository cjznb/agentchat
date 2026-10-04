/**
 * 节点命名 + 逐会话出站身份（指南 §5 第 1 条：**改写入参 + 桥剥头**）。
 *
 * 问题：一个进程只有**一个** MCP 连接，桥的 `x-agent-id` 天然只能表达**实例级**（容器）身份，
 * 而用户期望"谁在说话就以谁的名义记账"。
 *
 * 路线：`PreToolUse` hook 把当前 `session_id` 写进**本适配器** MCP 工具入参 →
 * `mcp-bridge.mjs` **剥离**该键并转成请求头 `x-agentchat-session` → Hub 按会话节点 `task_ref`
 * 解析真实发送方。Hub 绝不能看到该键（否则撞 MCP 入参校验）。
 *
 * 宿主差异（已核实 `codebuddy-lite-wb.mjs`）：WorkBuddy 用 `c.modifiedInput` **整体替换**
 * 工具入参（`c.modifiedInput && (n = c.modifiedInput)`），因此必须回传**完整**入参对象，
 * 而非"部分字段覆盖"。
 */
import { isRecord } from "./util.mjs"

/** 适配器 MCP server 名（插件清单里的键），决定模型可见工具名。 */
export const MCP_SERVER_NAME = "agentchat"

/**
 * 本适配器 MCP 工具在宿主里的全名前缀（两种常见规范化形态都接受；
 * 不触碰用户其它 MCP server —— 指南 §5 红线）。
 */
export const MCP_TOOL_PREFIXES = [`mcp__${MCP_SERVER_NAME}__`, `${MCP_SERVER_NAME}_`]

/** 逐调用会话提示键（hook 注入 → 桥剥离并转请求头 `x-agentchat-session`）。 */
export const SESSION_ARG = "x-agentchat-session"

/** 工具名是否属于本适配器。 */
export function isOurTool(toolName) {
  return typeof toolName === "string" && MCP_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}

/** 实例（容器）节点可读名：`workbuddy@<host>`；主机名缺失/空白回落 `workbuddy`。 */
export function instanceName(host) {
  const trimmed = typeof host === "string" ? host.trim() : ""
  return trimmed === "" ? "workbuddy" : `workbuddy@${trimmed}`
}

/** 会话节点名：`<目录名>-<会话短标识>`（同目录多会话靠短标识区分）。 */
export function sessionName(cwd, sessionId) {
  const dir = typeof cwd === "string" && cwd.trim() !== "" ? cwd : "workbuddy"
  return `${dir}-${sessionId}`.replace(/\\/g, "/").split("/").pop()
}

/**
 * 同名冲突的**稳定**别名：`<名字>~<sessionid 前 4 位>`。
 * 仅由 `session_id` 派生 → 同一会话每次重试得到同一别名，**重复事件幂等**（不会反复改名）。
 */
export function aliasedName(name, sessionId) {
  return `${name}~${sessionId.slice(0, 4)}`
}

/**
 * 注入会话提示：返回**新的完整入参对象**（宿主整体替换 `modifiedInput`，故不能只回传增量子集）。
 * 非本适配器工具 / 入参非对象 → 原样返回（`undefined` 表示"无需改写"）。
 * 绝不抛错（hook 抛错会打断工具调用）。
 */
export function injectSessionHint(toolName, toolInput, sessionId) {
  try {
    if (!isOurTool(toolName) || !isRecord(toolInput) || typeof sessionId !== "string" || sessionId === "") return undefined
    return { ...toolInput, [SESSION_ARG]: sessionId }
  } catch {
    return undefined
  }
}

/**
 * 桥侧：从 `tools/call` 入参**原地剥离**会话提示 → 返回 `{args, hint}`。
 * 无该键 → `hint: undefined`；有则该键**必被删除**（Hub 绝不能看到）。
 */
export function takeSessionHint(message) {
  if (!isRecord(message) || message["method"] !== "tools/call" || !isRecord(message["params"])) {
    return { args: undefined, hint: undefined }
  }
  const args = message["params"]["arguments"]
  if (!isRecord(args)) return { args: undefined, hint: undefined }
  const value = args[SESSION_ARG]
  delete args[SESSION_ARG]
  return { args, hint: typeof value === "string" && value.trim() !== "" ? value : undefined }
}
