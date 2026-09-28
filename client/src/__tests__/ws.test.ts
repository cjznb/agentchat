/**
 * 缺陷 B（UI 断线韧性）WsClient 单测：重连超限后**不再永久停止**，改为慢速后台重试；
 * `reconnectNow()` 供页面可见/网络恢复时立即重连（`stop()`/`start()` 语义不变）。
 * 全部用假定时器与假 socket（不真连）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { WS_RECONNECT_SLOW_MS, WsClient, type ConnectionStatus, type WsSocketLike } from "../ws"

class FakeSocket implements WsSocketLike {
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close(): void {}
}

interface Harness {
  readonly client: WsClient
  readonly urls: string[]
  readonly sockets: FakeSocket[]
  readonly statuses: ConnectionStatus[]
}

function harness(maxReconnectAttempts = 2): Harness {
  const urls: string[] = []
  const sockets: FakeSocket[] = []
  const statuses: ConnectionStatus[] = []
  const client = new WsClient({
    url: "/api/ws",
    socketFactory: (url) => {
      const socket = new FakeSocket()
      urls.push(url)
      sockets.push(socket)
      return socket
    },
    onFrame: () => {},
    onStatus: (status) => statuses.push(status),
    random: () => 0,
    warn: () => {},
    maxReconnectAttempts,
  })
  return { client, urls, sockets, statuses }
}

describe("WsClient 断线韧性（缺陷 B）", () => {
  afterEach(() => vi.useRealTimers())

  it("keeps reconnecting slowly after exceeding the max attempts instead of stopping", () => {
    vi.useFakeTimers()
    const { client, urls, sockets, statuses } = harness(2)
    client.start()
    sockets[0]!.onclose?.()
    vi.advanceTimersByTime(1000)
    sockets[1]!.onclose?.()
    vi.advanceTimersByTime(2000)
    sockets[2]!.onclose?.() // attempt 达上限 → 转慢速后台重试

    expect(statuses[statuses.length - 1]).toBe("retrying")
    expect(client.isStopped).toBe(false)

    vi.advanceTimersByTime(WS_RECONNECT_SLOW_MS - 1)
    expect(urls).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(urls).toHaveLength(4) // 超限后仍继续重连

    sockets[3]!.onclose?.()
    vi.advanceTimersByTime(WS_RECONNECT_SLOW_MS)
    expect(urls).toHaveLength(5)
    expect(client.isStopped).toBe(false)
    client.stop()
    expect(client.isStopped).toBe(true)
  })

  it("resets back to the fast backoff after a successful reconnect", () => {
    vi.useFakeTimers()
    const { client, urls, sockets, statuses } = harness(2)
    client.start()
    sockets[0]!.onclose?.()
    vi.advanceTimersByTime(1000)
    sockets[1]!.onclose?.()
    vi.advanceTimersByTime(2000)
    sockets[2]!.onclose?.() // 进入慢速
    vi.advanceTimersByTime(WS_RECONNECT_SLOW_MS)
    sockets[3]!.onopen?.() // 恢复成功 → attempt 复位
    expect(statuses[statuses.length - 1]).toBe("connected")

    sockets[3]!.onclose?.()
    vi.advanceTimersByTime(1000) // 回到基础退避（1s）
    expect(urls).toHaveLength(5)
    client.stop()
  })

  it("reconnectNow connects immediately and cancels the pending wait", () => {
    vi.useFakeTimers()
    const { client, urls, sockets } = harness()
    client.start()
    sockets[0]!.onclose?.() // 排定一次重连等待

    client.reconnectNow()
    expect(urls).toHaveLength(2)
    vi.advanceTimersByTime(60_000) // 已取消的旧定时器不得再触发
    expect(urls).toHaveLength(2)
    client.stop()
  })

  it("reconnectNow is a no-op while a socket is active", () => {
    const { client, urls, sockets } = harness()
    client.start()
    sockets[0]!.onopen?.()
    client.reconnectNow()
    expect(urls).toHaveLength(1)
    client.stop()
  })
})
