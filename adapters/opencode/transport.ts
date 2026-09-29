/**
 * Hub 传输层：HTTP POST + 超时 + 指数退避重试。
 *
 * 健壮性（控制器裁决 ③）：每次调用带超时（默认 3s）、`5xx`/`429`/网络错误指数退避重试
 * （base 250ms×2^n，上限 30s，含 jitter）、`4xx`/`401`/`404` 等确定性错误原样返回交调用方降级
 * （不重试）；重试耗尽以 `HubError` 抛出。
 */
import { join } from "node:path"
import { resolveHome } from "./home"
import { readToken } from "./token"

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

export interface HubConfig {
  readonly baseUrl: string
  readonly token: string
}

/** 传输门 token 的磁盘兜底路径（`<AGENTCHAT_HOME>/hub_token`，与 Hub 写出位置一致）。 */
export function hubTokenPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveHome(env), "hub_token")
}

/**
 * 传输门 token 解析顺序：`env.HUB_TOKEN`（非空优先）→ 读 `<AGENTCHAT_HOME>/hub_token`（trim）
 * → 空串。使新用户**无需手动 `export HUB_TOKEN`**（与 MCP 桥、Claude `mcp-headers.mjs` 对齐）；
 * 两处都拿不到时空串照旧走既有 401 路径（调用方给明确 warn）。
 */
export function resolveHubToken(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env["HUB_TOKEN"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return readToken(hubTokenPath(env)) ?? ""
}

/** 从环境解析 Hub 地址与传输门 token（`AGENTCHAT_URL` 优先，否则 `127.0.0.1:AGENTCHAT_PORT`）。 */
export function resolveHubConfig(env: Readonly<Record<string, string | undefined>>): HubConfig {
  const port = env["AGENTCHAT_PORT"] ?? "4646"
  const raw = env["AGENTCHAT_URL"] ?? `http://127.0.0.1:${port}`
  return { baseUrl: raw.replace(/\/+$/, ""), token: resolveHubToken(env) }
}

export interface HubClientOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  /** 传输门 token 解析到空时的告警出口（缺省静默；插件注入宿主日志）。 */
  readonly log?: (message: string) => void
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
}

export interface SendResult {
  readonly status: number
  readonly text: string
  readonly sessionId: string | undefined
}

/** 传输原语：POST 一个 JSON body，返回状态/文本/`mcp-session-id`（重试语义见模块头）。 */
export interface HttpTransport {
  send(path: string, body: unknown, headers: Record<string, string>): Promise<SendResult>
}

interface ResolvedRetry {
  readonly sleep: (ms: number) => Promise<void>
  readonly random: () => number
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
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

function backoffDelay(attempt: number, retry: ResolvedRetry): number {
  const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt)
  return base + Math.floor(retry.random() * retry.baseDelayMs)
}

/** 断言期望状态码，否则抛 `HubError("http")`（确定性失败，调用方降级）。返回响应文本。 */
export function expectStatus(status: number, result: SendResult, path: string): string {
  if (result.status !== status) {
    throw new HubError("http", result.status, `${path} returned ${result.status}`)
  }
  return result.text
}

export function createHttpTransport(options: HubClientOptions): HttpTransport {
  const config = resolveHubConfig(options.env)
  const retry = resolveRetry(options)

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

  return { send }
}
