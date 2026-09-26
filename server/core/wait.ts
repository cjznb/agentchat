/**
 * 阻塞等待（版本号条件等待，spec §6.2/§7）—— `received` / `message` / `either` 三模式。
 *
 * 移植自 ThreadGram（MIT, Davide Pizzo）`threadgram/notifications.py`（49 行
 * version-counter + asyncio.Condition 模式），源码见
 * `.slim/clonedeps/repos/MethosPi__ThreadGram/`。Node 适配：
 * - 每 `(conversationId, waiterAgentId)` 单调版本号（`versions`）
 * - `Condition.notify_all` → 按键精确唤醒的 listener 注册表（`publish` 同步 bump + notify，
 *   无 await，与 better-sqlite3 同步复查无竞态窗口）
 * - `condition.wait_for(has_update)` → 版本变更 Promise + 超时计时器
 * - 醒后 SQL 复查（`checkMessages`/`checkReceipts` 同步闭包）：查询→释放→await→唤醒后再查，
 *   **挂起期间不持有任何 DB 查询**（决议 4）
 *
 * 匹配规则（决议 2）：`message` 事件 = 同 conversation `seq > baseline AND from != waiter`
 * （会话复查在本文件，inbox 全域复查由 messaging 以闭包注入）；`received` 事件 = 等待期间
 * 针对该 waiter 的回执变化（ack 发布）。`either` 先到先解锁。两通道数据一律带回
 * （决议「已收部分非空手」），`until` 只决定解锁门槛。
 */
import type { WaitUntil } from "../../shared/contracts"
import type { Db } from "../db"
import { messagesAfter, type Message } from "../store/messages"

/** 缺省超时（spec §6.2/§14：285s < 传输层空闲超时）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 285000

/** 缺省模式（spec §6.2：先到先解锁）。 */
export const DEFAULT_WAIT_UNTIL: WaitUntil = "either"

/** inbox 全域等待使用的 conversation 通配键（publish 对真实会话与该键同时 bump）。 */
export const INBOX_WAIT_CONVERSATION = ""

export interface WaitOptions {
  readonly until?: WaitUntil
  readonly timeoutMs?: number
}

export interface WaitResult<R> {
  readonly timedOut: boolean
  readonly messages: readonly Message[]
  readonly receipts: readonly R[]
}

export interface WaitSetup<R> {
  /** 等待键的 conversation 部分；`INBOX_WAIT_CONVERSATION` = 全域（inbox）。 */
  readonly conversationId: string
  readonly waiterId: string
  /** 消息复查（同步 SQL，返回等待期间新到项）。 */
  readonly checkMessages: () => readonly Message[]
  /** 回执复查（同步 SQL，返回等待期间变化项）。 */
  readonly checkReceipts: () => readonly R[]
}

type Channel = "message" | "receipt"

/** 单调版本号：conversation → waiter → version（决议 1：每 (conversationId, waiterAgentId) 一份）。 */
const versions = new Map<string, Map<string, number>>()

/** 监听注册表：conversation → waiter → {channel, wake}（publish 只唤醒频道匹配的监听者）。 */
const listeners = new Map<string, Map<string, Set<{ channel: Channel; wake: () => void }>>>()

function versionOf(conversationId: string, waiterId: string): number {
  return versions.get(conversationId)?.get(waiterId) ?? 0
}

function ensureKey(conversationId: string, waiterId: string): number {
  let waiters = versions.get(conversationId)
  if (waiters === undefined) {
    waiters = new Map<string, number>()
    versions.set(conversationId, waiters)
  }
  const current = waiters.get(waiterId) ?? 0
  waiters.set(waiterId, current)
  return current
}

/**
 * 事件发布（决议 5 的唯一机制，两个发布点在 messaging）：bump 匹配
 * `conversationId` 与 inbox 通配键的版本，同步唤醒对应频道的监听者。
 */
