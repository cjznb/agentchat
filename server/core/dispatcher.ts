/**
 * 唤醒 dispatcher（spec §7；移植 bridge `wake-dispatcher.ts` 2s 循环 + 每轮 housekeeping，
 * MIT, WebisityStudio，见 `.slim/clonedeps/repos/WebisityStudio__claude-codex-mcp-bridge/`）。
 *
 * - 周期 `DISPATCHER_INTERVAL_MS = 2000`；`tick(now)` 可注入时钟，测试不 sleep
 * - 每轮：`backupIfDue`（spec §12 每日单文件备份）→ busy 24h 过期 → 在途超时回收 →
 *   到期 job 分流（busy/offline/无适配器 → 退避重投；online → 原子认领 → `adapter.inject`
 *   → 结果落库）→ 失败通知扫描（30min 同对合并）
 * - 与适配器解耦：经进程内 `VendorAdapter` 注册表按收件方 `vendor` 取适配器，
 *   单测注入 fake（Constraints）
 * - 状态推进处由本层发布回执事件（T5 交接的第三发布点）；
 *   退役取消与失败通知的业务（含 system 消息落库）因 250 纯行上限从 `store/wake` 收拢于此
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { adapterFor } from "../adapters/types"
import type { Db } from "../db"
import { getAgent } from "../store/agents"
import { getBySeq, send } from "../store/messages"
import {
  applyDeliveryResult,
  backoffMs,
  BUSY_TTL_MS,
  claimFailedNotice,
  claimWakeJob,
  dueWakeJobs,
  NOTICE_WINDOW_MS,
  REFUSAL_LIMIT,
  type DeliveryResult,
  type PendingReason,
  type WakeJob,
} from "../store/wake"
import { sweepExpired } from "./permissions"
import { publishMessage, publishReceipt } from "./publish"

/** dispatcher 周期（计划 Global Constraints 锁定值：2000 ms）。 */
export const DISPATCHER_INTERVAL_MS = 2000
/** 单轮处理上限（认领与失败通知各受此上限约束，防长轮次）。 */
export const MAX_JOBS_PER_TICK = 20

const BACKUP_DIR = "backups"
const BACKUP_NAME = /^agentchat-daily-\d{4}-\d{2}-\d{2}\.db$/
/** 每日备份滚动保留份数（bridge `DAILY_BACKUPS_KEPT` 同值）。 */
export const BACKUP_KEEP = 7
/** 备份周期按 24h 间隔判定，留 60s 容差（bridge claimInterval 模式）。 */
const BACKUP_INTERVAL_MS = 86_400_000 - 60_000

/**
 * 每日单文件备份（spec §12 housekeeping）：`VACUUM INTO` 单文件 SQLite，
 * 路径 `$AGENTCHAT_HOME/backups/agentchat-daily-YYYY-MM-DD.db`，滚动保留 7 份。
 * 时钟注入（`now`）；24h 内已有备份则跳过。返回本次落盘路径（未到期 `undefined`）。
 */
export function backupIfDue(db: Db, home: string, now: number): string | undefined {
  const dir = join(home, BACKUP_DIR)
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).filter((name) => BACKUP_NAME.test(name))
  const newest = existing.sort().at(-1)
  if (newest !== undefined && now - statSync(join(dir, newest)).mtimeMs < BACKUP_INTERVAL_MS) {
    return undefined
  }
  const name = `agentchat-daily-${new Date(now).toISOString().slice(0, 10)}.db`
  const path = join(dir, name)
  rmSync(path, { force: true }) // VACUUM INTO 拒绝覆盖已存在文件
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  const all = readdirSync(dir).filter((entry) => BACKUP_NAME.test(entry)).sort()
  for (const stale of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    if (stale !== basename(path)) rmSync(join(dir, stale), { force: true })
  }
  return path
}

/** 消息 seq 集合 → 会话 id 集合（去重；批量发布用）。 */
function conversationIdsOf(db: Db, messageSeqs: readonly number[]): string[] {
  const conversations = new Set<string>()
  for (const seq of messageSeqs) {
    const message = getBySeq(db, seq)
    if (message !== undefined) conversations.add(message.conversationId)
  }
  return [...conversations]
}

