#!/usr/bin/env node
/**
 * AgentChat OpenCode MCP 桥：本地 **stdio MCP server**，把 JSON-RPC 透明转发到 Hub 的
 * `/mcp`（streamable-HTTP 有状态会话）。
 *
 * 为什么存在：OpenCode 的 `{file:…}` 变量替换在**解析配置前对整份文件原文**执行，文件缺失即
 * 致命（`Configuration is invalid … bad file reference`），而 `<home>/agents/opencode.id` 只在
 * 插件注册成功后生成 —— 会形成「起不来→注册不了→文件永不生成」的死锁。故配置里**不再引用**任何
 * 生成文件；身份与传输 token 改由本桥**逐请求从磁盘读取**：
 *   - `Authorization: Bearer <AGENTCHAT_HOME>/hub_token`
 *   - `x-agent-id: <AGENTCHAT_HOME>/agents/opencode.id`（**不存在则省略该头**，不报错、不拒绝启动）
 *
 * 语义（Hub 契约，见 `server/routes/mcp.ts`）：
 *   - 无 `mcp-session-id` 的 POST = `initialize`；从响应头 `Mcp-Session-Id` 取会话 id 并在后续请求回带；
 *   - `notifications/initialized` 与其它请求带会话 id；
 *   - 响应同时支持 `application/json` 与 `text/event-stream`（逐行解析 `data:`）；
 *   - `404 session_not_found`（会话 TTL 淘汰 / Hub 重启）→ 重新 `initialize` 一次并重试。
 *
 * 环境缺失绝不拖垮宿主：本脚本启动即就绪，只有**首次工具调用**才因 Hub/token 缺失失败，且以
 * JSON-RPC error 回给宿主、进程保持存活。
 *
 * 纯 JS（不参与 `tsc`）；只用 Node 内置 `fetch`/`node:*`；无第三方依赖。
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { createFileLog } from "./file-log.mjs"

const DEFAULT_PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "agentchat-opencode-bridge", version: "0.1.0" }

/**
 * 逐调用会话提示键（插件 `tool.execute.before` 注入到 `tools/call` 入参）：桥**剥离**它
 * （Hub 绝不能看到，否则撞 MCP 入参校验）并转为请求头 `x-agentchat-session`，供 Hub 按
 * 会话节点 `task_ref` 解析真实发送方（否则回复会冒名实例容器）。
 */
const SESSION_ARG = "x-agentchat-session"

