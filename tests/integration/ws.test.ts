/**
 * Task 9 —— WS 实时推送集成测试（brief DoD）：
 * - 真 WS 客户端连 `/api/ws`：四类事件各至少一推（message / receipt / agent / approval）
 * - `?since=<seq>` 补推边界：缓冲内造 5 条，断言 since 前后不丢不重；断线重连游标语义
 * - resync：游标超前进程计数（重启不匹配）/ 早于环形缓冲最老
 * Node 内建 `WebSocket` 客户端；每个用例独立临时 $AGENTCHAT_HOME，真实监听 `start({port:0})`。
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { wsApprovalPayloadSchema, wsResyncSchema, wsServerFrameSchema } from "../../shared/contracts"
import { loadConfig } from "../../server/config"
import { registerRoot, retire } from "../../server/core/agents"
import { ack, ensureHuman, sendMessage, shout } from "../../server/core/messaging"
import { ask, respondAsk } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { applyAgentState } from "../../server/routes/internal"
import { insertAgent } from "../../server/store/agents"
import { listApprovals } from "../../server/store/approvals"
import { activeWsClients, currentWsSeq, MAX_CLIENT_FRAME_BYTES, resetWsHub } from "../../server/ws"

let home = ""
let db: Db
let running: RunningServer

beforeEach(async () => {
  resetWsHub()
  home = mkdtempSync(join(tmpdir(), "agentchat-ws-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
})

afterEach(async () => {
  await running.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 帧流：构造时即挂监听（避免 open 后才挂导致首批补推帧竞态丢失）。 */
interface FrameStream {
  readonly frames: unknown[]
  next(count: number, timeoutMs?: number): Promise<unknown[]>
}

interface ConnectedWs {
  readonly socket: WebSocket
  readonly stream: FrameStream
}

