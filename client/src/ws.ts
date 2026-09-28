/**
 * WebSocket 客户端（Plan 3 T3）——`/api/ws` 的 typed 消费者。
 *
 * - `?since=<seq>` 续传：首连不携 `since`（REST 首屏负责初始状态），断线重连携
 *   **最近已应用 seq**，由服务端补推缺口
 * - 断线指数退避重连（1s 起、30s 上限，带 jitter）
 * - 每帧经 `wsServerFrameSchema` 解析；解析失败 `warn` 并**忽略**（前向兼容，不崩）
 * - 收到 `resync` 首帧 → 通知 `onFrame`（store 清缓存并整页重拉），游标对齐到该帧 seq
 * - socket 经 `socketFactory` 注入，单测用假 socket（不真连）
 */
import {
  wsServerFrameSchema,
  type WsEvent,
  type WsServerFrame,
  type WsResync,
} from "../../shared/contracts"

/**
 * 连接状态（store 的 `connection` 字段直接复用）。
 * `retrying` = 重连次数超限后转入**慢速后台重试**（不再永久停止；UI 据此提示正在重试）。
 * `error` 保留作错误信号（当前 WsClient 不再产生终态 error，供 REST 失败等其它来源）。
 */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resync"
  | "retrying"
  | "error"

/** 浏览器 WebSocket 的最小结构（测试可注入假实现）。 */
export interface WsSocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

export const WS_RECONNECT_BASE_MS = 1_000
export const WS_RECONNECT_MAX_MS = 30_000
/** 默认最大「快速退避」重连次数：超过即转入固定慢速后台重试。 */
export const WS_RECONNECT_MAX_ATTEMPTS = 8
/** 超出快速重连上限后的慢速重试间隔（缺陷 B：永不永久停止）。 */
export const WS_RECONNECT_SLOW_MS = 30_000

/**
 * 退避时长：`base * 2^attempt` 封顶 `max`，再叠加 `[0, base)` jitter（并按 `max` 封顶）。
 * `random` 可注入以令测试确定（`() => 0` 取下界）。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * 2 ** attempt)
  const jitter = random() * WS_RECONNECT_BASE_MS
  return Math.min(WS_RECONNECT_MAX_MS, Math.round(exponential + jitter))
}

export interface WsClientOptions {
  readonly url: string
  readonly socketFactory: (url: string) => WsSocketLike
  readonly onFrame: (frame: WsServerFrame) => void
  readonly onStatus?: (status: ConnectionStatus) => void
  readonly random?: () => number
  readonly warn?: (message: string, detail?: unknown) => void
  /** 快速退避重连次数上限；达上限后转 `retrying` 慢速重连（默认 `WS_RECONNECT_MAX_ATTEMPTS`）。 */
  readonly maxReconnectAttempts?: number
}

export class WsClient {
  private socket: WsSocketLike | undefined
  private appliedSeq = 0
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private readonly random: () => number
  private readonly warn: (message: string, detail?: unknown) => void
  private readonly maxAttempts: number

  constructor(private readonly options: WsClientOptions) {
    this.random = options.random ?? Math.random
    this.warn = options.warn ?? ((message, detail) => console.warn(message, detail))
    this.maxAttempts = options.maxReconnectAttempts ?? WS_RECONNECT_MAX_ATTEMPTS
  }

  /** 最近已应用（或 resync 对齐）的事件 seq；重连时作为 `?since`。 */
  get since(): number {
    return this.appliedSeq
  }

  /** 是否已停止（`stop()` 后为 true；供测试与外部触发判断）。 */
  get isStopped(): boolean {
    return this.stopped
  }

  start(): void {
    this.stopped = false
    this.attempt = 0
    this.options.onStatus?.("connecting")
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.socket?.close()
    this.socket = undefined
  }

  /**
   * 立即重连（供页面转可见 / `window.online` 等外部触发）：已连接/正在连接则 no-op；
   * 否则清掉待触发定时器并立刻 `connect()`（退避复位）。
   */
  reconnectNow(): void {
    if (this.socket !== undefined) return
    this.stopped = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.attempt = 0
    this.options.onStatus?.("reconnecting")
    this.connect()
  }

  private connect(): void {
    const url = this.appliedSeq > 0 ? `${this.options.url}?since=${this.appliedSeq}` : this.options.url
    const socket = this.options.socketFactory(url)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.options.onStatus?.("connected")
    }
    socket.onmessage = (event) => this.handleMessage(event.data)
    socket.onclose = () => this.scheduleReconnect()
    socket.onerror = () => {
      // 浏览器在 error 后必随 close；重连统一由 onclose 驱动，避免重复调度。
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.warn("ws frame is not text", data)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.warn("ws frame is not JSON", data)
      return
    }
    const frame = wsServerFrameSchema.safeParse(parsed)
    if (!frame.success) {
      this.warn("ws frame failed contract parse", parsed)
      return
    }
    const value: WsServerFrame = frame.data
    if (value.type === "resync") {
      const resync: WsResync = value
      this.appliedSeq = resync.seq
      this.options.onStatus?.("resync")
      this.options.onFrame(resync)
      return
    }
    const event: WsEvent = value
    this.appliedSeq = event.seq
    this.options.onFrame(event)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.socket = undefined
    // 重连超限：**不再永久停止**——转固定慢速后台重试（缺陷 B），成功即复位。
    const slow = this.attempt >= this.maxAttempts
    const delay = slow ? WS_RECONNECT_SLOW_MS : backoffDelay(this.attempt, this.random)
    this.options.onStatus?.(slow ? "retrying" : "reconnecting")
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.stopped) this.connect()
    }, delay)
  }
}

/** 默认 socket 工厂：浏览器原生 WebSocket（结构兼容，隔离在此单点 cast）。 */
export function browserSocketFactory(url: string): WsSocketLike {
  return new WebSocket(url) as unknown as WsSocketLike
}

/** 同源 `/api/ws` 地址（浏览器环境）。 */
export function currentWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/api/ws`
}
