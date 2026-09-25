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

export function createApp(): Hono {
  const app = new Hono()
  app.get("/api/health", (c) => c.json({ status: "ok" }))
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
}

export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? config.port
  const server: ServerType = serve({ fetch: createApp().fetch, port })

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