/** `busy` 24h 过期（`offline` 不过期——SQL 只匹配 `pending_reason='busy'`）。 */
function expireBusyJobs(db: Db, now: number): string[] {
  const cutoff = now - BUSY_TTL_MS
  const rows = db
    .prepare<[number], { message_id: number }>(
      "SELECT message_id FROM wake_jobs WHERE state = 'pending' AND pending_reason = 'busy' AND created_at < ?",
    )
    .all(cutoff)
  if (rows.length === 0) return []
  db.prepare<[number], void>(
    `UPDATE wake_jobs SET state = 'expired',
            detail = 'Recipient stayed busy for the whole 24h retry window'
      WHERE state = 'pending' AND pending_reason = 'busy' AND created_at < ?`,
  ).run(cutoff)
  return conversationIdsOf(
    db,
    rows.map((row) => row.message_id),
  )
}

/** 在途超时回收：`sending` 且过时限 → 回 `pending` 等待重投（发送方回执退回 queued）。 */
function rependStuckSending(db: Db, now: number): string[] {
  const rows = db
    .prepare<[number], { message_id: number }>(
      "SELECT message_id FROM wake_jobs WHERE state = 'sending' AND retry_at <= ?",
    )
    .all(now)
  if (rows.length === 0) return []
  db.prepare<[number], void>(
    "UPDATE wake_jobs SET state = 'pending' WHERE state = 'sending' AND retry_at <= ?",
  ).run(now)
  return conversationIdsOf(
    db,
    rows.map((row) => row.message_id),
  )
}

/**
 * 退避重投：收件方 busy/offline 或暂无适配器时保持 `pending`，
 * `attempts+1` 且 `retry_at = now + backoff(attempts)`（条件更新防并发双写）。
 */
function deferWakeJob(
  db: Db,
  input: { readonly id: number; readonly now: number; readonly reason: PendingReason | null },
): void {
  const row = db
    .prepare<[number], { attempts: number }>(
      "SELECT attempts FROM wake_jobs WHERE id = ? AND state = 'pending'",
    )
    .get(input.id)
  if (row === undefined) return
  const attempts = row.attempts + 1
  db.prepare<[number, number, string | null, number], void>(
    "UPDATE wake_jobs SET attempts = ?, retry_at = ?, pending_reason = ? WHERE id = ? AND state = 'pending'",
  ).run(attempts, input.now + backoffMs(attempts), input.reason, input.id)
}

/**
 * 退役取消（spec §7「子已退役 → cancelled + 系统消息」）：
 * 未投递 job（pending/sending）全 → `cancelled`，并给各发送方在原会话落
 * `kind='system'` 消息「对方已离场」（幂等键按 (sender, 对方, 会话) 去重）。
 * 返回受影响会话 id（调用方发布消息+回执事件）。
 */
export function retireWakeJobs(db: Db, agentId: string): string[] {
  const rows = db
    .prepare<[string], { message_id: number; agent_id: string }>(
      "SELECT message_id, agent_id FROM wake_jobs WHERE agent_id = ? AND state IN ('pending','sending')",
    )
    .all(agentId)
  if (rows.length === 0) return []
  db.prepare<[string], void>(
    "UPDATE wake_jobs SET state = 'cancelled', detail = 'Recipient retired' WHERE agent_id = ? AND state IN ('pending','sending')",
  ).run(agentId)
  const conversations = new Set<string>()
  for (const row of rows) {
    const message = getBySeq(db, row.message_id)
    if (message === undefined) continue
    conversations.add(message.conversationId)
    if (message.fromAgentId === row.agent_id) continue
    const sender = getAgent(db, message.fromAgentId)
    if (sender === undefined || sender.status === "retired") continue
    send(db, {
      conversationId: message.conversationId,
      fromAgentId: row.agent_id,
      kind: "system",
      meta: { reason: "peer_retired" },
      body: "对方已离场：该节点已退役，发往该节点的消息不会再被投递。",
      idempotencyKey: `retired:${message.fromAgentId}->${row.agent_id}:${message.conversationId}`,
    })
  }
  return [...conversations]
}

/**
 * 发送方失败通知：原会话 `kind='system'` 消息，幂等键含 30min 窗口 ——
 * 同 (sender, recipient) 对窗口内重复通知合并为 1 条（spec §12 合并窗口）。
 * 返回受影响会话 id（调用方发布消息事件）。
 */