function env(name) {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveHome() {
  return env("AGENTCHAT_HOME") ?? join(homedir(), ".agentchat")
}

function hubMcpUrl() {
  const base = env("AGENTCHAT_URL") ?? `http://127.0.0.1:${env("AGENTCHAT_PORT") ?? "4646"}`
  return `${base.replace(/\/+$/, "")}/mcp`
}

function readTrimmed(path) {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

// 诊断**只落文件**（`<home>/logs/opencode-adapter.log`，tag `bridge`，与插件同一文件）：
// stdout 恒为 JSON-RPC、stderr 恒为空——绝不污染宿主（OpenCode）终端；`AGENTCHAT_LOG=console` 回退。
const log = createFileLog(process.env, "bridge")

function isRequestId(id) {
  return id !== undefined && id !== null
}

// ── 会话状态（进程级；逐请求读盘，会话仅缓存会话 id 与 initialize 参数）──

let sessionId
let initializeParams

function buildHeaders() {
  const home = resolveHome()
  const tokenPath = join(home, "hub_token")
  const token = readTrimmed(tokenPath)
  if (token === undefined) {
    throw new Error(
      `读不到 Hub 传输门 token（${tokenPath}）；请先启动 Hub（npm start）使 hub_token 生成后再调用工具`,
    )
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  }
  const agentId = readTrimmed(join(home, "agents", "opencode.id"))
  if (agentId !== undefined) headers["x-agent-id"] = agentId
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
      log(`忽略无法解析的 SSE data：${payload.slice(0, 200)}`)
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
    (contentType ?? "").includes("text/event-stream") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:")
  if (isSse) return parseSse(trimmed)
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** 上游请求超时：默认 30s；`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖，钳制到 [100ms, 600000ms]，非法回落默认。 */
function requestTimeoutMs() {
  const parsed = Number.parseInt(env("AGENTCHAT_MCP_TIMEOUT_MS") ?? "", 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000
  return Math.min(Math.max(parsed, 100), 600_000)
}

/**
 * 取并**原地剥离** `tools/call` 入参里的会话提示：无该键返回 `undefined`；有则该键必被删除
 * （Hub 绝不能看到），值为非空字符串时返回其值作转发请求头 `x-agentchat-session`。
 */
function takeSessionHint(message) {
  if (message.method !== "tools/call" || !isRecord(message.params)) return undefined
  const args = message.params.arguments
  if (!isRecord(args)) return undefined
  const value = args[SESSION_ARG]
  delete args[SESSION_ARG]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/** POST 一个 JSON-RPC 消息；返回 `{status, messages}`；确定性错误抛带诊断的 Error。 */
async function post(message, includeSession, extraHeaders) {
  const headers = buildHeaders()
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  if (includeSession && sessionId !== undefined) headers["mcp-session-id"] = sessionId
  const url = hubMcpUrl()
  const timeoutMs = requestTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let text
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      aborted
        ? `请求 Hub 超时（${timeoutMs}ms）：${url}；可用 AGENTCHAT_MCP_TIMEOUT_MS 调大窗口`
        : `无法连接 AgentChat Hub（${url}）：${detail}；请确认 Hub 已启动`,
    )
  } finally {
    clearTimeout(timer)
  }
  const newSession = response.headers.get("mcp-session-id")
  if (newSession !== null && newSession !== "") sessionId = newSession
  if (response.status === 202) return { status: 202, messages: [] }
  if (response.status === 401) {
    throw new Error(`Hub 拒绝（401 unauthorized）：${join(resolveHome(), "hub_token")} 与 Hub 的 token 不一致；请取其内容重新比对`)
  }
  if (response.status === 400 && text.includes("agent_not_found")) {
    throw new Error(
      `Hub 返回 400 agent_not_found：${join(resolveHome(), "agents", "opencode.id")} 中的 id 陈旧或尚未注册；删除该文件并让插件重新注册`,
    )
  }
  if (response.status === 404) {
    // 仅「会话被 TTL 淘汰 / Hub 重启」才自愈重 init；其它 404 按普通错误返回，不误开新会话。
    if (text.includes("session_not_found")) return { status: 404, sessionLost: true, messages: [] }
    throw new Error(`Hub /mcp 返回 404：${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`Hub /mcp 返回 ${response.status}：${text.slice(0, 300)}`)
  return { status: response.status, messages: parseMessages(text, response.headers.get("content-type")) }
}

/** 开一个新会话（initialize + notifications/initialized），用于首启兜底与 404 自愈。 */
async function ensureSession() {
  const params =
    initializeParams ?? {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }
  await post({ jsonrpc: "2.0", id: "bridge-init", method: "initialize", params }, false)
  if (sessionId === undefined) throw new Error("Hub 的 initialize 未返回 mcp-session-id")
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true)
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 转发一条宿主消息；响应原样写回 stdout（id 由 Hub 回带，宿主可对齐）。 */
async function forward(message) {
  const isRequest = isRequestId(message.id)
  if (message.method === "initialize") {
    initializeParams = message.params
    sessionId = undefined // 宿主重新 initialize = 开新会话
  } else if (sessionId === undefined) {
    // 宿主跳过 initialize（非标准）时自建会话，避免 Hub 把 tools/* 误当 initialize。
    await ensureSession()
  }
  // 会话提示只从 `tools/call` 入参取一次（首次取时已原地剥离）；会话自愈重试时沿用同一值。
  const hint = takeSessionHint(message)
  const extra = hint === undefined ? undefined : { [SESSION_ARG]: hint }
  let result = await post(message, sessionId !== undefined, extra)
  if (result.status === 404 && result.sessionLost === true && sessionId !== undefined) {
    log("MCP 会话已失效（404 session_not_found），重新 initialize 后重试一次")
    await ensureSession()
    result = await post(message, sessionId !== undefined, extra)
    if (result.status === 404) throw new Error("重新 initialize 后 Hub 仍返回 404 session_not_found")
  }
  for (const forwarded of result.messages) write(forwarded)
  if (isRequest && result.messages.length === 0) {
    throw new Error(`Hub 对 ${String(message.method)} 未返回结果（status ${result.status}）`)
  }
}

async function handleMessage(message) {
  if (Array.isArray(message)) {
    for (const item of message) await forwardOne(item)
    return
  }
  await forwardOne(message)
}

async function forwardOne(message) {
  try {
    await forward(message)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log(`转发失败：${text}`)
    if (isRequestId(message.id)) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } })
    }
  }
}

let chain = Promise.resolve()
function enqueue(line) {
  chain = chain
    .then(() => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log(`忽略非法 JSON：${line.slice(0, 200)}`)
        return undefined
      }
      return handleMessage(message)
    })
    .catch((error) => {
      log(`处理消息失败：${error instanceof Error ? error.message : String(error)}`)
    })
}

const reader = createInterface({ input: process.stdin })
reader.on("line", (line) => {
  if (line.trim() !== "") enqueue(line)
})
// 宿主关闭 stdin（退出）时自然结束；不主动 process.exit，避免截断在途 stdout 写。
reader.on("close", () => log("stdin 关闭，桥退出"))
process.stdin.on("error", () => undefined)
