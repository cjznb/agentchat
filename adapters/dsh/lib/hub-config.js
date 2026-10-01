/**
 * Hub 传输层：HTTP POST + 单次超时 + **指数退避重试**，以及 Hub 地址/token 解析。
 *
 * ## 重试策略（与 `adapters/opencode/transport.ts` **完全一致**）
 * - 每次调用带**单次请求超时**（默认 3000ms，`AGENTCHAT_TIMEOUT_MS` 可覆盖，仅测试用途）；
 * - 可重试失败：`5xx`、`429`、以及网络层异常（含超时 `AbortError`）；
 * - 退避：`delay = min(30_000, 250 · 2^attempt) + floor(random · 250)`（base 250ms、上限 30s、含 jitter）；
 * - 尝试上限：4 次（首次 + 3 次重试）；每次失败（含最后一次）之间都 `sleep`，**未注入 `sleep`
 *   时用真实定时器**；`sleep`/`random` 可注入以保证单测确定性且不真等；
 * - 重试耗尽：网络/超时 → `HubError("network" | "timeout")`，全为可重试状态码 → `HubError("exhausted")`
 *   （带最后一次状态码）；
 * - **确定性错误不重试**：`4xx`（含 `401` / `404`）原样返回给调用方分流降级。
 *
 * ## token 解析
 * `env.HUB_TOKEN`（非空优先，**trim** 后判空）→ `<AGENTCHAT_HOME>/hub_token`（trim）→ 空串。
 *
 * 纪律：本模块只做「不可重试错误原样返回 + 可重试错误退避后抛 `HubError`」，
 * 一切异常都有类型与 `kind`，绝不静默吞掉协议层失败。
 */
import { join } from "node:path"
import { resolveHome } from "./home.js"
import { readToken } from "./token.js"

/** 错误种类：供调用方分流降级（网络/超时/确定性 HTTP/协议/重试耗尽）。 */
export const HUB_ERROR_KINDS = /** @type {const} */ ([
  "network",
  "timeout",
  "http",
  "protocol",
  "exhausted",
])

/** HTTP/协议/网络层错误（带 `kind`，`status` 仅 HTTP 类有值）。 */
export class HubError extends Error {
  /**
   * @param {"network" | "timeout" | "http" | "protocol" | "exhausted"} kind
   * @param {number | undefined} status
   * @param {string} message
   */
  constructor(kind, status, message) {
    super(message)
    this.name = "HubError"
    this.kind = kind
    this.status = status
  }
}

/** 传输门 token 的磁盘兜底路径（`<AGENTCHAT_HOME>/hub_token`，与 Hub 写出位置一致）。 */
export function hubTokenPath(env) {
  return join(resolveHome(env), "hub_token")
}

/**
 * 传输门 token 解析顺序：`env.HUB_TOKEN`（非空优先）→ 读 `<AGENTCHAT_HOME>/hub_token`（trim）
 * → 空串。使新用户**无需手动 `export HUB_TOKEN`**（与 MCP 桥、Claude/OpenCode 适配器对齐）；
 * 两处都拿不到时空串照旧走既有 401 路径（调用方给明确 warn）。
 */
export function resolveHubToken(env) {
  const fromEnv = env["HUB_TOKEN"]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim()
  return readToken(hubTokenPath(env)) ?? ""
}

/** 从环境解析 Hub 地址与传输门 token（`AGENTCHAT_URL` 优先，否则 `127.0.0.1:AGENTCHAT_PORT`）。 */
export function resolveHubConfig(env) {
  const port = env["AGENTCHAT_PORT"] ?? "4646"
  const raw = env["AGENTCHAT_URL"] ?? `http://127.0.0.1:${port}`
  return { baseUrl: raw.replace(/\/+$/, ""), token: resolveHubToken(env) }
}

/** 默认单次请求超时（3s）。 */
export const DEFAULT_TIMEOUT_MS = 3000
/** 默认尝试次数（首次 + 3 次重试）。 */
export const DEFAULT_MAX_ATTEMPTS = 4
/** 默认退避基数（250ms）。 */
export const DEFAULT_BASE_DELAY_MS = 250
/** 默认退避上限（30s）。 */
export const DEFAULT_MAX_DELAY_MS = 30_000

/**
 * 解析超时覆盖：`AGENTCHAT_TIMEOUT_MS` 为整数且 > 0 才生效，否则回落默认（**缺失即 3000**）。
 * 与 Claude Code 适配器的 `AGENTCHAT_HOOK_TIMEOUT_MS` 同用途（仅测试缩短窗口，生产恒 3s）。
 */
export function resolveTimeoutMs(env, override) {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override
  const parsed = Number.parseInt(env["AGENTCHAT_TIMEOUT_MS"] ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

/**
 * 归一化重试参数（`sleep`/`random` 未注入时用真实定时器与 `Math.random`）。
 *
 * @param {{env: Readonly<Record<string, string | undefined>>, sleep?: (ms: number) => Promise<void>,
 *   random?: () => number, timeoutMs?: number, maxAttempts?: number, baseDelayMs?: number,
 *   maxDelayMs?: number}} options
 */
export function resolveRetry(options) {
  return {
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
    timeoutMs: resolveTimeoutMs(options.env, options.timeoutMs),
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  }
}

/** 可重试状态码：`5xx` 与 `429`（其余 4xx 视为确定性错误，原样返回）。 */
export function isRetryableStatus(status) {
  return status >= 500 || status === 429
}

/** 第 `attempt` 次重试前的等待毫秒（指数 + jitter）。 */
export function backoffDelay(attempt, retry) {
  const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt)
  return base + Math.floor(retry.random() * retry.baseDelayMs)
}

/**
 * 断言期望状态码，否则抛 `HubError("http")`（确定性失败，调用方降级）。返回响应文本。
 *
 * @param {number} status 期望状态码
 * @param {{status: number, text: string}} result 传输结果
 * @param {string} path 出错时用于定位的路径标签
 * @returns {string} 响应文本
 */
export function expectStatus(status, result, path) {
  if (result.status !== status) {
    throw new HubError("http", result.status, `${path} returned ${result.status}`)
  }
  return result.text
}

/**
 * 建传输原语：`send(path, body, headers)` → `{status, text, sessionId}`。
 *
 * @param {{env: Readonly<Record<string, string | undefined>>, fetch: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, random?: () => number, log?: (message: string) => void,
 *   timeoutMs?: number, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number}} options
 */
export function createHttpTransport(options) {
  const config = resolveHubConfig(options.env)
  const retry = resolveRetry(options)

  return {
    /**
     * @param {string} path 以 `/` 开头的路径
     * @param {unknown} body JSON 化后作为请求体
     * @param {Record<string, string>} headers 完整请求头
     * @returns {Promise<{status: number, text: string, sessionId: string | undefined}>}
     */
    async send(path, body, headers) {
      const url = `${config.baseUrl}${path}`
      let lastStatus
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
    },
  }
}
