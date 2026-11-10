/**
 * Hub 裸 HTTP 面（`adapters/test/lib/hub-http.mjs`）—— `/api/test/*`（测试面，驱动真实 core 的
 * 写/读端点）与 `/internal/state`（**要拿到原始状态码**，故不能走 `hub.reportState` 的断言包装）。
 *
 * 为什么不复用 `createHubClient`：它的契约是"网关类型化错误"（非 200 一律抛），而测试要断言
 * `409 child_never_offline` / `404 测试接口未开启` 这类**原始响应**；`/api/test/*` 也不在它的
 * 暴露面里。除此之外的部分（register/wake/result/mcp）一律走 `hub.js` 真实现，见 `host.mjs`。
 *
 * 自 `host.mjs` 拆出：本仓红线「单文件 ≤ 250 纯行」；本模块只做 HTTP，不掺宿主与注入闭环。
 */

/**
 * `GET /api/test/dump` 的原始行（snake_case；测试直接断言的真相源）。
 *
 * @typedef {{id: string, name: string, kind: string, status: string, vendor: string,
 *   task_ref: string | null, parent_id: string | null, role_tag: string | null}} DumpAgent
 * @typedef {{id: number, message_id: number, agent_id: string, state: string, attempts: number,
 *   retry_at: number, pending_reason: string | null, notified_at: number | null,
 *   detail: string, created_at: number}} DumpJob
 * @typedef {{ok: boolean, agents: DumpAgent[],
 *   conversations: {id: string, kind: string, key: string, name: string | null}[],
 *   participants: {conversation_id: string, agent_id: string, role: string}[],
 *   messages: {id: string, seq: number, conversation_id: string, from_agent_id: string, body: string, kind: string}[],
 *   approvals: unknown[], wakeJobs: DumpJob[], readStates: unknown[], agentKeys: unknown[]}} TestDump
 * @typedef {{agentId: string, stage: string}} McpReceipt
 * @typedef {{seq: number, id: string, conversationId: string, fromAgentId: string, body: string,
 *   kind: string, createdAt: number}} McpMessage
 * @typedef {{message: McpMessage, receipts: McpReceipt[], readReceipts: McpReceipt[],
 *   mentions?: {scope: string, matched: {id: string, name: string}[], unmatched: string[]}}} McpSendResult
 */

/**
 * 建 Hub 裸 HTTP 客户端。
 *
 * @param {{baseUrl: string, token: string, log?: (message: string) => void}} options
 */
export function createHubHttp(options) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const auth = { authorization: `Bearer ${options.token}`, "content-type": "application/json" }

  /** 裸请求：返回 `{status, ok, json, text, method, path}`（不抛，供状态码断言）。 */
  async function httpJson(path, request = {}) {
    const method = request.method ?? "POST"
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: auth,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
    const text = await response.text()
    let json
    try {
      json = text === "" ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, ok: response.ok, json, text, path, method }
  }

  /** 状态上报（**原始结果**，含 409 `child_never_offline` / `transition_rejected`）。 */
  async function setState(agentId, state) {
    const result = await httpJson("/internal/state", { body: { agentId, state } })
    return { agentId, state, status: result.status, ok: result.ok, error: result.json?.error, body: result.json }
  }

  /** 测试面请求：未开启时抛**清晰**错误（绝不静默降级成"断言通过"）。 */
  async function testApi(path, request = {}) {
    const result = await httpJson(path, request)
    if (result.status === 404) {
      throw new Error(
        `测试接口未开启：${result.method} ${path} → 404。Hub 必须以 AGENTCHAT_TEST_API=1 启动（--spawn 会自动注入）。`,
      )
    }
    if (!result.ok) {
      throw new Error(`${result.method} ${path} → ${result.status}：${result.text.slice(0, 300)}`)
    }
    return result.json
  }

  /** @returns {Promise<TestDump>} */
  const dump = () => testApi("/api/test/dump", { method: "GET" })
  const reset = () => testApi("/api/test/reset", { body: { confirm: "RESET" } })
  /** @returns {Promise<{conversation: {id: string, kind: string, key: string, name: string | null}}>} */
  const createGroup = (name, memberIds) =>
    testApi("/api/test/conversations", { body: { kind: "group", name, memberIds } })
  /** @returns {Promise<{conversation: {id: string, kind: string, key: string}}>} */
  const createDm = (a, b) => testApi("/api/test/conversations", { body: { kind: "dm", a, b } })
  /** @returns {Promise<McpSendResult>} */
  const sendAsHuman = (conversationId, body, extra = {}) =>
    testApi(`/api/test/conversations/${conversationId}/messages`, { body: { body, ...extra } })
  /** @returns {Promise<McpSendResult>} */
  const shoutAsHuman = (body) => testApi("/api/test/shout", { body: { body } })
  const markRead = (conversationId, agentId) =>
    testApi(`/api/test/conversations/${conversationId}/read`, { body: { agentId } })

  return { httpJson, setState, testApi, dump, reset, createGroup, createDm, sendAsHuman, shoutAsHuman, markRead }
}
