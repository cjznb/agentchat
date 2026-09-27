#!/usr/bin/env node
/**
 * Claude Code MCP `headersHelper`：向 stdout 输出 AgentChat MCP 连接所需的请求头 JSON。
 *
 * 目的：
 * - **配置里不出现 token**（`mcp.snippet.json` 只写 `headersHelper` 指向本脚本）；
 * - 规避 Claude Code「凭据变量读作空」的静默 401（`${HUB_TOKEN}` 若命中名单会被替换为空）。
 *
 * 取值优先级：环境变量 `HUB_TOKEN` / `AGENTCHAT_AGENT_ID` → 本地文件
 * `<AGENTCHAT_HOME>/hub_token`、`<AGENTCHAT_HOME>/agents/claude-code.id`（默认 home `~/.agentchat`）。
 * 缺任一项则**省略该头**（绝不输出空值头；空 `x-agent-id` 会让 Hub 返回 `agent_not_found`）。
 * Claude Code 以 stdout 的 JSON 为准，任何失败都退化为 `{}`、退出码恒 0。
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function readText(path) {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

function headers(env) {
  const home = env.AGENTCHAT_HOME || join(homedir(), ".agentchat")
  const token = env.HUB_TOKEN || readText(join(home, "hub_token"))
  const agentId = env.AGENTCHAT_AGENT_ID || readText(join(home, "agents", "claude-code.id"))
  const out = {}
  if (token !== undefined) out.Authorization = `Bearer ${token}`
  if (agentId !== undefined) out["x-agent-id"] = agentId
  return out
}

process.stdout.write(`${JSON.stringify(headers(process.env))}\n`)
