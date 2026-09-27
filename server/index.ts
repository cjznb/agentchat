/**
 * Hub 组装与启动入口。
 *
 * - `createApp()`：返回带路由的 Hono 应用，测试可直接 `app.request(...)` 复用
 * - `start()`：真实监听（默认 `config.port`，测试传 `port: 0` 由 OS 分配），
 *   返回可关闭的运行句柄
 */
import type { ServerType } from "@hono/node-server"
import { serve } from "@hono/node-server"
import type { AddressInfo } from "node:net"
import { Hono } from "hono"
import { config } from "./config"
import type { Db } from "./db"
import { internalRoutes, type InternalRoutesOptions } from "./routes/internal"
import { mcpRoutes } from "./routes/mcp"
import { uiRoutes } from "./routes/ui"

/** 组装选项：internal 的 token 路径 + MCP 的 join_token 落盘 home / 会话 TTL（测试注入）。 */
export interface AppOptions extends InternalRoutesOptions {
  readonly home?: string
  readonly sessionTtlMs?: number
}

export function createApp(db?: Db, options?: AppOptions): Hono {
  const app = new Hono()
  app.get("/api/health", (c) => c.json({ status: "ok" }))
  app.route("/", uiRoutes(db))
  app.route("/", internalRoutes(db, options))
  app.route("/", mcpRoutes(db, options))
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
}

export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? config.port
  const server: ServerType = serve({
    fetch: createApp(options.db, {
      ...(options.hubTokenPath === undefined ? {} : { hubTokenPath: options.hubTokenPath }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
    }).fetch,
    port,
  })

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
