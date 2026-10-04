/**
 * WorkBuddy 适配器测试脚手架：mock Hub HTTP 服务端 + 真子进程 hook/桥运行器。
 *
 * 子进程经 `process.execPath` 直接跑 `.mjs`（与生产一致），stdin 喂假载荷；
 * mock 服务端记录每个请求的路径/方法/鉴权头/JSON 载荷，供断言「可观察量」而非 mock 计数。
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
export const LOG_NAME = "workbuddy-adapter.log"

/**
 * 解析 hook 脚本路径。`name` 可带或不带 `.mjs` 后缀（调用方两种写法都出现过，
 * 曾因无条件拼接后缀产生 `x.mjs.mjs` 的 MODULE_NOT_FOUND —— 见下方 `runHook` 注释）。
 */
export function script(name: string): string {
  return join(ADAPTER_DIR, "hooks", name.endsWith(".mjs") ? name : `${name}.mjs`)
}

export interface HubRequest {
  readonly path: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly json: unknown
}

export interface RegisterReply {
  readonly text: string
  readonly isError?: boolean
}

export interface InternalReply {
  readonly status: number
  readonly body: unknown
}

export interface HubOptions {
  /** 覆盖 MCP `tools/call` 响应；`index` = 第几次 tools/call（从 0 起）。 */
  readonly toolCall?: (args: unknown, index: number) => RegisterReply
  /** 覆盖 `/internal/*`；返回 `undefined` 走默认成功响应。 */
  readonly internal?: (path: string, body: unknown, index: number) => InternalReply | undefined
  /** 前 N 次 `/internal/*` 请求返回 500（用于验证退避与自愈）。 */
  readonly failInternalTimes?: number
  /** 永远返回 401（用于验证"不循环重试"）。 */
  readonly alwaysUnauthorized?: boolean
}