export function publish(conversationId: string, channel: Channel): void {
  const scopes =
    conversationId === INBOX_WAIT_CONVERSATION
      ? [INBOX_WAIT_CONVERSATION]
      : [conversationId, INBOX_WAIT_CONVERSATION]
  for (const scope of scopes) {
    const waiters = versions.get(scope)
    if (waiters !== undefined) {
      for (const [waiterId, version] of waiters) waiters.set(waiterId, version + 1)
    }
    const byWaiter = listeners.get(scope)
    if (byWaiter === undefined) continue
    for (const entries of byWaiter.values()) {
      for (const entry of [...entries]) {
        if (entry.channel === channel) entry.wake()
      }
    }
  }
}

interface VersionChangeRequest {
  readonly conversationId: string
  readonly waiterId: string
  readonly channels: readonly Channel[]
  /** 等待开始时的版本快照。 */
  readonly since: number
  readonly timeoutMs: number
}

/** 等到版本号超过 `since`（true）或超时（false）；注册与版本复查同步完成，无竞态窗口。 */
function versionChange(request: VersionChangeRequest): Promise<boolean> {
  const { conversationId, waiterId, channels, since, timeoutMs } = request
  return new Promise<boolean>((resolve) => {
    let settled = false
    const wake = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const byWaiter = listeners.get(conversationId)
      const entries = byWaiter?.get(waiterId)
      if (entries !== undefined) {
        for (const entry of [...entries]) if (entry.wake === wake) entries.delete(entry)
        if (entries.size === 0) byWaiter?.delete(waiterId)
      }
      resolve(true)
    }
    const timer = setTimeout(wake, timeoutMs)
    let byWaiter = listeners.get(conversationId)
    if (byWaiter === undefined) {
      byWaiter = new Map<string, Set<{ channel: Channel; wake: () => void }>>()
      listeners.set(conversationId, byWaiter)
    }
    let entries = byWaiter.get(waiterId)
    if (entries === undefined) {
      entries = new Set<{ channel: Channel; wake: () => void }>()
      byWaiter.set(waiterId, entries)
    }
    for (const channel of channels) entries.add({ channel, wake })
    // 注册后复查：bump 发生在快照与注册之间时立即唤醒（决议 1 竞态闭合）。
    if (versionOf(conversationId, waiterId) > since) wake()
  })
}

function channelsFor(until: WaitUntil): readonly Channel[] {
  switch (until) {
    case "received":
      return ["receipt"]
    case "message":
      return ["message"]
    case "either":
      return ["message", "receipt"]
  }
}

/**
 * 阻塞等待主循环（决议 2/4）：快照版本号 → 同步 SQL 复查 → 满足即返回 →
 * await 版本变更或截止 → 循环；到期做最后一次复查后返回
 * `{timedOut:true, messages, receipts}`（已收部分一并带回）。
 */
export async function waitFor<R>(setup: WaitSetup<R>, options: WaitOptions = {}): Promise<WaitResult<R>> {
  const until = options.until ?? DEFAULT_WAIT_UNTIL
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const channels = channelsFor(until)
  for (;;) {
    const since = ensureKey(setup.conversationId, setup.waiterId)
    const messages = setup.checkMessages()
    const receipts = setup.checkReceipts()
    const gotMessage = until !== "received" && messages.length > 0
    const gotReceipt = until !== "message" && receipts.length > 0
    if (gotMessage || gotReceipt) return { timedOut: false, messages, receipts }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { timedOut: true, messages, receipts }
    await versionChange({
      conversationId: setup.conversationId,
      waiterId: setup.waiterId,
      channels,
      since,
      timeoutMs: remaining,
    })
  }
}

export interface MessagesSinceQuery {
  readonly conversationId: string
  readonly waiterId: string
  /** 游标（seq，不含）：send 路径 = 已发消息 seq。 */
  readonly afterSeq: number
}

/** 会话内消息复查（brief Key facts：`seq > 已发seq AND from != waiter`）。 */
export function messagesSince(db: Db, query: MessagesSinceQuery): Message[] {
  return messagesAfter(db, query.conversationId, query.afterSeq).filter(
    (m) => m.fromAgentId !== query.waiterId,
  )
}