function frameStream(socket: WebSocket): FrameStream {
  const frames: unknown[] = []
  const waiters: { count: number; resolve: (value: unknown[]) => void; timer: NodeJS.Timeout }[] = []
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)))
    for (const waiter of [...waiters]) {
      if (frames.length < waiter.count) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve([...frames])
    }
  })
  return {
    frames,
    next(count, timeoutMs = 3000) {
      if (frames.length >= count) return Promise.resolve([...frames])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout: wanted ${count} frames, got ${frames.length}`)),
          timeoutMs,
        )
        waiters.push({ count, resolve, timer })
      })
    },
  }
}

function wsUrl(base: string, since?: number): string {
  const wsBase = base.replace(/^http/, "ws")
  return since === undefined ? `${wsBase}/api/ws` : `${wsBase}/api/ws?since=${since}`
}

function connectWs(url: string): Promise<ConnectedWs> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const stream = frameStream(socket)
    socket.addEventListener("open", () => resolve({ socket, stream }), { once: true })
    socket.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)), {
      once: true,
    })
  })
}

function closeWs(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true })
    socket.close()
  })
}

function typeOf(frame: unknown): string {
  return (frame as { type: string }).type
}

function seqOf(frame: unknown): number {
  return (frame as { seq: number }).seq
}

/** 帧 payload（`approval` 事件的判别断言用）。 */
function payloadOf(frame: unknown): unknown {
  return (frame as { payload: unknown }).payload
}

/** 生成 `count` 条 message 事件（human → 逻辑节点 DM）。 */
function produceMessages(count: number): { humanId: string; peerId: string } {
  const human = ensureHuman(db)
  const peer = insertAgent(db, { name: `peer-${count}`, kind: "logical", vendor: "test", status: "offline" })
  for (let i = 0; i < count; i += 1) {
    sendMessage(db, { from: human.id, to: peer.id, body: `m${i}` })
  }
  return { humanId: human.id, peerId: peer.id }
}

describe("/api/ws 四类事件", () => {
  it("pushes message/receipt/agent/approval events and every frame matches the contract", async () => {
    const { socket, stream } = await connectWs(wsUrl(running.url))

    const human = ensureHuman(db)
    const root = registerRoot(db, home, { name: "ws-root", vendor: "opencode" }).agent
    const sent = sendMessage(db, { from: human.id, to: root.id, body: "hello" })
    ack(db, root.id, [sent.message.id])
    shout(db, root.id, "全员注意") // root 持 hub 身份 → pending 审批单（approval 事件）

    const received = await stream.next(5)
    for (const frame of received) {
      expect(wsServerFrameSchema.safeParse(frame).success).toBe(true)
    }
    expect(new Set(received.map(typeOf))).toEqual(
      new Set(["message", "receipt", "agent", "approval"]),
    )
    // Task 4：`approval` payload 带 kind 判别（shout 审批 → 'action'）。
    const approvalFrame = received.find((frame) => typeOf(frame) === "approval")
    if (approvalFrame === undefined) throw new Error("expected an approval frame")
    expect(wsApprovalPayloadSchema.parse(payloadOf(approvalFrame)).kind).toBe("action")
    await closeWs(socket)
  })

  it("tags ask approval events with kind 'ask' and re-emits them on respond", async () => {
    const human = ensureHuman(db)
    const root = registerRoot(db, home, { name: "ws-ask-root", vendor: "opencode" }).agent
    const { socket, stream } = await connectWs(wsUrl(running.url))

    // 建卡（message）+ pending approval（kind='ask'）。
    ask(db, root.id, { to: "human", question: "走不走", options: ["走", "不走"] })
    const pendingFrames = await stream.next(2)
    const pendingApproval = pendingFrames.find((frame) => typeOf(frame) === "approval")
    if (pendingApproval === undefined) throw new Error("expected a pending approval frame")
    expect(wsApprovalPayloadSchema.parse(payloadOf(pendingApproval)).kind).toBe("ask")

    // 答复（message）+ answered approval（kind='ask'）。
    const stored = listApprovals(db, "pending").find((approval) => approval.kind === "ask")
    if (stored === undefined) throw new Error("expected a pending ask")
    respondAsk(db, stored.id, human.id, { choice: "走" })
    const after = await stream.next(4)
    const approvals = after.filter((frame) => typeOf(frame) === "approval")
    const answered = approvals[approvals.length - 1]
    if (answered === undefined) throw new Error("expected an answered approval frame")
    const parsed = wsApprovalPayloadSchema.parse(payloadOf(answered))
    expect(parsed.kind).toBe("ask")
    expect(parsed.approval.status).toBe("answered")
    await closeWs(socket)
  })

  it("emits agent events on /internal/state status change and on retire", async () => {
    const root = registerRoot(db, home, { name: "ws-state", vendor: "opencode" }).agent
    const { socket, stream } = await connectWs(wsUrl(running.url))

    const outcome = applyAgentState(db, { agentId: root.id, state: "busy" })
    expect(outcome.ok).toBe(true)
    const statusFrame = await stream.next(1)
    expect(typeOf(statusFrame[0])).toBe("agent")

    retire(db, root.id)
    const retireFrame = await stream.next(2)
    expect(typeOf(retireFrame[1])).toBe("agent")
    await closeWs(socket)
  })
})

describe("/api/ws ?since 补推与重连", () => {
  it("replays exactly the buffered events after ?since and never duplicates on reconnect", async () => {
    produceMessages(5)
    expect(currentWsSeq()).toBe(5)

    // since=2 → 只补 seq 3,4,5（边界不丢、不重）
    const first = await connectWs(wsUrl(running.url, 2))
    const replay = await first.stream.next(3)
    expect(replay.map(seqOf)).toEqual([3, 4, 5])
    expect(replay.map(typeOf)).toEqual(["message", "message", "message"])
    expect(first.stream.frames).toHaveLength(3)
    await closeWs(first.socket)

    // 断线重连：游标停在 5 → 无补推；之后的新事件 seq 6 恰好收到 1 条
    const second = await connectWs(wsUrl(running.url, 5))
    produceMessages(1) // 新增一条 message 事件（seq 6）
    const live = await second.stream.next(1)
    expect(live.map(seqOf)).toEqual([6])
    expect(second.stream.frames).toHaveLength(1)
    await closeWs(second.socket)
  })

  it("sends a resync first frame when ?since is ahead of the process counter", async () => {
    const { socket, stream } = await connectWs(wsUrl(running.url, currentWsSeq() + 50))
    const frames = await stream.next(1)
    expect(wsResyncSchema.safeParse(frames[0]).success).toBe(true)
    expect(frames[0]).toMatchObject({ type: "resync", payload: {} })
    await closeWs(socket)
  })

  it("sends resync when ?since predates the oldest buffered event", async () => {
    resetWsHub({ capacity: 2 })
    produceMessages(3) // 缓冲仅保留 seq 2,3
    expect(currentWsSeq()).toBe(3)

    const { socket, stream } = await connectWs(wsUrl(running.url, 0))
    const frames = await stream.next(1)
    expect(wsResyncSchema.safeParse(frames[0]).success).toBe(true)
    await closeWs(socket)
  })
})

// ── 裸 socket 握手（Node WebSocket 客户端不会构造非法帧，故手写握手发原始帧） ──

function readUntil(socket: Socket, delimiter: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const text = buffer.toString("latin1")
      if (text.includes(delimiter)) {
        clearTimeout(timer)
        socket.off("data", onData)
        resolve(text)
      }
    }
    const timer = setTimeout(() => {
      socket.off("data", onData)
      reject(new Error("timeout waiting for handshake response"))
    }, timeoutMs)
    socket.on("data", onData)
  })
}

async function rawUpgrade(url: string): Promise<Socket> {
  const target = new URL(url)
  const socket = connect(Number(target.port), target.hostname)
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  socket.write(
    `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  )
  const response = await readUntil(socket, "\r\n\r\n")
  expect(response).toContain("101")
  return socket
}

