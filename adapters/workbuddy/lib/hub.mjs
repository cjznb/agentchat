/**
 * Hub 客户端：地址/token 解析、带超时与指数退避的 HTTP 传输、`/internal/*` 四端点、
 * 以及一次性完整握手的 MCP `register`。
 *
 * 只经 HTTP 契约与 Hub 通信（**不 import 本仓 `server/**`**）；只用 Node 内置 `fetch`。
 * 纪律（指南 §4.1）：单请求超时 3s 级；5xx/429/网络异常指数退避 + jitter；4xx **不重试**；
 * 401 自愈「重读 token 一次，仅在有新值时重试一次，绝不循环」。
 */
import { join } from "node:path"
import { resolveHome } from "./paths.mjs"
import { readText } from "./token.mjs"
import { errorMessage, isRecord } from "./util.mjs"

/** MCP 工具层错误（HTTP 200 但 `result.isError`），带稳定 `code` 供降级分流。 */
export class HubToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "HubToolError"
    this.code = code
  }
}

/** `<home>/hub_token` 磁盘兜底路径（与 Hub 写出位置一致）。 */
export function hubTokenPath(home) {
  return join(home, "hub_token")
}

/**
 * 传输门 token：`HUB_TOKEN`（非空优先）→ `<home>/hub_token` → 空串。
 * 使新用户**无需手动 `export HUB_TOKEN`**；两者皆无时空串照旧走 401 路径（调用方给明确日志）。
 */
export function resolveHubToken(env, home) {
  const fromEnv = env["HUB_TOKEN"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return readText(hubTokenPath(home)) ?? ""
}

/**
 * 从环境解析 Hub 连接配置：`AGENTCHAT_URL` 优先（否则 `127.0.0.1:${AGENTCHAT_PORT:-4646}`）；
 * HTTP 超时默认 3000ms（`AGENTCHAT_HOOK_TIMEOUT_MS` 供测试/慢机覆盖）。
 */
export function hubConfig(env, home) {
  const port = env["AGENTCHAT_PORT"] ?? "4646"
  const baseUrl = (env["AGENTCHAT_URL"] ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "")
  const parsed = Number.parseInt(env["AGENTCHAT_HOOK_TIMEOUT_MS"] ?? "", 10)
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 3000
  return { baseUrl, token: resolveHubToken(env, home), ms, home }
}

function isRetryable(status) {
  return status >= 500 || status === 429
}

/** 指数退避 + jitter（base 200ms ×2^n，上限 2s；hook 生命周期短，不对齐 30s 长上限）。 */
function backoffMs(attempt) {
  return Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100)
}

/**
 * `POST` 一个 JSON body。返回 `{status, text, sessionId}`。
 * 可重试状态/网络异常按退避重试（`attempts` 次）；确定性 4xx 原样返回交调用方降级。
 * 401 自愈由 {@link postWithTokenRetry} 承担。
 */
async function postOnce(config, path, body, headers, attempts) {
  const url = `${config.baseUrl}${path}`
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.ms)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!isRetryable(response.status)) {
        return { status: response.status, text, sessionId: response.headers.get("mcp-session-id") ?? undefined }
      }
      lastError = new Error(`${path} returned ${response.status}`)
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)))
  }
  throw lastError ?? new Error(`${path} failed`)
}

/**
 * 带 401 自愈的传输：401 → **重读一次 token**（磁盘可能已被 Hub 重写），仅有**新值且不同**时
 * 原地更新并**只重试一次**；仍 401 则把响应交回调用方（绝不循环退避）。
 */
export async function postJson(config, path, body, headers) {
  const attempts = config.attempts ?? 3
  const first = await postOnce(config, path, body, headers, attempts)
  if (first.status !== 401) return first
  const fresh = resolveHubToken(process.env, config.home)
  if (fresh === "" || fresh === config.token) return first
  config.token = fresh
  return postOnce(config, path, body, headers, attempts)
}

function parseSseJson(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
  const last = data[data.length - 1]
  if (last === undefined) throw new Error("empty SSE response")
  return JSON.parse(last)
}

function toolResultText(rpc) {
  if (!isRecord(rpc) || !isRecord(rpc["result"])) throw new Error("malformed MCP response")
  const content = rpc["result"]["content"]
  const first = Array.isArray(content) ? content[0] : undefined
  if (!isRecord(first) || typeof first["text"] !== "string") throw new Error("malformed MCP tool result")
  return { text: first["text"], isError: rpc["result"]["isError"] === true }
}

/**
 * 每次 `register` 走**完整握手**（register 罕见，换取无跨调用会话复用状态）：
 * `initialize`（读响应头 `mcp-session-id`）→ `notifications/initialized` → `tools/call register`。
 */
