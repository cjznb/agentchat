/**
 * Hub HTTP 客户端（**只经 HTTP 契约**，不 import 任何 server 代码）。
 *
 * 契约来源（spec §7/§9/§10 + `server/routes/*`）：
 * - `POST /mcp`（Bearer）MCP streamable-HTTP：`initialize` → `notifications/initialized`
 *   → `tools/call{name:"register"}`；工具结果在 SSE `data:` 里的 `result.content[0].text`。
 * - `POST /internal/state`、`/internal/wake`、`/internal/result`（Bearer）纯 JSON。
 *
 * 健壮性（控制器裁决 ③）：每次调用带超时（默认 3s）、5xx/429/网络错误指数退避重试
 * （base 250ms×2^n，上限 30s，含 jitter）、4xx/401/404 等确定性错误不重试。
 */
import { isRecord } from "./util"

export type AdapterState = "online" | "busy" | "idle" | "offline"
export type DeliveryResult = "delivered" | "refused"

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

export interface WakeMessage {
  readonly id: string
  readonly fromAgentId: string
  readonly conversationId: string
  readonly body: string
}

export interface WakeResult {
  readonly messages: readonly WakeMessage[]
}

export interface ResultItem {
  readonly messageId: string
  readonly result: DeliveryResult
}

export interface Hub {
  register(args: RegisterArgs): Promise<RegisterResult>
  reportState(agentId: string, state: AdapterState): Promise<void>
  wake(agentId: string): Promise<WakeResult>
  reportResult(agentId: string, items: readonly ResultItem[]): Promise<void>
}

export type HubErrorKind = "network" | "timeout" | "http" | "protocol" | "exhausted"

/** HTTP/协议/网络层错误（带 `kind` 供调用方分流降级）。 */
export class HubError extends Error {
  constructor(
    readonly kind: HubErrorKind,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = "HubError"
  }
}

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

export interface HubConfig {
  readonly baseUrl: string
  readonly token: string
}

/** 从环境解析 Hub 地址与传输门 token（`AGENTCHAT_URL` 优先，否则 `127.0.0.1:AGENTCHAT_PORT`）。 */
export function resolveHubConfig(env: Readonly<Record<string, string | undefined>>): HubConfig {
  const port = env["AGENTCHAT_PORT"] ?? "4646"
  const raw = env["AGENTCHAT_URL"] ?? `http://127.0.0.1:${port}`
  return { baseUrl: raw.replace(/\/+$/, ""), token: env["HUB_TOKEN"] ?? "" }
}

export interface HubClientOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
}

interface ResolvedRetry {
  readonly sleep: (ms: number) => Promise<void>
  readonly random: () => number
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

interface SendResult {
  readonly status: number
  readonly text: string
  readonly sessionId: string | undefined
}

function resolveRetry(options: HubClientOptions): ResolvedRetry {
  return {
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
    timeoutMs: options.timeoutMs ?? 3000,
    maxAttempts: options.maxAttempts ?? 4,
    baseDelayMs: options.baseDelayMs ?? 250,
    maxDelayMs: options.maxDelayMs ?? 30_000,
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

function sseJson(text: string): unknown {
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

function codeFromToolText(text: string): string | undefined {
  const match = /\[([a-z_]+)\]\s*$/.exec(text)
  return match?.[1]
}

function toWakeMessage(value: unknown): WakeMessage | undefined {
  if (!isRecord(value)) return undefined
  const { id, fromAgentId, conversationId, body } = value
  if (
    typeof id !== "string" ||
    typeof fromAgentId !== "string" ||
    typeof conversationId !== "string" ||
    typeof body !== "string"
  ) {
    return undefined
  }
  return { id, fromAgentId, conversationId, body }
}

function parseWake(text: string): WakeResult {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || !Array.isArray(raw["messages"])) {
    throw new HubError("protocol", undefined, "malformed wake response")
  }
  const messages = raw["messages"]
    .map(toWakeMessage)
    .filter((message): message is WakeMessage => message !== undefined)
  return { messages }
}

/**
 * 建 Hub 客户端。`send` 内做超时 + 退避重试；确定性 4xx 原样返回交调用方降级，
 * 重试耗尽则以 `HubError` 抛出。
 */
export function createHubClient(options: HubClientOptions): Hub {
  const config = resolveHubConfig(options.env)
  const retry = resolveRetry(options)
  const bearer: Record<string, string> = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  }

  async function send(
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<SendResult> {
    const url = `${config.baseUrl}${path}`
    let lastStatus: number | undefined
    for (let attempt = 0; attempt < retry.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), retry.timeoutMs)
      try {
        const response = await options.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await response.text()
        if (isRetryableStatus(response.status)) {
          lastStatus = response.status
        } else {
          return {
            status: response.status,
            text,
            sessionId: response.headers.get("mcp-session-id") ?? undefined,
          }
        }
      } catch (error) {
        lastStatus = undefined
        if (attempt === retry.maxAttempts - 1) {
          const timedOut = error instanceof Error && error.name === "AbortError"
          throw new HubError(
            timedOut ? "timeout" : "network",
            undefined,
            `${timedOut ? "timeout" : "network error"} calling ${path}: ${String(error)}`,
          )
        }
      } finally {
        clearTimeout(timer)
      }
      if (attempt < retry.maxAttempts - 1) await retry.sleep(backoffDelay(attempt, retry))
    }
    throw new HubError("exhausted", lastStatus, `retries exhausted calling ${path}`)
  }

  function expect(status: number, result: SendResult, path: string): string {
    if (result.status !== status) {
      throw new HubError("http", result.status, `${path} returned ${result.status}`)
    }
    return result.text
  }

  return {
    async register(args) {
      const init = await send(
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
      expect(200, init, "POST /mcp initialize")
      const sessionId = init.sessionId
      if (sessionId === undefined) {
        throw new HubError("protocol", undefined, "initialize returned no mcp-session-id")
      }
      await send(
        "/mcp",
        { jsonrpc: "2.0", method: "notifications/initialized" },
        mcpHeaders(bearer, sessionId),
      )
      const call = await send(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "register", arguments: args },
        },
        mcpHeaders(bearer, sessionId),
      )
      const parsed = toolResultOf(sseJson(expect(200, call, "POST /mcp tools/call")))
      if (parsed.isError) {
        throw new HubToolError(codeFromToolText(parsed.text), parsed.text)
      }
      const payload: unknown = JSON.parse(parsed.text)
      if (!isRecord(payload) || !isRecord(payload["agent"]) || typeof payload["agent"]["id"] !== "string") {
        throw new HubError("protocol", undefined, "register returned no agent id")
      }
      const joinToken = payload["join_token"]
      return {
        agentId: payload["agent"]["id"],
        joinToken: typeof joinToken === "string" ? joinToken : undefined,
      }
    },

    async reportState(agentId, state) {
      const result = await send("/internal/state", { agentId, state }, bearer)
      expect(200, result, "POST /internal/state")
    },

    async wake(agentId) {
      const result = await send("/internal/wake", { agentId }, bearer)
      return parseWake(expect(200, result, "POST /internal/wake"))
    },

    async reportResult(agentId, items) {
      const result = await send("/internal/result", { agentId, items }, bearer)
      expect(200, result, "POST /internal/result")
    },
  }
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

function backoffDelay(attempt: number, retry: ResolvedRetry): number {
  const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt)
  return base + Math.floor(retry.random() * retry.baseDelayMs)
}
