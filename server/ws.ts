/**
 * WebSocket 实时推送（spec §Global：`/api/ws?since=<seq>`，事件封套 `{type, seq, payload}`；Task 9）。
 *
 * 纯传输层：不 import core/store —— 发布点经 `emit` 注入，载荷由调用方（core）构造。
 * - 进程级单调 `seq`（裁定 1：与消息 seq 解耦的独立计数器）+ 内存环形缓冲（最近 `capacity` 条）
 * - `?since=<seq>`：缓冲内按序补推；早于缓冲最老或进程重启计数不匹配 → `resync` 首帧
 *   （`type` 不在锁集 `WS_EVENT_TYPES`，客户端语义 = 丢弃本地状态、整页重拉 REST）
 * - RFC6455 最小帧编解码（text/close/ping/pong），不引入 `ws` 依赖；测试用 Node 内建 `WebSocket` 客户端
 */
import { createHash } from "node:crypto"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WS_RESYNC_TYPE, type WsEvent, type WsEventType } from "../shared/contracts"

/** 环形缓冲容量（裁定 1：最近 1000 条事件）。 */
export const WS_RING_CAPACITY = 1000

let capacity = WS_RING_CAPACITY
let seq = 0
const ring: WsEvent[] = []
const clients = new Set<Client>()

interface Client {
  readonly socket: Duplex
  readonly reader: FrameReader
}

// ── 帧编解码（RFC6455 最小子集） ─────────────────────────────────

const OPCODE = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa } as const

interface ParsedFrame {
  readonly opcode: number
  readonly payload: Buffer
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** 增量帧解析器：TCP 分片到达时保留残帧，逐条吐完整帧。 */
class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): readonly ParsedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: ParsedFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  private next(): ParsedFrame | undefined {
    const buf = this.buffer
    if (buf.length < 2) return undefined
    const first = buf[0] ?? 0
    const second = buf[1] ?? 0
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < 4) return undefined
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return undefined
      length = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    let mask: Buffer | undefined
    if (masked) {
      if (buf.length < offset + 4) return undefined
      mask = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + length) return undefined
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (mask !== undefined) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
      }
    }
    this.buffer = buf.subarray(offset + length)
    return { opcode: first & 0x0f, payload }
  }
}

// ── 握手 ─────────────────────────────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** 计算 `Sec-WebSocket-Accept`（导出供单测）。 */
export function wsAcceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + WS_GUID).digest("base64")
}

/** 解析 `?since`：缺省/空 → 不补推；非法 → `+Infinity`（走 resync 分支）。 */
function parseSince(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : Number.POSITIVE_INFINITY
}

// ── hub ──────────────────────────────────────────────────────────

/** 发布一条事件：分配 seq、入环形缓冲、广播在线客户端（无订阅者也缓冲，供补推）。 */
export function emit(type: WsEventType, payload: unknown): void {
  seq += 1
  const event: WsEvent = { type, seq, payload }
  ring.push(event)
  if (ring.length > capacity) ring.splice(0, ring.length - capacity)
  for (const client of clients) sendFrame(client, event)
}

/** 当前进程事件计数（诊断/测试）。 */
export function currentWsSeq(): number {
  return seq
}

/** 清空缓冲、计数与在线连接（测试与进程重启语义；容量可注入以覆盖边界用例）。 */
export function resetWsHub(options: { readonly capacity?: number } = {}): void {
  capacity = options.capacity ?? WS_RING_CAPACITY
  seq = 0
  ring.length = 0
  for (const client of clients) client.socket.end()
  clients.clear()
}

/**
 * `?since` 出帧序列：`resync` 首帧（游标超前 / 早于缓冲最老 / 缓冲空却仍有缺口），
 * 否则为缓冲内 `seq > since` 的事件（按序、不重）。
 */
export function framesSince(since: number | undefined): readonly unknown[] {
  if (since === undefined) return []
  const oldest = ring[0]?.seq
  const gap = oldest === undefined ? since < seq : oldest > since + 1
  if (since > seq || gap) return [{ type: WS_RESYNC_TYPE, seq, payload: {} }]
  return ring.filter((event) => event.seq > since)
}

function sendFrame(client: Client, frame: unknown): void {
  try {
    client.socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(frame), "utf8")))
  } catch {
    clients.delete(client)
  }
}

function handleClientFrame(client: Client, frame: ParsedFrame): void {
  switch (frame.opcode) {
    case OPCODE.close:
      client.socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0)))
      clients.delete(client)
      return
    case OPCODE.ping:
      client.socket.write(encodeFrame(OPCODE.pong, frame.payload))
      return
    default:
      // 文本/二进制（客户端 → 服务端）本协议不使用，pong/continuation 忽略。
      return
  }
}

function handleSocket(socket: Duplex, head: Buffer, since: number | undefined): void {
  const client: Client = { socket, reader: new FrameReader() }
  clients.add(client)
  socket.on("close", () => clients.delete(client))
  socket.on("error", () => clients.delete(client))
  socket.on("data", (chunk: Buffer) => {
    for (const frame of client.reader.push(chunk)) handleClientFrame(client, frame)
  })
  if (head.length > 0) {
    for (const frame of client.reader.push(head)) handleClientFrame(client, frame)
  }
  for (const frame of framesSince(since)) sendFrame(client, frame)
}

/** 挂载 `/api/ws` 升级处理（`start()` 内调用）；非该路径的升级请求直接断开。 */
export function attachWsServer(server: Server): void {
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const key = request.headers["sec-websocket-key"]
    if (url.pathname !== "/api/ws" || typeof key !== "string") {
      socket.destroy()
      return
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`,
    )
    handleSocket(socket, head, parseSince(url.searchParams.get("since")))
  })
}
