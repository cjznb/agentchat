/**
 * OpenCode MCP 桥集成测试（真实 Hub + stdio 驱动 `mcp-bridge.mjs`）。
 *
 * 覆盖 brief DoD：
 * ① 桥 ↔ 真 Hub 往返：initialize → tools/list（恰 12）→ tools/call（register）成功
 * ② 首次运行无身份：id 文件缺失时 initialize 仍成功，register 在会话内认领身份
 * ③ 逐请求重读：会话中途写入 id 文件后，后续请求带上 `x-agent-id`（不依赖重启）
 * ④ 失败可诊断且不拖垮宿主：hub_token 缺失 / token 错误 / Hub 未启动
 * ⑤ session_not_found 自愈：404 → 重新 initialize 一次并重试
 *
 * 真 Hub 用临时 `AGENTCHAT_HOME` + `start({port:0})`（沿用 `tests/integration/mcp.test.ts` 模式）。
 * 桥的 `AGENTCHAT_URL`/`AGENTCHAT_HOME` 一律显式注入，且剔除环境中的同类变量，避免污染真机。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MCP_TOOLS } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { isRecord } from "../../adapters/opencode/util"

const BRIDGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "adapters",
  "opencode",
  "mcp-bridge.mjs",
)

// ── stdio 桥客户端 ──────────────────────────────────────────────────

interface BridgeMessage {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

interface Pending {
  resolve(message: BridgeMessage): void
  timer: NodeJS.Timeout
}

/** 以隔离环境（剔除真实 agentchat 变量）驱动桥的 stdin/stdout。 */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  const skip = new Set(["HUB_TOKEN", "AGENTCHAT_HOME", "AGENTCHAT_URL", "AGENTCHAT_PORT"])
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !skip.has(key)) base[key] = value
  }
  return { ...base, ...overrides }
}

class StdioBridge {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = ""
  private readonly pending = new Map<string, Pending>()
  private nextId = 1
  readonly notifications: BridgeMessage[] = []
  /** stdout 收到的**原始行**：用于断言「stdout 全程只写 JSON-RPC 帧」。 */
  readonly rawLines: string[] = []
  stderr = ""

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [BRIDGE_PATH], { env: childEnv(env), stdio: "pipe" })
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString()))
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString()
    })
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed
  }

  request(method: string, params: unknown): Promise<BridgeMessage> {
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise<BridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`bridge timeout waiting for ${method}`))
      }, 20_000)
      this.pending.set(String(id), { resolve, timer })
    })
    this.write({ jsonrpc: "2.0", id, method, params })
    return promise
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    this.child.kill()
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve())
      setTimeout(() => resolve(), 2000)
    })
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** 写一行**原始** stdin（不经 JSON 序列化；用于触发桥的诊断路径）。 */
  writeRaw(line: string): void {
    this.child.stdin.write(line)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== "") {
        this.rawLines.push(line)
        this.dispatch(line)
      }
      index = this.buffer.indexOf("\n")
    }
  }

  private dispatch(line: string): void {
    let message: BridgeMessage
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const id = message.id
    if (typeof id === "number" || typeof id === "string") {
      const entry = this.pending.get(String(id))
      if (entry !== undefined) {
        clearTimeout(entry.timer)
        this.pending.delete(String(id))
        entry.resolve(message)
        return
      }
    }
    this.notifications.push(message)
  }
}

function initializeParams(): unknown {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "0" },
  }
}

function resultOf(message: BridgeMessage): Record<string, unknown> {
  if (!isRecord(message.result)) throw new Error(`expected object result, got ${JSON.stringify(message)}`)
  return message.result
}

function toolNames(message: BridgeMessage): string[] {
  const tools = resultOf(message)["tools"]
  if (!Array.isArray(tools)) throw new Error("tools is not an array")
  return tools.map((tool) => {
    if (!isRecord(tool) || typeof tool["name"] !== "string") throw new Error("malformed tool entry")
    return tool["name"]
  })
}

function toolText(message: BridgeMessage): { readonly text: string; readonly isError: boolean } {
  const result = resultOf(message)
  const content = result["content"]
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]["text"] !== "string") {
    throw new Error("malformed tool content")
  }
  return { text: content[0]["text"], isError: result["isError"] === true }
}

function errorMessage(message: BridgeMessage): string {
  if (!isRecord(message.error) || typeof message.error["message"] !== "string") {
    throw new Error(`expected JSON-RPC error, got ${JSON.stringify(message)}`)
  }
  return message.error["message"]
}

/** stdout 逐行必须是可解析的 JSON-RPC 2.0 帧（任何诊断文字泄漏到 stdout 都在此暴露）。 */
function expectJsonRpcOnly(client: StdioBridge): void {
  for (const line of client.rawLines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`stdout leaked a non-JSON-RPC line: ${line}`)
    }
    expect(isRecord(parsed) && parsed["jsonrpc"] === "2.0").toBe(true)
  }
}