export async function mcpRegister(config, args, clientName = "agentchat-workbuddy") {
  const accept = { accept: "application/json, text/event-stream" }
  const init = await postJson(config, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "0.1.0" } },
  }, accept)
  if (init.status !== 200) throw new Error(`initialize returned ${init.status}`)
  if (init.sessionId === undefined) throw new Error("initialize returned no mcp-session-id")
  const session = { ...accept, "mcp-session-id": init.sessionId }
  await postJson(config, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, session)
  const call = await postJson(config, "/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "register", arguments: args },
  }, session)
  if (call.status !== 200) throw new Error(`tools/call returned ${call.status}`)
  return parseRegisterReply(call.text)
}

/** 解析 `register` 回复：`isError` → `HubToolError(稳定 code)`；否则取 `agent.id` 与 `join_token`。 */
export function parseRegisterReply(text) {
  const { text: body, isError } = toolResultText(parseSseJson(text))
  if (isError) {
    const match = /\[([a-z_]+)\]\s*$/.exec(body)
    throw new HubToolError(match === undefined ? undefined : match[1], body)
  }
  const payload = JSON.parse(body)
  const agent = isRecord(payload) && isRecord(payload["agent"]) ? payload["agent"] : undefined
  const agentId = agent !== undefined && typeof agent["id"] === "string" ? agent["id"] : undefined
  if (agentId === undefined) throw new Error("register returned no agent id")
  const joinToken = isRecord(payload) && typeof payload["join_token"] === "string" ? payload["join_token"] : undefined
  return { agentId, joinToken }
}

/**
 * 通用 MCP 工具调用（完整握手 + 单次 `tools/call`）。
 * `identity` 传入时作为 **`initialize` 请求头** `x-agent-id`（Hub 只在 initialize 认身份）；
 * `sessionHint` 传入时作为逐请求头 `x-agentchat-session`（逐会话出站身份）。
 * 供真机 E2E 脚本与将来的运维工具使用。
 */
export async function mcpCall(config, toolName, args, identity, sessionHint) {
  const accept = { accept: "application/json, text/event-stream" }
  const initHeaders = { ...accept, ...(identity === undefined ? {} : { "x-agent-id": identity }) }
  const init = await postJson(config, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentchat-workbuddy-client", version: "0.1.0" } },
  }, initHeaders)
  if (init.status !== 200 || init.sessionId === undefined) throw new Error(`initialize failed (${init.status})`)
  const session = {
    ...accept,
    "mcp-session-id": init.sessionId,
    ...(identity === undefined ? {} : { "x-agent-id": identity }),
    ...(sessionHint === undefined ? {} : { "x-agentchat-session": sessionHint }),
  }
  await postJson(config, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, session)
  const call = await postJson(config, "/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  }, session)
  if (call.status !== 200) throw new Error(`tools/call ${toolName} returned ${call.status}`)
  const { text, isError } = toolResultText(parseSseJson(call.text))
  if (isError) {
    const match = /\[([a-z_]+)\]\s*$/.exec(text)
    throw new HubToolError(match === undefined ? undefined : match[1], text)
  }
  return JSON.parse(text)
}

async function internal(config, path, body) {
  const result = await postJson(config, path, body)
  if (result.status !== 200) throw new Error(`${path} returned ${result.status}`)
  return result.text
}

/** `POST /internal/state`。**同态上报在 Hub 侧等价心跳触碰**，故不本地去重。 */
export async function reportState(config, agentId, state) {
  await internal(config, "/internal/state", { agentId, state })
}

/** 认领积压消息；返回规范化后的消息数组（过滤掉形状不符者）。 */
export async function wake(config, agentId) {
  const parsed = JSON.parse(await internal(config, "/internal/wake", { agentId }))
  const raw = isRecord(parsed) && Array.isArray(parsed["messages"]) ? parsed["messages"] : []
  return raw.filter(
    (m) => isRecord(m) && typeof m["id"] === "string" && typeof m["fromAgentId"] === "string" && typeof m["body"] === "string",
  )
}

export async function reportResult(config, agentId, items) {
  await internal(config, "/internal/result", { agentId, items })
}

/**
 * 退役节点：幂等 —— `404 agent_not_found` 视为已不存在/已退役，不重试也不抛错。
 * **本适配器只在"会话被明确删除"时调用**；`SessionEnd` 绝不走这里（指南 §6 单向门）。
 */
export async function retire(config, agentId) {
  const result = await postJson(config, "/internal/retire", { agentId })
  if (result.status === 404) return
  if (result.status !== 200) throw new Error(`/internal/retire returned ${result.status}`)
}

export { errorMessage }
