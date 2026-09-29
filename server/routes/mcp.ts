/**
 * MCP 端点（spec §9）：以 streamable-HTTP 暴露十个工具。
 *
 * - 传输：`WebStandardStreamableHTTPServerTransport`（Hono 原生 Web Request/Response），
 *   有状态会话 —— 每会话一个 `{server, transport, ctx}`，存模块级 `Map<sessionId, ...>`；
 *   无会话 POST = initialize（此时解析 `x-agent-id` 身份并 `server.connect`），
 *   带 `mcp-session-id` 的请求查表转发（未知 404），`transport.onclose` 清理。
 * - 鉴权：全部 `/mcp` 请求需 `Authorization: Bearer <hubToken>`（复用 internal 的
 *   `ensureHubToken`），否则 401。
 * - 身份：initialize 时 `x-agent-id`（存在则必须命中 agents 表，否则 400；缺省 =
 *   仅注册会话）。`register` 工具在会话内认领身份后写回 `ctx.agentId`。
 */
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono, type Context } from "hono"
import { config } from "../config"
import { openDb, type Db } from "../db"
import { registerTools } from "../mcp/tools"
import type { ToolContext } from "../mcp/context"
import { getAgent, getAgentByTaskRef } from "../store/agents"
import { ensureHubToken } from "./internal"

/** 空闲会话淘汰阈值（缺省 30min）：SDK 客户端 `close()` 只 abort 不发 DELETE，必须有 TTL 兜底。 */
export const DEFAULT_SESSION_TTL_MS = 1_800_000

export interface McpRoutesOptions {
  /** `hub_token` 路径（缺省 `config.hubTokenPath`）；测试注入临时 home。 */
  readonly hubTokenPath?: string
  /** join_token 落盘目录（缺省 `config.home`）；测试注入临时 home。 */
  readonly home?: string
  /** 空闲会话 TTL（缺省 `DEFAULT_SESSION_TTL_MS`）；测试注入短值验证淘汰。 */
  readonly sessionTtlMs?: number
}

interface McpSession {
  readonly server: McpServer
  readonly transport: WebStandardStreamableHTTPServerTransport
  readonly ctx: ToolContext
  /** 最近一次 `/mcp` 命中时间（路由处理时惰性清扫用的 last-seen）。 */
  lastSeen: number
}

// 生产缺省连接（同 routes/internal 模式）：首个请求时按 config 打开并复用。
let defaultDb: Db | undefined

/**
 * 会话身份提示（M2，按会话归属）：请求头 `x-agentchat-session` 非空 → 以会话节点 `task_ref`
 * （= `session.id`）解析身份。这是 OpenCode 适配器的**逐调用**通道 —— 插件 `tool.execute.before`
 * 把当前会话 id 注入工具入参，桥剥离后转请求头；一进程只有一个 MCP 连接（桥的 `x-agent-id`
 * 只能表达实例级/容器身份），故必须按会话重解析，否则所有回复都会冒名容器。
 * - `resolved`：命中会话节点 → 身份 = 会话节点 id（**忽略** `x-agent-id`）
 * - `unresolved`：带该头但查无节点 → **省略身份、绝不回落容器**（记日志、不 400）
 * - `absent`：无该头 → 既有 `x-agent-id` 行为完全不变
 */
type SessionIdentity =
  | { readonly kind: "resolved"; readonly agentId: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "absent" }

function sessionIdentity(db: Db, ref: string | undefined): SessionIdentity {
  if (ref === undefined || ref === "") return { kind: "absent" }
  const session = getAgentByTaskRef(db, ref)
  if (session === undefined) {
    console.warn(
      `[agentchat] /mcp x-agentchat-session 未解析到会话节点（task_ref=${ref}）；省略身份（不回落容器）`,
    )
    return { kind: "unresolved" }
  }
  return { kind: "resolved", agentId: session.id }
}

/**
 * initialize 的 `ToolContext`：会话头优先（命中用会话节点身份、未命中也**不回落到 `x-agent-id`**）；
 * 无会话头才走既有 `x-agent-id`（存在但查无此节点 → `agent_not_found` 400）。
 */
function initializeContext(
  c: Context,
  db: Db,
  home: string,
  hint: SessionIdentity,
): ToolContext | { readonly error: string } {
  if (hint.kind === "resolved") return { db, home, agentId: hint.agentId }
  if (hint.kind === "unresolved") return { db, home }
  const agentId = c.req.header("x-agent-id")
  if (agentId !== undefined && getAgent(db, agentId) === undefined) {
    return { error: "agent_not_found" }
  }
  return { db, home, ...(agentId === undefined ? {} : { agentId }) }
}

/** 单路由（`/mcp`）表；`db` 缺省时惰性取进程配置库（测试显式注入临时库 + home）。 */
export function mcpRoutes(db?: Db, options?: McpRoutesOptions): Hono {
  const resolveDb = (): Db => db ?? (defaultDb ??= openDb(config.dbPath))
  const home = options?.home ?? config.home
  const sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const sessions = new Map<string, McpSession>()
  let hubToken: string | undefined
  const token = (): string => {
    hubToken ??= ensureHubToken(options?.hubTokenPath ?? config.hubTokenPath)
    return hubToken
  }

  /** 惰性清扫：删除闲置超过 TTL 的会话并关闭其 transport（fire-and-forget，不阻塞请求）。 */
  const sweepSessions = (now: number): void => {
    for (const [id, session] of sessions) {
      if (now - session.lastSeen <= sessionTtlMs) continue
      sessions.delete(id)
      void session.transport.close().catch(() => undefined)
    }
  }

  return new Hono()
    .use("/mcp", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${token()}`) {
        return c.json({ ok: false, error: "unauthorized" }, 401)
      }
      await next()
    })
    .all("/mcp", async (c) => {
      const now = Date.now()
      sweepSessions(now)
      const database = resolveDb()
      const hint = sessionIdentity(database, c.req.header("x-agentchat-session"))
      const sessionId = c.req.header("mcp-session-id")
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId)
        if (session === undefined) return c.json({ ok: false, error: "session_not_found" }, 404)
        // 逐调用身份：一进程一 MCP 连接、多会话共用 → 带会话头即按会话重解析（命中设身份、
        // 未命中清身份绝不留容器）；不带会话头（notifications 等）保持既有身份不动。
        if (hint.kind === "resolved") session.ctx.agentId = hint.agentId
        else if (hint.kind === "unresolved") delete session.ctx.agentId
        session.lastSeen = now
        return session.transport.handleRequest(c.req.raw)
      }
      if (c.req.method !== "POST") return c.json({ ok: false, error: "missing_session" }, 400)
      const ctx = initializeContext(c, database, home, hint)
      if ("error" in ctx) return c.json({ ok: false, error: ctx.error }, 400)
      const server = new McpServer({ name: "agentchat-hub", version: "0.1.0" })
      registerTools(server, ctx)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id !== undefined) sessions.delete(id)
      }
      await server.connect(transport)
      const response = await transport.handleRequest(c.req.raw)
      const newSessionId = transport.sessionId
      if (newSessionId !== undefined) {
        sessions.set(newSessionId, { server, transport, ctx, lastSeen: Date.now() })
      }
      return response
    })
}
