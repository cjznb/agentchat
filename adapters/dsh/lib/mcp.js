/**
 * MCP over streamable-HTTP：`register` 工具的握手与结果解析（`POST /mcp`），
 * 以及 `/internal/wake` 响应的**形状归一化**。
 *
 * 握手（spec §9 + `server/routes/mcp.ts`）：`initialize`（读 `mcp-session-id`）
 * → `notifications/initialized` → `tools/call{name:"register"}`；结果在 SSE `data:`
 * 事件里（或直接用 JSON 回复）的 `result.content[0].text`（`server/mcp/context.ts`
 * 的 `toolResult` 约定）。
 *
 * 与 `adapters/opencode/mcp.ts` 的差异只有 `clientInfo.name`（本适配器为 `agentchat-dsh`）。
 * 每次调用走**完整握手**：register 罕见，换取无跨调用会话复用状态（少一处会泄漏/过期的状态）。
 */
import { expectStatus, HubError } from "./hub-config.js"
import { isRecord } from "./util.js"

/**
 * MCP 工具层错误（HTTP 200 但 `result.isError`），带稳定 `code`（`errorResult` 约定：
 * 文本形如 `Name: message [code]`，末尾方括号内为 snake_case 码）。
 *
 * 调用方按 `code` 分流降级，例如 `invalid_join_token` → 清本地 token 后按首次注册重来。
 */
export class HubToolError extends Error {
  /**
   * @param {string | undefined} code 稳定错误码（解析不到则 `undefined`）
   * @param {string} message 工具层原文
   */
  constructor(code, message) {
    super(message)
    this.name = "HubToolError"
    this.code = code
  }
}

/** 解析 SSE 或裸 JSON 回复体：裸 JSON（首字符 `{`）直接 `JSON.parse`，否则取最后一条 `data:` 行。 */
function parseSseJson(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
  const last = data[data.length - 1]
  if (last === undefined) throw new HubError("protocol", undefined, "empty SSE response")
  return JSON.parse(last)
}

/** 取 `result.content[0].text` 与 `result.isError`；形状不符 → `HubError("protocol")`。 */
function toolResultOf(rpc) {
  if (!isRecord(rpc) || !isRecord(rpc["result"])) {
    throw new HubError("protocol", undefined, "malformed MCP response")
  }
  const result = rpc["result"]
  const content = result["content"]
  if (!Array.isArray(content) || !isRecord(content[0])) {
    throw new HubError("protocol", undefined, "malformed MCP tool result")
  }
  const text = content[0]["text"]
  if (typeof text !== "string") {
    throw new HubError("protocol", undefined, "malformed MCP tool text")
  }
  return { isError: result["isError"] === true, text }
}

/** 从 `Name: message [code]` 提取稳定的 snake_case `code`（`errorResult` 约定）。 */
function codeFromToolText(text) {
  const match = /\[([a-z_]+)\]\s*$/.exec(text)
  return match?.[1]
}

/** MCP 请求头：共享 bearer + 接受 SSE/JSON +（有会话时）`mcp-session-id`。 */
function mcpHeaders(bearer, sessionId) {
  return {
    ...bearer,
    accept: "application/json, text/event-stream",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  }
}

/**
 * 走完整 MCP 握手调用 `register` 工具。
 *
 * @param {{send(path: string, body: unknown, headers: Record<string, string>): Promise<{status: number, text: string, sessionId: string | undefined}>}} transport 传输层（可含 401 自愈包装）
 * @param {Record<string, string>} bearer 共享 bearer 头（`authorization` / `content-type`）
 * @param {Record<string, unknown>} args 工具入参（`join_token` / `parent_ref` / `task_ref` / …）
 * @returns {Promise<{agentId: string, joinToken: string | undefined}>}
 */
export async function mcpRegister(transport, bearer, args) {
  const init = await transport.send(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentchat-dsh", version: "0.1.0" },
      },
    },
    mcpHeaders(bearer, undefined),
  )
  expectStatus(200, init, "POST /mcp initialize")
  const sessionId = init.sessionId
  if (sessionId === undefined) {
    throw new HubError("protocol", undefined, "initialize returned no mcp-session-id")
  }
  await transport.send(
    "/mcp",
    { jsonrpc: "2.0", method: "notifications/initialized" },
    mcpHeaders(bearer, sessionId),
  )
  const call = await transport.send(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "register", arguments: args },
    },
    mcpHeaders(bearer, sessionId),
  )
  const parsed = toolResultOf(parseSseJson(expectStatus(200, call, "POST /mcp tools/call")))
  if (parsed.isError) {
    throw new HubToolError(codeFromToolText(parsed.text), parsed.text)
  }
  const payload = JSON.parse(parsed.text)
  if (!isRecord(payload) || !isRecord(payload["agent"]) || typeof payload["agent"]["id"] !== "string") {
    throw new HubError("protocol", undefined, "register returned no agent id")
  }
  const joinToken = payload["join_token"]
  return {
    agentId: payload["agent"]["id"],
    joinToken: typeof joinToken === "string" ? joinToken : undefined,
  }
}

/**
 * 归一化 `/internal/wake` 的 `messages`：逐项守卫 `id`/`fromAgentId`/`body` 均为字符串，
 * **静默丢弃**形状不符项（一条坏消息不得拖垮整轮注入）。
 *
 * 与 `adapters/opencode/hub.ts` 的差异：OpenCode 还会校验 `conversationId`，本适配器的注入
 * 文本（`flush.formatMessages`）不渲染会话 id，故**不要求**该字段（仍原样保留，若有）。
 *
 * @param {unknown} raw 已 `JSON.parse` 的响应体
 * @returns {Array<{id: string, fromAgentId: string, body: string, conversationId?: string}>}
 */
export function normalizeWake(raw) {
  if (!isRecord(raw) || !Array.isArray(raw["messages"])) {
    throw new HubError("protocol", undefined, "malformed wake response")
  }
  return raw["messages"]
    .filter(
      (value) =>
        isRecord(value) &&
        typeof value["id"] === "string" &&
        typeof value["fromAgentId"] === "string" &&
        typeof value["body"] === "string",
    )
    .map((value) => ({
      id: value["id"],
      fromAgentId: value["fromAgentId"],
      body: value["body"],
      ...(typeof value["conversationId"] === "string" ? { conversationId: value["conversationId"] } : {}),
    }))
}
