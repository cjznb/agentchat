#!/usr/bin/env node
/**
 * AgentChat ↔ WorkBuddy **stdio MCP 桥**：把 JSON-RPC **透明转发**到 Hub 的 `/mcp`
 * （streamable-HTTP 有状态会话），并在转发前完成两件宿主做不到的事：
 *
 * 1. **身份注入**：逐请求从磁盘读 `Authorization: Bearer <home>/hub_token` 与
 *    `x-agent-id: <home>/agents/workbuddy.id`（**读不到就省略该头**，不报错、不拒绝启动）；
 * 2. **剥离会话提示**：`PreToolUse` hook 注入到 `tools/call` 入参的 `x-agentchat-session`
 *    被**原地删除**（Hub 绝不能看到，否则撞 MCP 入参校验），转成同名请求头。
 *
 * 身份变更必须重建会话（指南 §1.3 / 坑 7）：Hub **只在 `initialize` 时读一次身份**，
 * 而 `x-agentchat-session` 是逐请求头 —— 当它会话值发生变化（含 undefined → defined）时，
 * 丢弃 `mcp-session-id` 重新 `initialize`，否则工具会一直 `identity_required`。
 *
 * 启动即就绪：环境缺失绝不拖垮宿主，只有**首次工具调用**才失败，且以 JSON-RPC error 回给宿主，
 * 进程保持存活。
 *
 * 纯 JS；只用 Node 内置 `fetch` / `node:*`；**stdout 恒为 JSON-RPC 帧**（诊断只落文件日志）。
 */
import { createInterface } from "node:readline"
import { hubConfig } from "./lib/hub.mjs"
import { createLogger } from "./lib/log.mjs"
import { adapterPaths, resolveHome } from "./lib/paths.mjs"
import { SESSION_ARG, takeSessionHint } from "./lib/session-hint.mjs"
import { readText } from "./lib/token.mjs"
import { errorMessage, isRecord } from "./lib/util.mjs"

