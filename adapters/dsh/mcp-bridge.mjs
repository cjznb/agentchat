#!/usr/bin/env node
/**
 * AgentChat DSH 适配器 · 本地 **stdio MCP 桥**（DSH 版 `adapters/opencode/mcp-bridge.mjs`）。
 *
 * 为什么存在：DSH 的 `@deepseek-ai/dsh-mcp-client` 只能 spawn **本地 stdio MCP server**，而 Hub 的
 * 工具面是 **MCP over streamable-HTTP**（`POST <hub>/mcp`，Bearer 传输门 token）。本桥把 stdin 上的
 * JSON-RPC 帧逐条转发到 Hub `/mcp` 并把回复原样写回 stdout，于是 DSH agent 直接拿到 Hub 的工具
 * （`register` / `send` / `ask` / `roster` / …）。
 *
 * 传输帧：MCP stdio = **换行分隔 JSON**（核实自 `@modelcontextprotocol/sdk` 的 `stdio.ts`：写侧
 * `serializeMessage` = `JSON.stringify(msg) + "\n"`，读侧按 `\n` 切行）——故 stdout **只能**出现
 * JSON-RPC 帧（它同时是 MCP 客户端的解析输入），诊断一律落 `<home>/logs/dsh-adapter.log`
 * （`createFileLog`，scope `mcp-bridge`），**绝不写 stdout**。
 *
 * 会话契约（Hub `server/routes/mcp.ts`）：无 `mcp-session-id` 的 POST = `initialize`（会话 id 从响应头
 * `Mcp-Session-Id` 取，后续请求回带）；响应支持 `application/json` 与 `text/event-stream`（逐 `data:`
 * 行解析）；`404 session_not_found`（会话 TTL 淘汰 / Hub 重启）→ 重新 `initialize` 一次并重试同一请求。
 *
 * ## 相对 OpenCode 桥的差异（本适配器特有）
 * 1. **token 解析**：DSH 的 MCP 客户端 spawn 子进程时**清洗环境**——名字匹配
 *    `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量与全部 `DSH_*` 都被删除，故 `HUB_TOKEN` 常常**不可见**。
 *    桥因此按 `resolveHubToken` 解析：`HUB_TOKEN`（非空优先）→ `<home>/hub_token`，且**逐请求**读盘
 *    （Hub 换 token 后无需重启桥即可自愈）。
 * 2. **出站身份（逐请求解析）**：`x-agent-id` 按 **`<home>/agents/dsh.current`（当前顶层会话节点，
 *    由插件维护）→ `<home>/agents/dsh.id`（实例容器，兜底）** 的判序解析（`lib/token.js` 的
 *    `currentPath` / `agentIdPath`）。为什么必须这样：DSH 的 MCP 客户端在**宿主开机时**就 spawn 本桥，
 *    那时插件还没注册、两个文件都不存在，而 Hub **只在 `initialize` 时**读该头并把它固定给整个会话
 *    （`server/routes/mcp.ts`）——故桥逐请求重读（小文件，命中缓存不触盘），并在**解析值变化**时丢弃
 *    缓存的 `mcp-session-id`，让下一次请求重建会话并带上新身份。`register` 不需要身份；其余工具没有
 *    身份会被 Hub 拒（`identity_required`），这正是必须重建会话的原因。
 *    （容器节点是「分组容器、非聊天对象」：Hub 拒绝以容器为**收件方**的 DM。故只要有一个顶层会话，
 *    身份就是那个会话节点——对端因此可以回复，适配器双向可用；≥2 个顶层会话时提示文件被插件删除，
 *    桥回落到容器：出站调用仍可用，但**回复会被 Hub 拒绝**（对端收到明确错误）。这是本适配器的
 *    已知局限，绝不静默改写收件方。）
 * 3. **逐调用会话提示（转发兼容；本适配器目前无注入方，故为惰性保留）**：`tools/call` 入参里的
 *    `x-agentchat-session` 由桥**原地剥离**（Hub 绝不能看到，否则撞 MCP 入参校验）并转请求头
 *    `x-agentchat-session`，供 Hub 按会话节点 `task_ref` 解析真实发送方。今天没有东西注入该键，
 *    故这段行为等价于不存在；保留是为了与 OpenCode 桥**同契约**——将来 DSH 侧能逐调用注入时无需改桥。
 *
 * 另：桥只代理 `SUPPORTED_REQUESTS` 内的方法——未知请求回 `-32601`（OpenCode 桥为全透明转发）；
 * 未知**通知**只记日志（JSON-RPC 通知**不得**回响应）。Hub 在 POST 响应里下发的通知
 * （如 `notifications/tools/list_changed`）随转发路径**原样**写回 stdout。
 *
 * 纪律：**永不崩溃、永不退出**——非法 JSON、Hub 4xx/5xx、超时、连不上，都在有请求 id 时回 JSON-RPC
 * error、无 id 时只记日志，进程继续服务整场 DSH 会话。纯 ESM；只用 node 内置与本适配器 `lib/*.js`。
 */
