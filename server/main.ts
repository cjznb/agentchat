/**
 * 生产启动入口（C1 闭环）：真实运行必须同时拉起 HTTP 服务与 2s 唤醒 dispatcher，
 * 否则审批 24h `sweepExpired`、每日备份、唤醒循环在生产中永不发生。
 *
 * - `bootstrap(options)`：可测组装 —— 打开/复用 DB → `new Dispatcher(...).start()` →
 *   `start(...)` 监听 → 返回含 `url` / `dispatcher` 的句柄与幂等 `close()`。
 *   dispatcher **不**放进 `createApp()`/`start()`（测试反复调用会把 interval 与
 *   备份打进临时库）；本入口负责生命周期归属与优雅关停。
 * - 直接执行（`npm start` = `tsx server/main.ts`）时挂 SIGINT/SIGTERM：先停 dispatcher、
 *   再 close server、最后关 DB；测试 import 本模块不带副作用的信号处理。
 */
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { registerConfiguredAdapters } from "./adapters/types"
import { config } from "./config"
import { Dispatcher } from "./core/dispatcher"
import { openDb, type Db } from "./db"
import { start } from "./index"

export interface BootstrapOptions {
  /** 监听端口；缺省 `config.port`（env `AGENTCHAT_PORT`）。传 0 = OS 分配临时端口。 */
  readonly port?: number
  /** 数据目录（缺省 `config.home`）；DB/token 缺省落在其下。 */
  readonly home?: string
  /** 复用既有连接（测试注入）；缺省按 `join(home, "agentchat.db")` 打开并归本句柄所有。 */
  readonly db?: Db
  /** `hub_token` 路径（缺省 `join(home, "hub_token")`）。 */
  readonly hubTokenPath?: string
  /** 空闲 MCP 会话 TTL（缺省 `DEFAULT_SESSION_TTL_MS`）；测试注入短值。 */
  readonly sessionTtlMs?: number
  /** 已配置厂商（缺省 `config.adapters`）；启动时注册 pull 占位适配器。 */
  readonly adapters?: readonly string[]
  /** `false` = 不启动 dispatcher（仅 HTTP；测试/诊断）。缺省 true。 */
  readonly startDispatcher?: boolean
  /** dispatcher 单轮异常回调（缺省 `console.error`）。 */
  readonly onDispatcherError?: (error: unknown) => void
}

export interface HubHandle {
  /** 实际监听的基础地址（含真实端口）。 */
  readonly url: string
  /** 本入口拉起的 dispatcher；`startDispatcher:false` 时为 undefined。 */
  readonly dispatcher: Dispatcher | undefined
  /** 优雅关停：停 dispatcher → close server →（若 DB 归本句柄）close DB；可重复调用。 */
  close(): Promise<void>
}

/** 组装并启动 Hub（HTTP + dispatcher）；见文件头。 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<HubHandle> {
  const home = options.home ?? config.home
  const hubTokenPath = options.hubTokenPath ?? join(home, "hub_token")
  const ownsDb = options.db === undefined
  const db = options.db ?? openDb(join(home, "agentchat.db"))
  const adapters = options.adapters ?? config.adapters
  // 先登记可用性，再拉起 dispatcher（避免首轮把 pull 目标误当无通道/推送处理）。
  registerConfiguredAdapters({ adapters })
  const dispatcher =
    options.startDispatcher === false
      ? undefined
      : new Dispatcher({
          db,
          home,
          ...(options.onDispatcherError === undefined
            ? {}
            : { onError: options.onDispatcherError }),
        })
  dispatcher?.start()
  const server = await start({
    port: options.port ?? config.port,
    db,
    home,
    hubTokenPath,
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
    adapters,
  })
  let closed = false
  return {
    url: server.url,
    dispatcher,
    close: async () => {
      if (closed) return
      closed = true
      dispatcher?.stop()
      await server.close()
      if (ownsDb) db.close()
    },
  }
}

/** 前台运行：启动后挂 SIGINT/SIGTERM 优雅关停（仅直接执行路径）。 */
async function runForeground(): Promise<void> {
  const handle = await bootstrap()
  console.error(`[agentchat] hub listening on ${handle.url} (dispatcher started)`)
  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[agentchat] ${signal} received, shutting down`)
    handle
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("[agentchat] shutdown failed", error)
        process.exit(1)
      })
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

// 仅当被直接执行（`npm start`）时前台运行；被测试 import 时零副作用。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runForeground()
}