function sendFailureNotice(db: Db, job: WakeJob, now: number): string | undefined {
  const message = getBySeq(db, job.messageId)
  if (message === undefined || message.fromAgentId === job.agentId) return undefined
  const sender = getAgent(db, message.fromAgentId)
  if (sender === undefined || sender.status === "retired") return undefined
  const body =
    job.state === "expired"
      ? "投递失败：对方持续忙碌超过 24 小时，消息未送达。"
      : `投递失败：消息连续 ${REFUSAL_LIMIT} 次被对方拒收，已停止重试。`
  send(db, {
    conversationId: message.conversationId,
    fromAgentId: job.agentId,
    kind: "system",
    meta: { reason: "wake_failed", state: job.state },
    body,
    idempotencyKey: `wake-failed:${message.fromAgentId}->${job.agentId}:${Math.floor(now / NOTICE_WINDOW_MS)}`,
  })
  return message.conversationId
}

export interface DispatcherOptions {
  readonly db: Db
  /** `$AGENTCHAT_HOME`（备份目录根）。 */
  readonly home: string
  /** 注入时钟（缺省 `Date.now`）；测试传可控时间源。 */
  readonly now?: () => number
  /** 单轮异常回调（缺省 `console.error`）；测试可注入收集器。 */
  readonly onError?: (error: unknown) => void
}

export class Dispatcher {
  private readonly db: Db
  private readonly home: string
  private readonly now: () => number
  private readonly onError: (error: unknown) => void
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(options: DispatcherOptions) {
    this.db = options.db
    this.home = options.home
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? ((error) => console.error("[agentchat] dispatcher tick failed", error))
  }

  /** 启动 2s 循环（立即先跑一轮；`unref` 不阻塞进程退出）。 */
  start(): void {
    this.timer = setInterval(() => void this.tick(), DISPATCHER_INTERVAL_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 单轮调度（测试直接调用并注入 `now`；进行中重入直接返回）。
   * 轮级错误隔离：任何一步抛出（VACUUM/SQL/订阅方/通知落库）都被本层捕获记录，
   * **永不 reject** —— 两处 `void this.tick()` 调用点因此不会触发 unhandled rejection。
   */
  async tick(now: number = this.now()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      backupIfDue(this.db, this.home, now)
      sweepExpired(this.db, now) // 审批 24h 过期（Task 7；brief 授权每轮顺带调用）
      for (const conversationId of expireBusyJobs(this.db, now)) publishReceipt(conversationId)
      for (const conversationId of rependStuckSending(this.db, now)) publishReceipt(conversationId)
      await this.dispatchDue(now)
      for (let i = 0; i < MAX_JOBS_PER_TICK; i += 1) {
        const failed = claimFailedNotice(this.db, now)
        if (failed === undefined) break
        const conversationId = sendFailureNotice(this.db, failed, now)
        if (conversationId !== undefined) publishMessage(conversationId)
      }
    } catch (error) {
      try {
        this.onError(error)
      } catch {
        // 错误回调自身异常不再外传（tick 永不 reject 的兜底）
      }
    } finally {
      this.running = false
    }
  }

  private async dispatchDue(now: number): Promise<void> {
    for (const job of dueWakeJobs(this.db, now)) {
      if (job.recipientStatus === "busy" || job.recipientStatus === "offline") {
        deferWakeJob(this.db, { id: job.id, now, reason: job.recipientStatus })
        continue
      }
      if (job.recipientStatus === "retired") {
        // 竞态兜底：retire 已在退役时取消，此处覆盖认领窗口内退役的残留。
        for (const conversationId of retireWakeJobs(this.db, job.agentId)) {
          publishMessage(conversationId)
          publishReceipt(conversationId)
        }
        continue
      }
      const adapter = adapterFor(job.recipientVendor)
      if (adapter === undefined) {
        deferWakeJob(this.db, { id: job.id, now, reason: null })
        continue
      }
      const claimed = claimWakeJob(this.db, { id: job.id, now })
      if (claimed === undefined) continue
      const message = getBySeq(this.db, claimed.messageId)
      if (message === undefined) continue // FK 保证不可达；防呆留空
      publishReceipt(message.conversationId)
      // 注入（适配器抛错按拒收计，计入连续拒收；失败不打断本轮其余 job）。
      let result: DeliveryResult
      try {
        result = await adapter.inject(claimed.agentId, [message])
      } catch {
        result = "refused"
      }
      const applied = applyDeliveryResult(this.db, {
        agentId: claimed.agentId,
        messageSeq: claimed.messageId,
        result,
        now,
      })
      if (applied.stateChanged && applied.conversationId !== undefined) {
        publishReceipt(applied.conversationId)
      }
    }
  }
}
