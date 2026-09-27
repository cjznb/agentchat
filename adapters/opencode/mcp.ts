/**
 * MCP over streamable-HTTP：`register` 工具的握手与结果解析（`POST /mcp`）。
 *
 * 握手（spec §9 + `server/routes/mcp.ts`）：`initialize`（读 `mcp-session-id`）
 * → `notifications/initialized` → `tools/call{name:"register"}`；结果在 SSE `data:`
 * 事件里的 `result.content[0].text`（`server/mcp/context.ts` 的 `toolResult` 约定）。
 */
import { expectStatus, HubError, type HttpTransport } from "./transport"
import { isRecord } from "./util"

/** MCP 工具层错误（HTTP 200 但 `result.isError`），带稳定 `code`。 */
export class HubToolError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "HubToolError"
  }
}

export interface RegisterArgs {
  readonly join_token?: string
  readonly parent_ref?: string
  readonly task_ref?: string
  readonly name?: string
  readonly vendor?: string
  readonly model?: string
  readonly purpose?: string
  readonly skills?: readonly string[]
}

export interface RegisterResult {
  readonly agentId: string
  readonly joinToken: string | undefined
}

function parseSseJson(text: string): unknown {
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

function toolResultOf(rpc: unknown): { readonly isError: boolean; readonly text: string } {
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
function codeFromToolText(text: string): string | undefined {
  const match = /\[([a-z_]+)\]\s*$/.exec(text)
  return match?.[1]
}

function mcpHeaders(
  bearer: Record<string, string>,
  sessionId: string | undefined,
): Record<string, string> {
  return {
    ...bearer,
    accept: "application/json, text/event-stream",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  }
}

/** 每次调用走完整握手（register 罕见，换取无跨调用会话复用状态）。 */
export async function mcpRegister(
  transport: HttpTransport,
  bearer: Record<string, string>,
  args: RegisterArgs,
): Promise<RegisterResult> {
  const init = await transport.send(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentchat-opencode", version: "0.1.0" },
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
  const payload: unknown = JSON.parse(parsed.text)
  if (
    !isRecord(payload) ||
    !isRecord(payload["agent"]) ||
    typeof payload["agent"]["id"] !== "string"
  ) {
    throw new HubError("protocol", undefined, "register returned no agent id")
  }
  const joinToken = payload["join_token"]
  return {
    agentId: payload["agent"]["id"],
    joinToken: typeof joinToken === "string" ? joinToken : undefined,
  }
}