import { pathToFileURL } from "node:url"
import { hubTokenPath, resolveHubConfig, resolveHubToken } from "./lib/hub-config.js"
import { resolveHome } from "./lib/home.js"
import { createFileLog } from "./lib/log.js"
import { agentIdPath, currentPath, readToken } from "./lib/token.js"
import { describe, isRecord } from "./lib/util.js"
// 线协议与超时解析在 `lib/mcp-wire.js`（本文件守 250 纯行红线）；同时**原样**再导出
// `createLineFramer` / `requestTimeoutMs`，保持既有导入路径不变。
import {
  createLineFramer, decodeResponse, requestTimeoutMs, SESSION_ARG, takeSessionHint,
} from "./lib/mcp-wire.js"
export { createLineFramer, requestTimeoutMs } from "./lib/mcp-wire.js"

/** 桥自建会话（宿主跳过握手 / 404 自愈）时的协议版本与 clientInfo（宿主正常 initialize 时以宿主参数为准）。 */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "agentchat-dsh-bridge", version: "0.1.0" }

/**
 * Hub 以 `400 {error:"agent_not_found"}` 拒绝身份（`x-agent-id` 已不在 agents 表）时的内部信号：
 * `forward` 捕获它 → 丢弃缓存的 id 与会话 → 重新 `initialize` 并**只重试一次**（绝不循环）。
 */
class AgentNotFoundError extends Error {
  /**
   * @param {string} message 面向宿主的诊断（含应清理的本地文件路径，不含任何密钥值）
   */
  constructor(message) {
    super(message)
    this.name = "AgentNotFoundError"
  }
}

/** 可代理到 Hub 的请求方法（其余请求 → `-32601 method not found`）；Hub 只注册了 tools，其余面照转由 Hub 定夺。 */
const SUPPORTED_REQUESTS = new Set([
  "initialize", "ping", "tools/list", "tools/call",
  "resources/list", "resources/read", "resources/templates/list",
  "resources/subscribe", "resources/unsubscribe",
  "prompts/list", "prompts/get", "logging/setLevel", "completion/complete",
])

/** 可代理的通知方法（不在表内的通知只记日志，绝不回响应）。 */
const SUPPORTED_NOTIFICATIONS = new Set([
  "notifications/initialized", "notifications/cancelled", "notifications/progress", "notifications/roots/list_changed",
])

/** 有 id 即请求（必须回响应）；无 id 即通知（绝不回响应）。 */
const isRequestId = (id) => id !== undefined && id !== null

/**
 * 「尚无身份」在 `x-agent-id` 头里的表示：**不发送该头**（Hub 的 `register` 不需要身份）。
 * 它与「还没记录过本会话用的身份」必须区分，故记录用 `null`（见 `recordSession`）。
 */
const NO_IDENTITY = undefined

/**
 * 建桥（**可嵌入/可单测**：不碰 `process.*`，输入/输出/`fetch`/`env`/日志全注入）。
 *
 * @param {{output: {write(text: string): unknown},
 *   env?: Readonly<Record<string, string | undefined>>,
 *   fetch?: typeof fetch,
 *   input?: {on(event: string, listener: (chunk: string | Uint8Array) => void): unknown},
 *   log?: (message: string) => void,
 *   timeoutMs?: number}} options `output` 是 **MCP 传输写端**（生产 = `process.stdout`，只收 JSON-RPC
 *   帧）；`input` 有值时自动接 `data`/`end`/`close`/`error`（测试可直接用 `push` 喂帧）
 * @returns {{push(chunk: string | Uint8Array): void, drain(): Promise<void>}} 桥句柄
 *   （`drain` 等串行链排空，仅供嵌入/测试）
 */
