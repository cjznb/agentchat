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
import { adapterFor, registerConfiguredAdapters } from "./adapters/types"
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
  /** 启动警告出口（缺省 `console.warn`）；测试注入收集器。 */
  readonly log?: (message: string) => void
}

/**
 * 是否存在「合格但收件方 vendor 无适配器」的到期 pending job（启动警告判定）：
 * 合格 = runtime 且 `status='online'`（busy/offline 的退避由状态自身解释，不算空转）。
 * 精确 SQL（不受派发窗口 LIMIT 影响）；逐 vendor 用 `adapterFor` 判定是否已有适配器。
 */
function hasUnadapteredPendingJob(db: Db, now: number): boolean {
  const rows = db
    .prepare<[number], { vendor: string }>(
      `SELECT DISTINCT a.vendor AS vendor
         FROM wake_jobs j JOIN agents a ON a.id = j.agent_id
        WHERE j.state = 'pending' AND j.retry_at <= ?
          AND a.kind = 'runtime' AND a.status = 'online'`,
    )
    .all(now)
  return rows.some((row) => adapterFor(row.vendor) === undefined)
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
  // 先登记可用性，再判定警告，最后拉起 dispatcher（避免首轮把 pull 目标误当无通道/推送处理）。
  registerConfiguredAdapters({ adapters })
  // 仅当「未配置任何适配器」**且**库中确实存在「收件方 vendor 无适配器」的到期待投递 job 时提示：
  // 此时 dispatcher 会对其做**有界退避重试**（每 ≤30s 一次），并非丢消息；首次收到该厂商
  // `POST /internal/wake` 后会自动识别为 pull 适配器，届时不再空转（旧文案「不会被投递」是错的）。
  if (adapters.length === 0 && hasUnadapteredPendingJob(db, Date.now())) {
    const log = options.log ?? ((message: string): void => console.warn(message))
    log(
      "[agentchat] 未配置任何适配器（adapters 为空），且库中存在收件方厂商无适配器的到期待投递消息：" +
        "dispatcher 会对这类任务做有界退避重试（每 ≤30s 一次，消息不丢）。" +
        "该厂商首次 `POST /internal/wake` 后会被自动识别为 pull 适配器，届时不再重试空转；" +
        `也可在 ${join(home, "config.json")} 的 adapters 字段或 env AGENTCHAT_ADAPTERS 中声明（重启生效）。`,
    )
  }
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
