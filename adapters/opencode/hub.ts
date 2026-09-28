/**
 * Hub 客户端门面（**只经 HTTP 契约**，不 import 任何 server 代码）。
 *
 * 组合：传输层（`transport.ts`：HTTP/超时/退避）与 MCP `register`（`mcp.ts`：握手/SSE 解析），
 * 外加 `/internal/{state,wake,result}` 三个纯 JSON 端点。
 * 对外导出面保持不变（错误与类型 re-export），插件只 import 本模块。
 */
import { HubToolError, mcpRegister, type RegisterArgs, type RegisterResult } from "./mcp"
import {
  createHttpTransport,
  expectStatus,
  hubTokenPath,
  HubError,
  resolveHubConfig,
  resolveHubToken,
  type HubClientOptions,
  type HubConfig,
  type HubErrorKind,
  type HttpTransport,
} from "./transport"
import { isRecord } from "./util"

export { HubError, HubToolError, resolveHubConfig }
export type { HubClientOptions, HubConfig, HubErrorKind, RegisterArgs, RegisterResult }

export type AdapterState = "online" | "busy" | "idle" | "offline"
export type DeliveryResult = "delivered" | "refused"

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
  retire(agentId: string): Promise<void>
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

/** 建 Hub 客户端；确定性 4xx 经 `expectStatus` 抛 `HubError("http")` 供调用方降级。 */
export function createHubClient(options: HubClientOptions): Hub {
  const transport: HttpTransport = createHttpTransport(options)
  const token = resolveHubToken(options.env)
  if (token === "") {
    options.log?.(
      `传输门 token 未解析到：未设 HUB_TOKEN 且 ${hubTokenPath(options.env)} 不存在或为空；` +
        `对 Hub 的调用将因 401 失败（启动 Hub 会自动写出该文件）`,
    )
  }
  const bearer: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }
  return {
    register: (args) => mcpRegister(transport, bearer, args),
    async reportState(agentId, state) {
      expectStatus(200, await transport.send("/internal/state", { agentId, state }, bearer), "POST /internal/state")
    },
    async wake(agentId) {
      return parseWake(expectStatus(200, await transport.send("/internal/wake", { agentId }, bearer), "POST /internal/wake"))
    },
    async reportResult(agentId, items) {
      expectStatus(200, await transport.send("/internal/result", { agentId, items }, bearer), "POST /internal/result")
    },
    async retire(agentId) {
      const result = await transport.send("/internal/retire", { agentId }, bearer)
      // 幂等：`404 agent_not_found` 视为已退役/不存在，不重试也不报错（确定性错误）。
      if (result.status === 404) return
      expectStatus(200, result, "POST /internal/retire")
    },
  }
}
