/**
 * 逐调用会话提示（M2）——`tool.execute.before` 的实现自 `plugin.ts` 抽出，使其入口保持精简
 * （评审：`plugin.ts` 越过 250 纯行红线）。
 *
 * 机制：OpenCode 一进程只暴露一个 MCP 连接，桥的 `x-agent-id` 只能表达**实例级**（容器）身份，
 * 故宿主直接触发的每次工具调用都会记在容器名下。本模块把**当前会话 id** 注入本适配器工具入参；
 * 桥剥离该键并转 `x-agentchat-session` 请求头，Hub 按会话节点 `task_ref` 解析出发送方。
 */
import { describe } from "./flush"
import { isRecord } from "./util"

/** 本适配器 MCP 工具在宿主里的全名前缀（server 名 `agentchat` + `_`；不触碰用户其它 MCP server）。 */
export const MCP_TOOL_PREFIX = "agentchat_"

/**
 * 逐调用会话提示键（插件注入 → 桥剥离并转请求头 `x-agentchat-session` → Hub 按会话节点
 * `task_ref` 解析真实发送方）。Hub 绝不看到该键（桥负责剥离，否则撞 MCP 入参校验）。
 */
export const SESSION_ARG = "x-agentchat-session"

/**
 * 注入当前会话 id 到本适配器工具入参（`tool.execute.before` 主体）。
 *
 * 红线：**只原地改**（`args[SESSION_ARG]=sessionID`；宿主丢弃钩子返回值，整体替换无效）；
 * `tool` 非本适配器前缀或 `args` 非对象即跳过；写入失败（如冻结对象）只写日志、**绝不抛**
 * （抛出会打断工具调用）。
 */
export async function injectSessionHint(
  tool: string,
  sessionID: string,
  args: unknown,
  log: (message: string) => void,
): Promise<void> {
  try {
    if (!tool.startsWith(MCP_TOOL_PREFIX) || !isRecord(args)) return
    args[SESSION_ARG] = sessionID
  } catch (error) {
    log(`tool.execute.before failed: ${describe(error)}`)
  }
}
