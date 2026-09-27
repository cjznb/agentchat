/**
 * Claude Code hooks 适配器测试脚手架：mock Hub HTTP 服务端 + 真子进程运行器。
 *
 * 子进程经 `process.execPath` 直接跑 `.mjs`（与生产一致），stdin 喂假 JSON；
 * mock 服务端记录每个请求的路径/方法/鉴权头/JSON 载荷，供断言。
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

export function script(name: string): string {
  return join(ADAPTER_DIR, `${name}.mjs`)
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
  /** 覆盖 MCP `tools/call`（register）响应；`index` = 第几次 register（从 0 起）。 */
  readonly register?: (args: unknown, index: number) => RegisterReply
  /** 覆盖 `/internal/*`；返回 `undefined` 走默认成功响应。 */
  readonly internal?: (path: string, body: unknown, index: number) => InternalReply | undefined
  /** 命中的路径永不响应（模拟超时）。 */
  readonly hangPaths?: readonly string[]
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
  return JSON.stringify(
    index === 0
      ? { agent: { id: "agent-1" }, unread: 0, join_token: "jt-1" }
      : { agent: { id: "agent-1" }, unread: 0 },
  )
}

async function handleMcp(
  json: unknown,
  res: ServerResponse,
  toolCalls: unknown[],
  options: HubOptions,
): Promise<void> {
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
    const reply = options.register?.(args, toolCalls.length - 1) ?? { text: defaultRegisterText(toolCalls.length - 1) }
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
      requests.push({
        path,
        method: req.method ?? "GET",
        headers: toHeaderMap(req.headers),
        json,
      })
      if (options.hangPaths?.includes(path) === true) return
      if (path === "/mcp") {
        await handleMcp(json, res, toolCalls, options)
        return
      }
      const reply = options.internal?.(path, json, internalIndex)
      internalIndex += 1
      if (reply !== undefined) {
        sendJson(res, reply.status, reply.body)
        return
      }
      if (path === "/internal/wake") {
        sendJson(res, 200, { messages: [], receipts: [] })
        return
      }
      sendJson(res, 200, { ok: true })
    })()
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const close = (): Promise<void> =>
        new Promise((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
      resolve({ baseUrl: `http://127.0.0.1:${port}`, requests, toolCalls, close })
    })
  })
}

export interface HookRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** 以真实子进程运行某 hook 脚本，stdin 喂入 payload（生产同构）。 */
export function runHook(name: string, payload: unknown, env: Record<string, string>): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script(name)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const homes: string[] = []

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-cc-"))
  homes.push(home)
  return home
}

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}

export function hubEnv(hub: Hub, home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { AGENTCHAT_HOME: home, HUB_TOKEN: "hub-token", AGENTCHAT_URL: hub.baseUrl, ...extra }
}

export function readLog(home: string): string {
  try {
    return readFileSync(join(home, "logs", "claude-code-adapter.log"), "utf8")
  } catch {
    return ""
  }
}

export function stateBodies(hub: Hub): unknown[] {
  return hub.requests.filter((r) => r.path === "/internal/state").map((r) => r.json)
}

export function bodyOf(hub: Hub, path: string): unknown {
  const request = hub.requests.find((r) => r.path === path)
  return request?.json
}