const DEFAULT_PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "agentchat-workbuddy-bridge", version: "0.1.0" }
/** 上游请求超时：默认 30s；`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖，钳制到 [100ms, 600000ms]。 */
function requestTimeoutMs() {
  const parsed = Number.parseInt(process.env["AGENTCHAT_MCP_TIMEOUT_MS"] ?? "", 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000
  return Math.min(Math.max(parsed, 100), 600_000)
}

const home = resolveHome(process.env)
const paths = adapterPaths(home)
const config = hubConfig(process.env, home)
const log = createLogger(home, "bridge")

let sessionId
let initializeParams
/** 最近一次随请求发出的会话提示；变化时必须重建 Hub 会话（身份只在 initialize 生效）。 */
let currentHint
/** `400 agent_not_found` 后清空一次 id 缓存并只重试一次。 */
let agentIdCache

function buildHeaders(hint) {
  const token = config.token === "" ? undefined : config.token
  if (token === undefined) {
    throw new Error(`读不到 Hub 传输门 token（${paths.home}/hub_token）；请先启动 Hub 使 hub_token 生成后再调用工具`)
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  }
  const agentId = agentIdCache === undefined ? readText(paths.agentId) : agentIdCache
  if (agentId !== undefined) headers["x-agent-id"] = agentId
  if (hint !== undefined) headers[SESSION_ARG] = hint
  return headers
}

/** SSE 逐事件解析（`data:` 可多行；空行 = 事件边界），忽略非 JSON 的 data。 */
function parseSse(text) {
  const messages = []
  let data = []
  const flush = () => {
    if (data.length === 0) return
    const payload = data.join("\n")
    data = []
    if (payload.trim() === "") return
    try {
      messages.push(JSON.parse(payload))
    } catch {
      log(`ignore unparsable SSE data: ${payload.slice(0, 200)}`)
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    else if (line === "") flush()
  }
  flush()
  return messages
}

function parseMessages(text, contentType) {
  const trimmed = text.trim()
  if (trimmed === "") return []
  const isSse =
    (contentType ?? "").includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")
  if (isSse) return parseSse(trimmed)
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** POST 一个 JSON-RPC 消息；返回 `{status, messages, sessionLost}`。 */
async function post(message, includeSession, hint) {
  const headers = buildHeaders(hint)
  if (includeSession && sessionId !== undefined) headers["mcp-session-id"] = sessionId
  const url = `${config.baseUrl}/mcp`
  const timeoutMs = requestTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let text
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal })
    text = await response.text()
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    throw new Error(
      aborted
        ? `请求 Hub 超时（${timeoutMs}ms）：${url}；可用 AGENTCHAT_MCP_TIMEOUT_MS 调大窗口`
        : `无法连接 AgentChat Hub（${url}）：${errorMessage(error)}；请确认 Hub 已启动`,
    )
  } finally {
    clearTimeout(timer)
  }
  const newSession = response.headers.get("mcp-session-id")
  if (newSession !== null && newSession !== "" && newSession !== sessionId) {
    sessionId = newSession
    log(`hub mcp session = ${newSession}`)
  }
  if (response.status === 202) return { status: 202, messages: [] }
  if (response.status === 401) {
    throw new Error(`Hub 拒绝（401 unauthorized）：${paths.home}/hub_token 与 Hub 的 token 不一致`)
  }
  if (response.status === 404) {
    if (text.includes("session_not_found")) return { status: 404, sessionLost: true, messages: [] }
    throw new Error(`Hub /mcp 返回 404：${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`Hub /mcp 返回 ${response.status}：${text.slice(0, 300)}`)
  return { status: response.status, messages: parseMessages(text, response.headers.get("content-type")) }
}

/** 开一个新会话（initialize + notifications/initialized），用于首启兜底、身份变更与 404 自愈。 */
async function ensureSession(hint) {
  const params = initializeParams ?? {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }
  await post({ jsonrpc: "2.0", id: "bridge-init", method: "initialize", params }, false, hint)
  if (sessionId === undefined) throw new Error("Hub 的 initialize 未返回 mcp-session-id")
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true, hint)
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 转发一条宿主消息；响应原样写回 stdout（id 由 Hub 回带，宿主可对齐）。 */
async function forward(message) {
  const isRequest = message.id !== undefined && message.id !== null
  if (message.method === "initialize") {
    initializeParams = message.params
    sessionId = undefined // 宿主重新 initialize = 开新会话
  }
  // 会话提示只在 `tools/call` 上取一次（取时已原地剥离）；自愈重试沿用同一值。
  const { hint } = takeSessionHint(message)
  if (message.method === "tools/call" && hint !== currentHint) {
    log(`session hint changed: ${String(currentHint)} → ${String(hint)}; rebuilding hub session`)
    sessionId = undefined
    currentHint = hint
  }
  if (sessionId === undefined) await ensureSession(currentHint)
  let result = await post(message, sessionId !== undefined, currentHint)
  if (result.status === 404 && result.sessionLost === true) {
    log("hub mcp session lost (404 session_not_found); re-initializing and retrying once")
    await ensureSession(currentHint)
    result = await post(message, sessionId !== undefined, currentHint)
    if (result.status === 404) throw new Error("重新 initialize 后 Hub 仍返回 404 session_not_found")
  }
  for (const forwarded of result.messages) write(forwarded)
  if (isRequest && result.messages.length === 0) {
    throw new Error(`Hub 对 ${String(message.method)} 未返回结果（status ${result.status}）`)
  }
}

async function forwardOne(message) {
  try {
    await forward(message)
  } catch (error) {
    const text = errorMessage(error)
    log(`forward failed: ${text}`)
    if (isRecord(message) && message.id !== undefined && message.id !== null) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } })
    }
  }
}

let chain = Promise.resolve()
function enqueue(line) {
  chain = chain
    .then(async () => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log(`ignore invalid JSON: ${line.slice(0, 200)}`)
        return
      }
      if (Array.isArray(message)) {
        for (const item of message) await forwardOne(item)
        return
      }
      await forwardOne(message)
    })
    .catch((error) => log(`message handling failed: ${errorMessage(error)}`))
}

const reader = createInterface({ input: process.stdin })
reader.on("line", (line) => {
  if (line.trim() !== "") enqueue(line)
})
reader.on("close", () => log("stdin closed; bridge exiting"))
process.stdin.on("error", () => undefined)
