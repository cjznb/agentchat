/**
 * DSH MCP 桥的**传输线协议**（自 `mcp-bridge.mjs` 抽出，使其留在本仓「单文件 ≤ 250 纯行」红线内）
 * 与超时参数解析。三块内容：
 *
 * 1. **stdio 行帧**（`createLineFramer`）：MCP stdio = 换行分隔 JSON（核实自 `@modelcontextprotocol/sdk`
 *    的 `stdio.ts`：写侧 `serializeMessage` = `JSON.stringify(msg) + "\n"`，读侧按 `\n` 切行），故
 *    stdout **只能**出现 JSON-RPC 帧；跨 chunk 拼接、容忍 `\r\n`、丢弃空行、无换行的超长缓冲整体
 *    丢弃（畸形输入不得撑爆内存）。
 * 2. **上游响应解码**（`decodeResponse`）：Hub `/mcp` 支持 `application/json` 与 `text/event-stream`；
 *    SSE 逐 `data:` 行解析（空行 = 事件边界），无法解析的 data 只记日志后丢弃。
 * 3. **逐调用会话提示**（`takeSessionHint`）：`tools/call` 入参里的 `x-agentchat-session` **原地剥离**
 *    （Hub 绝不能看到，否则撞 MCP 入参校验）并返回其值，供桥转请求头。
 *
 * 纪律：本模块**不写任何输出**（诊断经由注入的 `log`）、无第三方依赖、无副作用。
 */

/** 逐调用会话提示键（见文件头第 3 点；与 OpenCode 桥同契约）。 */
export const SESSION_ARG = "x-agentchat-session"

/** 单行缓冲上限（无换行的畸形输入即丢弃，防内存膨胀）。 */
export const MAX_LINE_LENGTH = 4 * 1024 * 1024

/** 上游默认超时（`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖）。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 上游请求超时：默认 30s；`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖，钳制到 [100ms, 600000ms]，非法回落默认。
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {number}
 */
export function requestTimeoutMs(env) {
  const parsed = Number.parseInt(env["AGENTCHAT_MCP_TIMEOUT_MS"] ?? "", 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(parsed, 100), 600_000)
}

/**
 * 行帧解析器：跨 chunk 拼接、按 `\n` 切帧、容忍 `\r\n`、丢弃空行。
 *
 * @param {(line: string) => void} onLine 每收到一个完整行（已去尾 `\r`）即**同步**回调
 * @param {{maxLength?: number, onOverflow?: (message: string) => void}} [options] `maxLength`（默认
 *   4 MiB）：无换行的缓冲超限即整体丢弃（畸形输入不得撑爆内存）
 * @returns {{push(chunk: string | Uint8Array): void}} 写入端（生产 = stdin 的 `data` 事件）
 */
export function createLineFramer(onLine, options = {}) {
  const maxLength = options.maxLength ?? MAX_LINE_LENGTH
  const onOverflow = options.onOverflow ?? (() => undefined)
  let buffer = ""
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      let index
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        if (line.trim() !== "") onLine(line)
      }
      if (buffer.length > maxLength) {
        buffer = ""
        onOverflow(`单行超过 ${maxLength} 字节且无换行，整段缓冲已丢弃`)
      }
    },
  }
}

/** SSE 逐事件解析（`data:` 可多行；空行 = 事件边界），忽略非 JSON 的 data。 */
function parseSse(text, log) {
  const messages = []
  let data = []
  const flush = () => {
    if (data.length === 0) return
    const payload = data.join("\n")
    data = []
    try {
      if (payload.trim() !== "") messages.push(JSON.parse(payload))
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

/**
 * 上游响应体 → JSON-RPC 消息数组：裸 JSON（或 JSON 数组）或 SSE（按 content-type / 首行判定）。
 *
 * @param {string} text 响应体
 * @param {string | null} contentType `content-type` 头
 * @param {(message: string) => void} log 诊断（SSE 里的非法 data 只记日志）
 * @returns {Array<Record<string, unknown>>} 解析到的消息（空体 → 空数组）
 */
export function decodeResponse(text, contentType, log) {
  const trimmed = text.trim()
  if (trimmed === "") return []
  const sse = (contentType ?? "").includes("text/event-stream") || /^(event|data):/.test(trimmed)
  if (sse) return parseSse(trimmed, log)
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * 取并**原地剥离** `tools/call` 入参里的会话提示：无该键返回 `undefined`；有则该键**必被删除**
 * （Hub 绝不能看到），值为非空字符串时返回其值，用作转发请求头 `x-agentchat-session`。
 *
 * @param {Record<string, unknown>} message 宿主消息（原地修改其 `params.arguments`）
 * @returns {string | undefined}
 */
export function takeSessionHint(message) {
  const args = typeof message["params"] === "object" && message["params"] !== null && !Array.isArray(message["params"])
    ? /** @type {Record<string, unknown>} */ (message["params"])["arguments"]
    : undefined
  if (message["method"] !== "tools/call" || typeof args !== "object" || args === null || Array.isArray(args)) return undefined
  const box = /** @type {Record<string, unknown>} */ (args)
  const value = box[SESSION_ARG]
  delete box[SESSION_ARG]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}
