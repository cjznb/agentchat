/**
 * Hub 组装与启动入口。
 *
 * - `createApp()`：返回带路由的 Hono 应用，测试可直接 `app.request(...)` 复用
 * - `start()`：真实监听（默认 `config.port`，测试传 `port: 0` 由 OS 分配），
 *   返回可关闭的运行句柄
 */
import type { ServerType } from "@hono/node-server"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { existsSync, readFileSync } from "node:fs"
import { Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "hono"
import { Hono } from "hono"
import { registerConfiguredAdapters } from "./adapters/types"
import { config } from "./config"
import type { Db } from "./db"
import { adminRoutes } from "./routes/admin"
import { internalRoutes, type InternalRoutesOptions } from "./routes/internal"
import { mcpRoutes } from "./routes/mcp"
import { notificationRoutes } from "./routes/notifications"
import { uiRoutes } from "./routes/ui"
import { attachWsServer } from "./ws"

/** 组装选项：internal 的 token 路径 + MCP 的 join_token 落盘 home / 会话 TTL（测试注入）。 */
export interface AppOptions extends InternalRoutesOptions {
  readonly home?: string
  readonly sessionTtlMs?: number
  readonly distDir?: string
  /** 已配置厂商（缺省 `config.adapters`）；启动时注册 pull 占位适配器。 */
  readonly adapters?: readonly string[]
  /** 管理端点回环判定（缺省读 socket；测试注入）。 */
  readonly isLoopback?: (c: Context) => boolean
  /** 管理端点时钟（缺省 `Date.now`；测试固定快照目录名）。 */
  readonly adminNow?: () => number
}

export function createApp(db?: Db, options?: AppOptions): Hono {
  registerConfiguredAdapters({ adapters: options?.adapters ?? config.adapters })
  const app = new Hono()
  const distDir = options?.distDir ?? fileURLToPath(new URL("../client/dist", import.meta.url))
  const indexPath = join(distDir, "index.html")
  const hasClient = existsSync(indexPath)
  if (hasClient) app.use("*", serveStatic({ root: distDir }))
  app.get("/api/health", (c) => c.json({ status: "ok" }))
  app.route("/", uiRoutes(db))
  app.route("/", notificationRoutes(db))
  app.route("/", internalRoutes(db, options))
  app.route("/", mcpRoutes(db, options))
  app.route(
    "/",
    adminRoutes(db, {
      ...(options?.home === undefined ? {} : { home: options.home }),
      ...(options?.adminNow === undefined ? {} : { now: options.adminNow }),
      ...(options?.isLoopback === undefined ? {} : { isLoopback: options.isLoopback }),
    }),
  )
  app.notFound((c) => {
    const protectedPath = ["/api", "/mcp", "/internal"].some((prefix) => c.req.path.startsWith(prefix))
    if (protectedPath || c.req.path.startsWith("/assets/")) return c.text("Not Found", 404)
    if (!hasClient) return c.text("AgentChat client is unavailable; run npm run build first.", 503)
    return c.html(readFileSync(indexPath, "utf8"))
  })
  return app
}

export interface RunningServer {
  /** 实际监听的基础地址（含真实端口，port 0 时为 OS 分配值） */
  readonly url: string
  close(): Promise<void>
}

export interface StartOptions {
  /** 监听端口；缺省取 `config.port`（env `AGENTCHAT_PORT`）。传 0 = OS 分配临时端口 */
  readonly port?: number
  /** UI 路由的数据库连接；缺省时按 `config.dbPath` 惰性打开（首个 roster 请求） */
  readonly db?: Db
  /** `hub_token` 路径（缺省 `config.hubTokenPath`）；测试注入临时 home。 */
  readonly hubTokenPath?: string
  /** join_token 落盘目录（缺省 `config.home`）；测试注入临时 home。 */
  readonly home?: string
  /** 空闲 MCP 会话 TTL（缺省 `DEFAULT_SESSION_TTL_MS`）；测试注入短值。 */
  readonly sessionTtlMs?: number
  /** 已配置厂商（缺省 `config.adapters`）；启动时注册 pull 占位适配器。 */
  readonly adapters?: readonly string[]
}

export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? config.port
  const server: ServerType = serve({
    fetch: createApp(options.db, {
      ...(options.hubTokenPath === undefined ? {} : { hubTokenPath: options.hubTokenPath }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
      ...(options.adapters === undefined ? {} : { adapters: options.adapters }),
    }).fetch,
    port,
  })
  // `/api/ws` 升级（Node 默认 HTTP 服务器实例；HTTP/2 分支不挂载，本项目用 HTTP/1.1）。
  if (server instanceof HttpServer) attachWsServer(server)

  const info = await new Promise<AddressInfo>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        // HTTP 监听（非 unix socket）在 listening 后必然返回 AddressInfo
        reject(new Error(`expected AddressInfo after listening, got ${String(address)}`))
        return
      }
      resolve(address)
    })
    server.once("error", reject)
  })

  return {
    url: `http://127.0.0.1:${info.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 强制关闭 keep-alive 与已升级（WebSocket）连接：Node 的 `server.close` 会为它们
        // 一直挂起（浏览器池化连接 / 在线 WS 客户端），令关停永不完成（Node ≥18.2 提供）。
        if (server instanceof HttpServer) server.closeAllConnections()
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      }),
  }
}
