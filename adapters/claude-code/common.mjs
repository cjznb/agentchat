/**
 * Claude Code hooks 适配器共享层：stdin JSON 读取、3s 超时 HTTP、MCP `register`
 * 握手、`/internal/{state,wake,result}`，以及「任何失败都不阻塞宿主」的 hook 包裹。
 *
 * 只经 HTTP 契约与 Hub 通信（**不 import 本仓 server 代码**）；跨平台纯 Node，无第三方依赖。
 * HTTP 相关调用统一接收 `{baseUrl, token, ms}` 配置对象，避免多参数函数。
 */
import { adapterPaths, appendLog, resolveHome } from "./token.mjs"

export { adapterPaths, appendLog, resolveHome }

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 从环境解析 Hub 连接配置：`AGENTCHAT_URL` 优先（否则 `127.0.0.1:AGENTCHAT_PORT`）、
 * `HUB_TOKEN`、以及 HTTP 超时（默认 3000ms；`AGENTCHAT_HOOK_TIMEOUT_MS` 仅供测试缩短）。
 */
export function hubConfig(env) {
  const port = env["AGENTCHAT_PORT"] ?? "4646"
  const baseUrl = (env["AGENTCHAT_URL"] ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "")
  const parsed = Number.parseInt(env["AGENTCHAT_HOOK_TIMEOUT_MS"] ?? "", 10)
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 3000
  return { baseUrl, token: env["HUB_TOKEN"] ?? "", ms }
}

/** 读全部 stdin 并解析为 JSON 对象；空/非法 → `{}`（hook 继续，不因坏载荷退出）。 */
export async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (text === "") return {}
  try {
    const value = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** MCP 工具层错误（HTTP 200 但 `result.isError`），带稳定 `code` 供降级分流。 */
export class HubToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "HubToolError"
    this.code = code
  }
}

async function postJson(config, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.ms)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    return {
      status: response.status,
      text,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
    }
  } finally {
    clearTimeout(timer)
  }
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
  if (!isRecord(first) || typeof first["text"] !== "string") {
    throw new Error("malformed MCP tool result")
  }
  return { text: first["text"], isError: rpc["result"]["isError"] === true }
}

/** 每次 `register` 走完整握手（register 罕见，换取无跨调用会话复用状态）。 */
export async function mcpRegister(config, args) {
  const accept = { accept: "application/json, text/event-stream" }
  const init = await postJson({ ...config, headers: accept }, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agentchat-claude-code", version: "0.1.0" },
    },
  })
  if (init.status !== 200) throw new Error(`initialize returned ${init.status}`)
  const sessionId = init.sessionId
  if (sessionId === undefined) throw new Error("initialize returned no mcp-session-id")
  const session = { ...accept, "mcp-session-id": sessionId }
  await postJson({ ...config, headers: session }, "/mcp", {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })
  const call = await postJson({ ...config, headers: session }, "/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "register", arguments: args },
  })
  if (call.status !== 200) throw new Error(`tools/call returned ${call.status}`)
  const { text, isError } = toolResultText(parseSseJson(call.text))
  if (isError) {
    const match = /\[([a-z_]+)\]\s*$/.exec(text)
    throw new HubToolError(match === undefined ? undefined : match[1], text)
  }
  const payload = JSON.parse(text)
  const agent = isRecord(payload) && isRecord(payload["agent"]) ? payload["agent"] : undefined
  const agentId = agent !== undefined && typeof agent["id"] === "string" ? agent["id"] : undefined
  if (agentId === undefined) throw new Error("register returned no agent id")
  const joinToken = isRecord(payload) && typeof payload["join_token"] === "string" ? payload["join_token"] : undefined
  return { agentId, joinToken }
}

async function internal(config, path, body) {
  const result = await postJson(config, path, body)
  if (result.status !== 200) throw new Error(`${path} returned ${result.status}`)
  return result.text
}

export async function reportState(config, agentId, state) {
  await internal(config, "/internal/state", { agentId, state })
}

/** 认领积压消息；返回规范化后的消息数组（过滤掉形状不符者）。 */
export async function wake(config, agentId) {
  const parsed = JSON.parse(await internal(config, "/internal/wake", { agentId }))
  const raw = isRecord(parsed) && Array.isArray(parsed["messages"]) ? parsed["messages"] : []
  return raw.filter(
    (m) =>
      isRecord(m) &&
      typeof m["id"] === "string" &&
      typeof m["fromAgentId"] === "string" &&
      typeof m["body"] === "string",
  )
}

export async function reportResult(config, agentId, items) {
  await internal(config, "/internal/result", { agentId, items })
}

/** 把认领到的消息格式化为注入上下文。 */
export function formatMessages(messages) {
  const lines = messages.map((m) => `- [${m.id}] 来自 ${m.fromAgentId}：${m.body}`)
  return ["[AgentChat] 你收到了以下来自其他 agent 的消息，请据此继续工作：", ...lines].join("\n")
}

/** 把消息转成 `/internal/result` 的投递回执项。 */
export function deliveredItems(messages) {
  return messages.map((m) => ({ messageId: m.id, result: "delivered" }))
}

/** 向 stdout 输出 hook 决策 JSON（Claude Code 读取）。 */
export function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * hook 入口包裹：任何异常与本地文件问题都只记日志，退出码恒 0。
 * 这是「不得阻塞/非零退出影响宿主」纪律的单一落点。
 */
export async function runHook(name, task) {
  try {
    await task()
  } catch (error) {
    appendLog(resolveHome(process.env), `${name} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 0
}