export interface Hub {
  readonly baseUrl: string
  readonly requests: HubRequest[]
  readonly toolCalls: unknown[]
  close(): Promise<void>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function toHeaderMap(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(",") : (value ?? "")
  }
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendSse(res: ServerResponse, payload: unknown, sessionId?: string): void {
  const headers: Record<string, string> = { "content-type": "text/event-stream" }
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId
  res.writeHead(200, headers)
  res.end(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 默认 register 文本：首次返回 join_token，后续（认领）省略。 */
export function defaultRegisterText(index: number): string {
  return JSON.stringify(index === 0 ? { agent: { id: "agent-1" }, join_token: "jt-1" } : { agent: { id: "agent-1" } })
}

/** 默认 wake 文本。 */
export function wakeText(messages: readonly unknown[]): string {
  return JSON.stringify({ messages })
}

function handleMcp(json: unknown, res: ServerResponse, toolCalls: unknown[], options: HubOptions): void {
  const method = isRecord(json) ? json["method"] : undefined
  if (method === "initialize") {
    sendSse(res, { jsonrpc: "2.0", id: 1, result: {} }, "sess-1")
    return
  }
  if (method === "notifications/initialized") {
    res.writeHead(202)
    res.end()
    return
  }
  if (method === "tools/call") {
    const params = isRecord(json) ? json["params"] : undefined
    const args = isRecord(params) ? params["arguments"] : undefined
    toolCalls.push(args)
    const reply = options.toolCall?.(args, toolCalls.length - 1) ?? { text: defaultRegisterText(toolCalls.length - 1) }
    const result: Record<string, unknown> = { content: [{ type: "text", text: reply.text }] }
    if (reply.isError === true) result["isError"] = true
    sendSse(res, { jsonrpc: "2.0", id: 2, result })
    return
  }
  sendJson(res, 400, { error: "unknown mcp method" })
}

export function startHub(options: HubOptions = {}): Promise<Hub> {
  const requests: HubRequest[] = []
  const toolCalls: unknown[] = []
  let internalIndex = 0
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const path = url.pathname
      const raw = await readBody(req)
      let json: unknown
      try {
        json = raw === "" ? undefined : JSON.parse(raw)
      } catch {
        json = undefined
      }
      requests.push({ path, method: req.method ?? "GET", headers: toHeaderMap(req.headers), json })
      const index = internalIndex
      internalIndex += 1
      // `alwaysUnauthorized` 对 **所有** 端点生效（含 `/mcp`）：否则「Hub 永远 401」这个前提
      // 只覆盖 `/internal/*`，桥的 initialize 仍会成功，用例便测不到 401 路径。
      if (options.alwaysUnauthorized === true) {
        sendJson(res, 401, { error: "unauthorized" })
        return
      }
      if (path === "/mcp") {
        handleMcp(json, res, toolCalls, options)
        return
      }
      if (options.failInternalTimes !== undefined && index < options.failInternalTimes) {
        sendJson(res, 500, { error: "boom" })
        return
      }
      const reply = options.internal?.(path, json, index)
      if (reply !== undefined) {
        sendJson(res, reply.status, reply.body)
        return
      }
      if (path === "/internal/wake") {
        sendJson(res, 200, { messages: [] })
        return
      }
      sendJson(res, 200, { ok: true })
    })()
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        toolCalls,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

export interface HookRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * 以真实子进程运行任意 Node 脚本（安装器/脚本）。
 *
 * 注意：**必须用 `spawn` 而非 `spawnSync`** —— 本机 Windows 上 `spawnSync(process.execPath, …)`
 * 会以 `EBUSY` 失败（`errno -4082`，安全软件/句柄竞争），异步 `spawn` 不受影响。
 */
export function runProcess(args: readonly string[], env: Record<string, string> = {}): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * 以真实子进程运行某 hook 脚本，stdin 喂入载荷（生产同构）。
 * `scriptName` 可带或不带 `.mjs`（{@link script} 会归一化）。
 */
export function runHook(scriptName: string, payload: unknown, env: Record<string, string>): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script(scriptName)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

export interface BridgeRun {
  readonly lines: unknown[]
  send(message: unknown): void
  /** 直接写原始文本（用于验证桥对非法输入的容忍与 stdout 纯净性）。 */
  sendRaw(text: string): void
  waitFor(id: unknown, timeoutMs?: number): Promise<Record<string, unknown> | undefined>
  close(): void
}

/** 以真实子进程运行 MCP 桥，按行收发 JSON-RPC。 */
export function runBridge(env: Record<string, string>): BridgeRun {
  const child = spawn(process.execPath, [join(ADAPTER_DIR, "mcp-bridge.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const lines: unknown[] = []
  let stderr = ""
  let buffer = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === "") continue
      try {
        lines.push(JSON.parse(line))
      } catch {
        lines.push({ raw: line })
      }
    }
  })
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
  return {
    lines,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    sendRaw: (text) => child.stdin.write(`${text}\n`),
    waitFor: async (id, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = lines.find((line) => isRecord(line) && line["id"] === id)
        if (found !== undefined) return found as Record<string, unknown>
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return undefined
    },
    close: () => {
      void stderr
      child.kill()
    },
  }
}

const homes: string[] = []

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-wb-"))
  homes.push(home)
  return home
}

/**
 * 清理本文件创建的一次性数据目录。
 *
 * Windows 上刚被 node 子进程碰过的目录可能短暂被锁（AV 扫描 / 句柄回收），故带重试；
 * 真删不掉也**不抛**——否则会把一个**已经断言通过**的用例记成失败（假阴性）。
 */
export function cleanupHomes(): void {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* 临时目录残留由系统清理，不影响本套用例的结论 */
    }
  }
}

export function hubEnv(hub: Hub, home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { AGENTCHAT_HOME: home, HUB_TOKEN: "hub-token", AGENTCHAT_URL: hub.baseUrl, ...extra }
}

/** 适配器日志（用于断言"失败有可诊断的一行"）。 */
export function readLog(home: string): string {
  try {
    return readFileSync(join(home, "logs", LOG_NAME), "utf8")
  } catch {
    return ""
  }
}

export function stateBodies(hub: Hub): unknown[] {
  return hub.requests.filter((r) => r.path === "/internal/state").map((r) => r.json)
}

export function resultBodies(hub: Hub): unknown[] {
  return hub.requests.filter((r) => r.path === "/internal/result").map((r) => r.json)
}

export function bodyOf(hub: Hub, path: string): unknown {
  return hub.requests.find((r) => r.path === path)?.json
}

/** 构造一条 wake 消息。 */
export function message(id: string, body = "hello"): Record<string, string> {
  return { id, fromAgentId: "agent-x", conversationId: "conv-1", body }
}