/** 读取服务端首个 close 帧的 close code（服务端帧不带掩码，code 在 payload 前 2 字节）。 */
function nextCloseCode(socket: Socket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= 4) {
        clearTimeout(timer)
        socket.off("data", onData)
        resolve(buffer.readUInt16BE(2))
      }
    }
    const timer = setTimeout(() => {
      socket.off("data", onData)
      reject(new Error("timeout waiting for close frame"))
    }, timeoutMs)
    socket.on("data", onData)
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("/api/ws 帧上限与掩码强制（DoS 加固）", () => {
  it("closes with 1009 and recycles the client when a frame declares an oversized length", async () => {
    const socket = await rawUpgrade(wsUrl(running.url))
    await waitFor(() => activeWsClients() === 1)

    // FIN+text, MASK, 64-bit length = 上限 + 1；仅发头部（不含 4 字节掩码键之外的载荷）。
    const header = Buffer.alloc(14)
    header[0] = 0x82
    header[1] = 0x80 | 0x7f
    header.writeBigUInt64BE(BigInt(MAX_CLIENT_FRAME_BYTES + 1), 2)
    socket.write(header)

    expect(await nextCloseCode(socket)).toBe(1009)
    await waitFor(() => activeWsClients() === 0)
    socket.destroy()
  })

  it("closes with 1002 and recycles the client when a client frame is not masked", async () => {
    const socket = await rawUpgrade(wsUrl(running.url))
    await waitFor(() => activeWsClients() === 1)

    socket.write(Buffer.from([0x81, 0x01, 0x41])) // 未掩码文本帧：「A」

    expect(await nextCloseCode(socket)).toBe(1002)
    await waitFor(() => activeWsClients() === 0)
    socket.destroy()
  })
})