export function createBridge(options) {
  const env = options.env ?? process.env
  const log = options.log ?? createFileLog(env, "mcp-bridge")
  const output = options.output
  const fetchImpl = options.fetch ?? globalThis.fetch
  const url = `${resolveHubConfig(env).baseUrl}/mcp`
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs(env)
  const home = resolveHome(env)
  const idFile = agentIdPath(home)
  const hintFile = currentPath(home)

  let sessionId
  let initializeParams
  /** 最近一次解析到的出站身份（`undefined` = 尚无身份，本次请求不带 `x-agent-id`）。 */
  let identity
  /** 是否已解析出身份并缓存（**只在命中时**置位：文件未生成 ≠ 永久无身份）。 */
  let identityResolved = false
  /** 是否已读过提示文件（即使它不存在；用于区分「还没读」与「读到的就是空」）。 */
  let hintResolved = false
  /** 最近一次读到的提示原始值（`undefined` = 提示不存在/为空）：只用于判断是否变化。 */
  let hintValue
  /**
   * 当前 Hub MCP 会话建立时携带的身份（`null` = 已记录为「当时还没有身份」，
   * `undefined` = 尚**没有**任何会话身份记录）。两者必须区分：见 `NO_IDENTITY`。
   */
  let sessionAgentId

  /** 唯一 stdout 写点：一行一个 JSON-RPC 帧；写失败（EPIPE 等）只记日志，绝不抛断桥。 */
  function write(message) {
    try { output.write(`${JSON.stringify(message)}\n`) } catch (error) { log(`写 MCP 输出失败：${describe(error)}`) }
  }

  /**
   * 逐请求解析出站身份：**先 `<home>/agents/dsh.current`（当前顶层会话节点，可回复），
   * 后 `<home>/agents/dsh.id`（实例容器，兜底）**；两者都读不到 → `undefined`（不带该头）。
   *
   * 开销控制：**提示文件逐请求重读**（很小一行），但**只有它变化时**才丢弃缓存去重解析
   * （缓存值 = 上次命中的身份）。这样「身份从无到有 / 换成别的会话节点」都能立刻生效，而
   * 不变时既不触盘第二个文件，也**不会**误触发重建会话（重建由 `forward` 比较记录值决定）。
   *
   * @returns {string | undefined} 本次请求应带的 `x-agent-id`
   */
  function resolveIdentity() {
    const hint = readToken(hintFile, { log })
    const hintChanged = !hintResolved || hint !== hintValue
    hintResolved = true
    hintValue = hint
    if (!hintChanged && identityResolved) return identity
    const value = hint ?? readToken(idFile, { log })
    if (value === NO_IDENTITY) {
      identity = NO_IDENTITY
      identityResolved = false
      return NO_IDENTITY
    }
    identity = value
    identityResolved = true
    log(`出站身份 ${value}（取自 ${hint === NO_IDENTITY ? idFile : hintFile}）`)
    return value
  }

  /**
   * 记录「当前会话是用哪个身份建立的」。`null` 与 `undefined` 的区别很重要：
   * 前者 = 明确记为「建会话时还没有身份」（之后身份从无到有即需重建），后者 = 尚无记录。
   */
  function recordSession() {
    sessionAgentId = identityResolved ? identity : null
  }

  /** 清掉身份缓存：下一次请求会**重读**两个文件（Hub 数据重置 / id 文件换了内容时用）。 */
  function forgetIdentity() {
    identity = undefined
    identityResolved = false
    hintResolved = false
  }

  /**
   * 强制下一次请求重建 Hub MCP 会话：Hub 只在 `initialize` 时认 `x-agent-id`，既有会话**永不**
   * 重读该头，故身份变化（含 `undefined → 已定义`）必须丢弃缓存的 `mcp-session-id` 与
   * 「本会话建立时的身份」记录（后者由 `recordSession` 在重建后重新写入）。
   */
  function dropSession() {
    sessionId = undefined
    sessionAgentId = undefined
  }

  /**
   * 逐请求构造上游请求头：传输门 token（env → 文件）+ 出站身份（`initialize` 时由 Hub 认领，
   * 拿不到则省略该头，不报错）。
   */
  function buildHeaders() {
    const token = resolveHubToken(env)
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    }
    if (token === "") throw new Error(`读不到 Hub 传输门 token（${hubTokenPath(env)}）；请先启动 Hub 生成 hub_token 后再调用工具`)
    const id = resolveIdentity()
    if (id !== undefined) headers["x-agent-id"] = id
    return headers
  }

  /** POST 一条 JSON-RPC 消息；返回 `{status, messages}`；失败抛带诊断的 Error（**绝不含 token 值**）。 */
  async function post(message, includeSession, extraHeaders) {
    const headers = buildHeaders()
    if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
    if (includeSession && sessionId !== undefined) headers["mcp-session-id"] = sessionId
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let text
    try {
      response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal })
      text = await response.text()
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError"
      throw new Error(aborted
        ? `请求 Hub 超时（${timeoutMs}ms）：${url}；可用 AGENTCHAT_MCP_TIMEOUT_MS 调大窗口`
        : `无法连接 AgentChat Hub（${url}）：${describe(error)}；请确认 Hub 已启动`)
    } finally {
      clearTimeout(timer)
    }
    const newSession = response.headers.get("mcp-session-id")
    if (newSession !== null && newSession !== "") sessionId = newSession
    if (response.status === 202) return { status: 202, messages: [] }
    if (response.status === 401) throw new Error(`Hub 拒绝（401 unauthorized）：${hubTokenPath(env)} 与 Hub 的 token 不一致；请重启 Hub 或重新比对 token 文件`)
    if (response.status === 400 && text.includes("agent_not_found")) {
      throw new AgentNotFoundError(
        `Hub 返回 400 agent_not_found：${hintFile} / ${idFile} 中的 id 陈旧或尚未注册；已丢弃缓存身份并重试一次，若仍失败请等插件重新注册`,
      )
    }
    // 仅「会话被 TTL 淘汰 / Hub 重启」才自愈重 init；其它 404 按普通错误返回，不误开新会话。
    if (response.status === 404 && text.includes("session_not_found")) return { status: 404, sessionLost: true, messages: [] }
    if (!response.ok) throw new Error(`Hub /mcp 返回 ${response.status}：${text.slice(0, 300)}`)
    return { status: response.status, messages: decodeResponse(text, response.headers.get("content-type"), log) }
  }

  /** 开一个新会话（initialize + notifications/initialized）：宿主跳过握手时的兜底与 404 自愈共用。 */
  async function ensureSession() {
    const params = initializeParams ?? { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
    await post({ jsonrpc: "2.0", id: "bridge-init", method: "initialize", params }, false)
    if (sessionId === undefined) throw new Error("Hub 的 initialize 未返回 mcp-session-id")
    // 记下**本会话建立时携带的身份**；此后只有它变化才需要重建会话。
    recordSession()
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true)
  }

  /** 转发一条宿主消息；Hub 回复（含其下发的通知）原样写回 stdout，id 由 Hub 回带。 */
  async function forward(message) {
    // 逐请求重解析身份：命中缓存不触盘；身份变了就必须重建会话（Hub 只在 initialize 读 `x-agent-id`）。
    const resolved = resolveIdentity()
    if (message["method"] === "initialize") {
      initializeParams = message["params"]
      sessionId = undefined // 宿主重新 initialize = 开新会话
      recordSession() // 该会话由本条 initialize 建立，身份 = 本次解析值（可能为「尚无身份」）
    } else if (sessionId === undefined || sessionAgentId !== (resolved ?? null)) {
      // 两个分支共用：宿主跳过 initialize（非标准）的自建会话，与「身份从无到有 / 指向了别的
      // 会话节点」的强制重建——否则既有 Hub 会话永远没有可回复身份（工具报 identity_required）。
      // 比较两侧都把「无身份」归一为 `null`：`sessionAgentId` 的 `undefined` 只表示「尚无记录」。
      dropSession()
      await ensureSession()
    }
    // 会话提示只在首次处理该消息时剥离（原地）；会话自愈重试沿用同一值。
    const hint = takeSessionHint(message)
    const extra = hint === undefined ? undefined : { [SESSION_ARG]: hint }
    /**
     * 单次投递；Hub 以 400 `agent_not_found` 拒绝身份（Hub 数据重置后本地 id 陈旧）时，丢弃缓存
     * 身份与会话记录并**恰好重试一次**：丢缓存迫使重试重读身份文件（插件重注册后已写出新 id），
     * 身份变化又迫使它重建会话（Hub 只在 `initialize` 认 `x-agent-id`）。第二次仍失败即上抛，
     * 绝不循环。
     */
    async function deliverOnce() {
      try {
        return await post(message, sessionId !== undefined, extra)
      } catch (error) {
        if (!(error instanceof AgentNotFoundError)) throw error
        log(`${describe(error)}；丢弃缓存身份与会话，重读身份文件后重试一次`)
        forgetIdentity()
        dropSession()
        // 明确重建会话：重试必须带**新身份**上桌（Hub 只在 initialize 认 `x-agent-id`），
        // 否则重试仍是同一身份、必然再被拒。身份文件若仍是旧值，重试会以同一理由再失败一次。
        await ensureSession()
        return post(message, sessionId !== undefined, extra)
      }
    }
    let result = await deliverOnce()
    const lost = result.status === 404 && result.sessionLost === true
    if (lost && sessionId !== undefined) {
      log("MCP 会话已失效（404 session_not_found），重新 initialize 后重试一次")
      await ensureSession()
      result = await post(message, sessionId !== undefined, extra)
      if (result.status === 404) throw new Error("重新 initialize 后 Hub 仍返回 404 session_not_found")
    }
    for (const forwarded of result.messages) write(forwarded)
    if (isRequestId(message["id"]) && result.messages.length === 0) {
      throw new Error(`Hub 对 ${String(message["method"])} 未返回结果（status ${result.status}）`)
    }
  }

  /** 单条/批量（JSON 数组）分派：先过方法白名单，再转发；**一切失败都兜住**（有 id 回 error，无 id 只记日志）。 */
  async function dispatch(message) {
    if (Array.isArray(message)) {
      for (const item of message) await dispatch(item)
      return
    }
    if (!isRecord(message)) {
      log(`忽略非对象消息：${JSON.stringify(message)?.slice(0, 200) ?? "undefined"}`)
      return
    }
    const method = typeof message["method"] === "string" ? message["method"] : undefined
    const isRequest = isRequestId(message["id"])
    if (method === undefined) {
      if (isRequest) write({ jsonrpc: "2.0", id: message["id"], error: { code: -32600, message: "缺少 method" } })
      else log("忽略无 method 的消息")
      return
    }
    if (!SUPPORTED_REQUESTS.has(method) && !SUPPORTED_NOTIFICATIONS.has(method)) {
      const text = `桥不支持的方法：${method}`
      log(text)
      if (isRequest) write({ jsonrpc: "2.0", id: message["id"], error: { code: -32601, message: text } })
      return
    }
    try {
      await forward(message)
    } catch (error) {
      const text = describe(error)
      log(`转发失败（${method}）：${text}`)
      if (isRequest) write({ jsonrpc: "2.0", id: message["id"], error: { code: -32000, message: text } })
    }
  }

  let chain = Promise.resolve()
  /**
   * 入队一行（串行保序、单消费者）：非法 JSON 只记日志后继续，绝不打断后续帧。
   *
   * **`chain` 必须同步延长**：JSON 解析在 `push()` 内同步完成，`chain.then(...)` 也同步挂上——
   * 否则延长发生在微任务里，`drain()`（与任何「喂完一帧再等它做完」的调用方）可能在派发还没开始
   * 时就以为排空了，从而并发派发下一帧（实测：桥自己的 initialize 尚未写回身份时，下一次 tools/*
   * 就抢跑，导致重复建会话）。串行链的语义是「一帧接一帧」，同步延长才守得住它。
   */
  function enqueue(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log(`忽略非法 JSON：${line.slice(0, 200)}`)
      return
    }
    chain = chain
      .then(() => dispatch(message))
      .catch((error) => log(`处理消息失败：${describe(error)}`))
  }

  const framer = createLineFramer(enqueue, { onOverflow: (message) => log(message) })
  if (options.input !== undefined) {
    let ended = false
    const noteEnd = () => {
      if (!ended) log("stdin 关闭，桥退出")
      ended = true
    }
    options.input.on("data", (chunk) => framer.push(chunk))
    options.input.on("error", () => undefined)
    options.input.on("end", noteEnd)
    options.input.on("close", noteEnd)
  }

  return {
    push: (chunk) => framer.push(chunk),
    /** 等待串行链排空（**仅供嵌入/测试**；生产无需调用）。 */
    async drain() {
      while (true) {
        const current = chain
        await current
        if (current === chain) return
      }
    },
  }
}

/**
 * 进程入口：把 `process.stdin/stdout` 与真实 `fetch` 接进桥（日志默认落 `<home>/logs/dsh-adapter.log`）。
 *
 * @returns {ReturnType<typeof createBridge>} 桥句柄
 */
export function main() {
  const env = process.env
  const log = createFileLog(env, "mcp-bridge")
  const bridge = createBridge({ input: process.stdin, output: process.stdout, fetch: globalThis.fetch, env, log })
  // 硬保证：任何漏网异常只落日志，绝不让桥进程退出（否则 DSH 会话整场失去工具面）。
  process.on("unhandledRejection", (reason) => log(`未处理的 Promise 拒绝：${describe(reason)}`))
  process.on("uncaughtException", (error) => log(`未捕获异常：${describe(error)}`))
  return bridge
}

// 直接 `node mcp-bridge.mjs` 才算入口（被 import 时零副作用，便于单测）。
try {
  if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
} catch {
  // argv[1] 形状异常 → 视为非入口；入口判定绝不崩溃
}
