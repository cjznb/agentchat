/**
 * Hub 客户端门面（**只经 HTTP 契约**，不 import 任何 server 代码）。
 *
 * 组合：传输层（`hub-config.js`：地址/token、超时、指数退避）与 MCP `register`
 * （`mcp.js`：握手 + SSE 解析），外加 `/internal/{state,wake,result,retire}` 四个纯 JSON 端点。
 *
 * ## 重试/退避策略（与 `adapters/opencode` **逐条一致**，完整说明见 `hub-config.js` 头部）
 * - 单次请求超时 3000ms（`AGENTCHAT_TIMEOUT_MS` 覆盖，仅测试用途）；
 * - `5xx` / `429` / 网络异常（含超时）**指数退避重试**：`min(30s, 250ms · 2^attempt) + jitter(0..250ms)`；
 * - 尝试上限 4 次；`sleep`/`random` 可注入（单测确定性、不真等）；
 * - 重试耗尽 → `HubError("network" | "timeout" | "exhausted")`；`4xx`（含 `401`/`404`）**不重试**，
 *   原样返回给调用方分流降级。
 *
 * ## 401 自愈（spec §14.3）
 * 任一 Hub 调用返回 401 → **重读**一次 token（`HUB_TOKEN` → `<home>/hub_token`）；有**新值且不同**
 * 则原地更新共享 bearer 并**仅重试这一次**（仍 401 交回既有确定性错误路径；重读值相同则不重试）。
 * **绝不循环、绝不退避**。`/internal/*` 与 MCP register（同一 bearer 对象、多请求）共用本包装。
 *
 * ## 纪律
 * 只抛「网关类型化错误」（`HubError` / `HubToolError`）供调用方按 `kind`/`code` 降级；
 * 网络/文件类失败一律由上层记日志后吞掉，**绝不让 Hub 抖动阻塞宿主**。
 */
import { createHttpTransport, expectStatus, HubError, resolveHubConfig } from "./hub-config.js"
import { createMcpClient, HubToolError, mcpRegister, normalizeWake } from "./mcp.js"

export { HubError, hubTokenPath, resolveHubConfig, resolveHubToken } from "./hub-config.js"
export { HubToolError } from "./mcp.js"

/** 适配器上报的状态（Hub 的 roster 语义）。 */
export const ADAPTER_STATES = /** @type {const} */ (["online", "busy", "idle", "offline"])
/** 投递回执结果（`delivered` = 已注入宿主；`refused` = 注入被拒，**不得**记为已注入）。 */
export const DELIVERY_RESULTS = /** @type {const} */ (["delivered", "refused"])

/**
 * 建 Hub 客户端。
 *
 * @param {{env: Readonly<Record<string, string | undefined>>, fetch: typeof fetch,
 *   log?: (message: string) => void, sleep?: (ms: number) => Promise<void>,
 *   random?: () => number, timeoutMs?: number, maxAttempts?: number,
 *   baseDelayMs?: number, maxDelayMs?: number}} options
 *   `env`/`fetch` 必填；`log` 缺省静默；`sleep`/`random` 仅单测注入
 * @returns {{
 *   register(args: Record<string, unknown>): Promise<{agentId: string, joinToken: string | undefined}>,
 *   reportState(agentId: string, state: string): Promise<void>,
 *   wake(agentId: string): Promise<Array<{id: string, fromAgentId: string, body: string}>>,
 *   reportResult(agentId: string, items: ReadonlyArray<{messageId: string, result: string}>): Promise<void>,
 *   retire(agentId: string): Promise<void>,
 *   renameAgent(agentId: string, name: string): Promise<void>,
 *   mcp(): {list(): Promise<unknown[]>, call(name: string, args: unknown, taskRef?: string): Promise<string>, reset(): void},
 * }}
 */
export function createHubClient(options) {
  const transport = createHttpTransport(options)
  let token = resolveHubConfig(options.env).token
  if (token === "") {
    options.log?.(
      "传输门 token 未解析到：未设 HUB_TOKEN 且 <AGENTCHAT_HOME>/hub_token 不存在或为空；" +
        "对 Hub 的调用将因 401 失败（启动 Hub 会自动写出该文件）",
    )
  }
  const bearer = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }
  /** 401 自愈包装：见模块头（重读一次 token，仅在有新值且不同时重试一次）。 */
  const send = async (path, body, headers, method) => {
    const first = await transport.send(path, body, headers, method)
    if (first.status !== 401) return first
    const fresh = resolveHubConfig(options.env).token
    if (fresh === "" || fresh === token) return first
    token = fresh
    // 原地更新共享 bearer（`mcp.js` 以 `{...bearer}` 拷贝构造头，故 bearer 与本次 headers 都要写）。
    bearer["authorization"] = `Bearer ${fresh}`
    headers["authorization"] = `Bearer ${fresh}`
    options.log?.("传输门 token 已轮换：401 后重读到新值，更新 bearer 并仅重试一次 " + path)
    return transport.send(path, body, headers, method)
  }

  /** `/internal/*` 的纯 JSON 端点：断言 200 后返回文本。 */
  const internal = async (path, body) => {
    return expectStatus(200, await send(path, body, bearer), `POST ${path}`)
  }

  return {
    register: (args) => mcpRegister({ send }, bearer, args),
    async reportState(agentId, state) {
      await internal("/internal/state", { agentId, state })
    },
    async wake(agentId) {
      return normalizeWake(JSON.parse(await internal("/internal/wake", { agentId })))
    },
    async reportResult(agentId, items) {
      await internal("/internal/result", { agentId, items })
    },
    async retire(agentId) {
      const result = await send("/internal/retire", { agentId }, bearer)
      // 幂等：`404 agent_not_found` 视为已退役/不存在，不重试也不报错（确定性错误）。
      if (result.status === 404) return
      expectStatus(200, result, "POST /internal/retire")
    },
    /**
     * 改**展示名**（`custom_name`；`name` 不变，故唯一性与 `task_ref` 收养不受影响）。
     * `PATCH /api/agents/:id`：400 `invalid_body`（空/超 64 字/控制字符）、404 未知 id、
     * 409 `name_taken`（展示名唯一索引冲突）——**确定性错误原样抛出**，由 `lib/title.js` 退化重试。
     */
    async renameAgent(agentId, displayName) {
      const path = `/api/agents/${encodeURIComponent(agentId)}`
      const result = await send(path, { name: displayName }, bearer, "PATCH")
      expectStatus(200, result, `PATCH ${path}`)
    },
    /**
     * **原生工具面**用：通用 MCP 客户端（一次握手后可反复 `list()`/`call()`；逐调用身份经
     * `x-agentchat-session`，见 `lib/mcp.js`）。`lib/native-tools.js` 用它按调用者会话记账。
     * 注意：`createMcpClient` 收的是**传输对象**（`{send}`），不是裸 `send` 函数
     * （真机事故：传裸函数 → `transport.send is not a function`，整条原生工具面静默失效）。
     */
    mcp: () => createMcpClient({ send }, bearer),
  }
}
