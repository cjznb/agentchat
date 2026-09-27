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
import { Hono } from "hono"
import { config } from "../config"
import { openDb, type Db } from "../db"
import { registerTools } from "../mcp/tools"
import type { ToolContext } from "../mcp/context"
import { getAgent } from "../store/agents"
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
      const sessionId = c.req.header("mcp-session-id")
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId)
        if (session === undefined) return c.json({ ok: false, error: "session_not_found" }, 404)
        session.lastSeen = now
        return session.transport.handleRequest(c.req.raw)
      }
      if (c.req.method !== "POST") return c.json({ ok: false, error: "missing_session" }, 400)
      const agentId = c.req.header("x-agent-id")
      if (agentId !== undefined && getAgent(resolveDb(), agentId) === undefined) {
        return c.json({ ok: false, error: "agent_not_found" }, 400)
      }
      const ctx: ToolContext = {
        db: resolveDb(),
        home,
        ...(agentId === undefined ? {} : { agentId }),
      }
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