// ── 真 Hub 脚手架 ───────────────────────────────────────────────────

let home = ""
let db: Db
let running: RunningServer
const bridges: StdioBridge[] = []
const stubs: Array<() => Promise<void>> = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentchat-bridge-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  ensureHubToken(join(home, "hub_token"))
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token"), adapters: ["opencode"] })
})

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
  for (const close of stubs.splice(0)) await close()
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function bridge(env: Record<string, string> = {}): StdioBridge {
  const instance = new StdioBridge({ AGENTCHAT_HOME: home, AGENTCHAT_URL: running.url, ...env })
  bridges.push(instance)
  return instance
}

function writeAgentId(agentId: string): void {
  const path = join(home, "agents", "opencode.id")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, agentId)
}

// ── 假 Hub（记录请求头的 404/TTL 场景用）────────────────────────────

interface StubRequest {
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: unknown
}
interface StubReply {
  readonly status: number
  readonly json?: unknown
  readonly sessionId?: string
  readonly body?: string
}
type StubHandler = (request: StubRequest, index: number) => StubReply | undefined

async function startStub(handler: StubHandler): Promise<{
  url: string
  requests: StubRequest[]
}> {
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let body: unknown
      try {
        body = raw === "" ? undefined : JSON.parse(raw)
      } catch {
        body = raw
      }
      const index = requests.length
      requests.push({ headers: req.headers, body })
      const reply = handler({ headers: req.headers, body }, index)
      if (reply === undefined) return // 接受连接但永不响应（模拟 Hub「收下却不回」）
      const headers: Record<string, string> = {}
      if (reply.sessionId !== undefined) headers["mcp-session-id"] = reply.sessionId
      if (reply.body !== undefined) {
        headers["content-type"] = "text/plain"
        res.writeHead(reply.status, headers)
        res.end(reply.body)
        return
      }
      headers["content-type"] = "application/json"
      res.writeHead(reply.status, headers)
      res.end(reply.json === undefined ? "" : JSON.stringify(reply.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("stub has no address")
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  stubs.push(close)
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

function methodOf(body: unknown): unknown {
  return isRecord(body) ? body["method"] : undefined
}
function idOf(body: unknown): unknown {
  return isRecord(body) ? body["id"] : undefined
}

/** 假 Hub 的 initialize 响应（回带请求 id + 会话 id）。 */
function stubInitializeFor(body: unknown, sessionId: string): StubReply {
  return {
    status: 200,
    sessionId,
    json: {
      jsonrpc: "2.0",
      id: idOf(body),
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0" },
      },
    },
  }
}

// ── ① 桥 ↔ 真 Hub 往返 ──────────────────────────────────────────────

describe("桥 ↔ 真 Hub 往返", () => {
  it("initializes, lists the twelve tools, and executes a register tool call", async () => {
    const client = bridge()
    const init = await client.request("initialize", initializeParams())
    expect(init.error).toBeUndefined()
    expect(isRecord(init.result)).toBe(true)

    client.notify("notifications/initialized", {})

    const list = await client.request("tools/list", {})
    expect(toolNames(list)).toEqual([...MCP_TOOLS])
    expect(toolNames(list)).toHaveLength(12)

    const call = await client.request("tools/call", {
      name: "register",
      arguments: { vendor: "opencode", name: "bridge-root" },
    })
    expect(call.error).toBeUndefined()
    const { text, isError } = toolText(call)
    expect(isError).toBe(false)
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || !isRecord(parsed["agent"]) || typeof parsed["agent"]["id"] !== "string") {
      throw new Error("register did not return an agent id")
    }
    // 诊断不进宿主终端：往返全程 stderr 为空、stdout 只有 JSON-RPC 帧。
    expect(client.stderr).toBe("")
    expectJsonRpcOnly(client)
  })
})

// ── ② 首次运行无身份 ────────────────────────────────────────────────

describe("首次运行无身份文件", () => {
  it("initializes without x-agent-id and lets register claim identity in-session", async () => {
    const client = bridge()
    const init = await client.request("initialize", initializeParams())
    expect(init.error).toBeUndefined()

    client.notify("notifications/initialized", {})

    // 尚无身份：要求身份的工具应报 identity_required（证明 initialize 未带 x-agent-id）。
    const anonymous = await client.request("tools/call", { name: "inbox", arguments: {} })
    const before = toolText(anonymous)
    expect(before.isError).toBe(true)
    expect(before.text).toContain("identity_required")

    // register 认领身份；随后的身份工具应成功。
    const registered = await client.request("tools/call", {
      name: "register",
      arguments: { vendor: "opencode", name: "bridge-no-id" },
    })
    expect(toolText(registered).isError).toBe(false)

    const after = await client.request("tools/call", { name: "inbox", arguments: {} })
    expect(toolText(after).isError).toBe(false)
  })
})

// ── ③ 逐请求重读 id 文件 ────────────────────────────────────────────

describe("逐请求重读身份文件", () => {
  it("adds x-agent-id to later requests once the id file appears mid-session", async () => {
    const stub = await startStub((request, index) => {
      const method = methodOf(request.body)
      if (method === "initialize") return stubInitializeFor(request.body, "stub-s1")
      if (index === 1) return { status: 202, body: "" }
      return {
        status: 200,
        json: { jsonrpc: "2.0", id: idOf(request.body), result: { tools: [] } },
      }
    })
    const client = bridge({ AGENTCHAT_URL: stub.url })
    const init = await client.request("initialize", initializeParams())
    expect(init.error).toBeUndefined()
    client.notify("notifications/initialized", {})

    // 首次 tools/list 之前无 id 文件 → 不带该头。
    await client.request("tools/list", {})
    expect(stub.requests[0]?.headers["x-agent-id"]).toBeUndefined()
    expect(stub.requests[2]?.headers["x-agent-id"]).toBeUndefined()

    writeAgentId("agent-late")

    // 会话中途写盘后，后续请求逐次读盘带上 x-agent-id（无需重启桥）。
    await client.request("tools/list", {})
    const later = stub.requests[3]
    expect(later?.headers["x-agent-id"]).toBe("agent-late")
  })
})

// ── 逐调用会话提示：剥离入参 + 转请求头（M2）─────────────────────────

describe("逐调用会话提示（x-agentchat-session）", () => {
  function toolReplyStub(request: StubRequest, index: number): StubReply {
    const method = methodOf(request.body)
    if (method === "initialize") return stubInitializeFor(request.body, "stub-s1")
    if (index === 1) return { status: 202, body: "" }
    return {
      status: 200,
      json: { jsonrpc: "2.0", id: idOf(request.body), result: { content: [{ type: "text", text: "{}" }] } },
    }
  }

  it("strips the session arg from tools/call and forwards it as a request header", async () => {
    const stub = await startStub(toolReplyStub)
    const client = bridge({ AGENTCHAT_URL: stub.url })
    await client.request("initialize", initializeParams())
    client.notify("notifications/initialized", {})

    const reply = await client.request("tools/call", {
      name: "send",
      arguments: { to: "peer", body: "hi", "x-agentchat-session": "sess-9" },
    })
    expect(reply.error).toBeUndefined()

    const call = stub.requests.find((request) => methodOf(request.body) === "tools/call")
    if (call === undefined) throw new Error("bridge never forwarded tools/call")
    // ① 会话 id 作为请求头转发；② 入参里该键已被剥离（Hub 绝不能看到）。
    expect(call.headers["x-agentchat-session"]).toBe("sess-9")
    const params = isRecord(call.body) ? call.body["params"] : undefined
    const args = isRecord(params) ? params["arguments"] : undefined
    if (!isRecord(args)) throw new Error("tools/call had no arguments")
    expect(args["x-agentchat-session"]).toBeUndefined()
    expect(args["to"]).toBe("peer")
  })

  it("does not add the session header when the argument is absent", async () => {
    const stub = await startStub(toolReplyStub)
    const client = bridge({ AGENTCHAT_URL: stub.url })
    await client.request("initialize", initializeParams())
    client.notify("notifications/initialized", {})
    await client.request("tools/call", { name: "send", arguments: { to: "peer", body: "hi" } })

    const call = stub.requests.find((request) => methodOf(request.body) === "tools/call")
    if (call === undefined) throw new Error("bridge never forwarded tools/call")
    expect(call.headers["x-agentchat-session"]).toBeUndefined()
  })
})

// ── ⑤ session_not_found 自愈 ────────────────────────────────────────

describe("session_not_found 自愈", () => {
  it("re-initializes once and retries the request when the session is gone", async () => {
    let initializeCount = 0
    const stub = await startStub((request, index) => {
      const method = methodOf(request.body)
      if (method === "initialize") {
        initializeCount += 1
        return stubInitializeFor(request.body, initializeCount === 1 ? "stub-s1" : "stub-s2")
      }
      if (index === 1 || index === 4) return { status: 202, body: "" }
      if (index === 2) return { status: 404, json: { ok: false, error: "session_not_found" } }
      return {
        status: 200,
        json: { jsonrpc: "2.0", id: idOf(request.body), result: { tools: [] } },
      }
    })
    const client = bridge({ AGENTCHAT_URL: stub.url })
    await client.request("initialize", initializeParams())
    client.notify("notifications/initialized", {})

    const list = await client.request("tools/list", {})
    toolNames(list) // 解析成功 = 重试拿到了结果，而非把 404 体转发给宿主

    expect(initializeCount).toBe(2)
    expect(stub.requests).toHaveLength(6)
    expect(methodOf(stub.requests[3]?.body)).toBe("initialize")
    expect(stub.requests[5]?.headers["mcp-session-id"]).toBe("stub-s2")
  })
})

// ── ④ 失败可诊断且不拖垮宿主 ────────────────────────────────────────

describe("上游超时与 404 收紧", () => {
  it("times out a hung upstream with a JSON-RPC error, keeps the process alive and the serial chain usable", async () => {
    const stub = await startStub((request, index) => {
      if (index === 0) return undefined // 接受连接但永不响应
      return stubInitializeFor(request.body, "stub-after-timeout")
    })
    const client = bridge({ AGENTCHAT_URL: stub.url, AGENTCHAT_MCP_TIMEOUT_MS: "300" })

    const first = await client.request("initialize", initializeParams())
    expect(errorMessage(first)).toContain("超时")
    expect(client.alive).toBe(true)

    // 串行链未被毒化：超时后的下一个请求照常成功。
    const second = await client.request("initialize", initializeParams())
    expect(second.error).toBeUndefined()
    expect(isRecord(second.result)).toBe(true)
  })

  it("does not re-initialize on a 404 that is not session_not_found", async () => {
    let initializeCount = 0
    const stub = await startStub((request, index) => {
      if (methodOf(request.body) === "initialize") {
        initializeCount += 1
        return stubInitializeFor(request.body, "stub-s1")
      }
      if (index === 1) return { status: 202, body: "" }
      return { status: 404, json: { ok: false, error: "other_not_found" } }
    })
    const client = bridge({ AGENTCHAT_URL: stub.url })
    await client.request("initialize", initializeParams())
    client.notify("notifications/initialized", {})

    const list = await client.request("tools/list", {})
    expect(errorMessage(list)).toContain("404")
    expect(initializeCount).toBe(1) // 未因普通 404 重开会话
    expect(stub.requests).toHaveLength(3)
  })
})

describe("失败路径可诊断且不使宿主启动失败", () => {
  it("reports a missing hub_token without crashing", async () => {
    rmSync(join(home, "hub_token"), { force: true })
    const client = bridge()
    const init = await client.request("initialize", initializeParams())
    expect(errorMessage(init)).toContain("hub_token")
    expect(client.alive).toBe(true)
  })

  it("reports a 401 on token mismatch without crashing", async () => {
    // 先用无鉴权请求迫使 Hub 惰性读取并缓存正确的 hub_token，再篡改磁盘上的 token，
    // 使桥送出的 Bearer 与 Hub 期望值不一致（否则 Hub 会在首次请求时读到被改的文件）。
    const probe = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
    await probe.text()
    expect(probe.status).toBe(401)
    writeFileSync(join(home, "hub_token"), "wrong-token")

    const client = bridge()
    const init = await client.request("initialize", initializeParams())
    expect(errorMessage(init)).toContain("401")
    expect(client.alive).toBe(true)
  })

  it("reports an unreachable Hub without crashing", async () => {
    const client = bridge({ AGENTCHAT_URL: "http://127.0.0.1:1" })
    const init = await client.request("initialize", initializeParams())
    expect(errorMessage(init)).toContain("无法连接")
    expect(client.alive).toBe(true)
  })
})

// ── 诊断只进日志文件：stdout 恒为 JSON-RPC、stderr 恒为空 ────────────

describe("桥诊断日志落文件", () => {
  it("routes diagnostics to <home>/logs/opencode-adapter.log and keeps stdout JSON-RPC-only with empty stderr", async () => {
    const client = bridge()
    const init = await client.request("initialize", initializeParams())
    expect(init.error).toBeUndefined()

    // 触发一条诊断（旧实现会把这行打进宿主 stderr / OpenCode 终端）。
    client.writeRaw("{not json\n")

    const logFile = join(home, "logs", "opencode-adapter.log")
    await vi.waitFor(
      () => {
        expect(readFileSync(logFile, "utf8")).toContain("忽略非法 JSON")
      },
      { timeout: 5000 },
    )

    expect(readFileSync(logFile, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[bridge\] /m)
    expect(client.stderr).toBe("")
    expectJsonRpcOnly(client)
    expect(client.alive).toBe(true)
  })

  it("keeps writing diagnostics to stderr when AGENTCHAT_LOG=console (debug fallback)", async () => {
    const client = bridge({ AGENTCHAT_LOG: "console" })
    client.writeRaw("{not json\n")

    await vi.waitFor(
      () => {
        expect(client.stderr).toContain("忽略非法 JSON")
      },
      { timeout: 5000 },
    )
    expect(existsSync(join(home, "logs", "opencode-adapter.log"))).toBe(false)
    expectJsonRpcOnly(client)
  })
})
