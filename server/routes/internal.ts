/**
 * 适配器内部端点（spec §7/§10；计划文件结构 `server/routes/internal.ts`）。
 * 全部 `Authorization: Bearer <HUB_TOKEN>` 鉴权（无票 401）；token 存
 * `$AGENTCHAT_HOME/hub_token`（0600，同 join_token 模式）。
 *
 * - `POST /internal/state {agentId, state}` → `{ok}`：状态上报走 `canTransition`
 *   白名单（T3 裁决：调用方判定）；`idle` → `online`；同态上报 = 心跳触碰；
 *   **子节点永不置 offline**（T3 已裁决契约，409 拒绝）
 * - `POST /internal/wake {agentId}` → `{messages[], receipts[]}`：认领积压
 *   （runtime 认领即 job → `sending` + 30s 在途租约、回执 → `sending`；
 *   **不**直接 `accepted`——崩溃未回执时租约过期可重投）；过滤 `from != target`
 *   （T4 交接：inbox 含自发消息）；logical 节点只取件不建 job
 * - `POST /internal/result {agentId, items}` → `delivered/refused` 落库
 *   （`delivered` → job `accepted` → 收件方回执 `delivered`，亦为唯一 `accepted` 来源）
 * - `POST /internal/retire {agentId}` → `{ok}`：退役子节点（不可恢复；取消待投递 job）
 *
 * `applyAgentState` / `claimWakeBacklog` 导出为纯函数：fake 适配器的
 * `reportState` 汇点与测试复用同一处理器（与 HTTP 路径零分叉）。
 */
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Hono } from "hono"
import { z } from "zod"
import type { ReceiptStage } from "../../shared/contracts"
import { adapterStateSchema, type AdapterState } from "../adapters/types"
import { canTransition, emitAgentTree, retire } from "../core/agents"
import { receiptState } from "../core/messaging"
import { publishReceipt } from "../core/publish"
import { config } from "../config"
import { openDb, type Db } from "../db"
import { AgentNotFoundError, getAgent, touchAgent } from "../store/agents"
import { getConversationByKey, SHOUT_KEY } from "../store/conversations"
import { DEFAULT_INBOX_LIMIT, getById, inboxMessages, type Message } from "../store/messages"
import { applyDeliveryResult, makeJobsDue } from "../store/wake"
import { claimWakeBacklogJob } from "../store/wake-claims"

// 生产缺省连接（同 routes/ui 模式）：首个 /internal 请求时按 config 打开并复用。
let defaultDb: Db | undefined

function resolveDb(db: Db | undefined): Db {
  if (db !== undefined) return db
  defaultDb ??= openDb(config.dbPath)
  return defaultDb
}

/**
 * 读取或生成 `HUB_TOKEN`（0600）：文件已存在且非空则复用，否则生成
 * 32 字节随机 token 落盘。Windows 上 chmod 为尽力而为——调用成功但
 * 权限位可能不生效（同 join_token 文件，见 task-3 报告）。
 */
export function ensureHubToken(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim()
    if (existing !== "") return existing
  } catch {
    // 文件不存在 → 走生成
  }
  mkdirSync(dirname(path), { recursive: true })
  const token = randomBytes(32).toString("base64url")
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600) // Windows 上尽力而为（权限位可能不生效）
  return token
}

export type StateReportOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "agent_not_found"; readonly status: 404 }
  | {
      readonly ok: false
      readonly error: "child_never_offline" | "transition_rejected"
      readonly status: 409
    }

export interface StateReportInput {
  readonly agentId: string
  readonly state: AdapterState
  /** 注入时钟（缺省 `Date.now`）。 */
  readonly now?: number
}

/**
 * 状态上报（HTTP 与 fake 适配器共用）：`canTransition` 白名单判定 + 心跳触碰；
 * 上报 `online`（含 `idle` 映射）时使该节点全部 `pending` job 立即到期（补投）。
 *
 * 与 roster 展示态落库配套的**有意裁决**（见 `core/agents` 白名单注释）：节点被读路径
 * 落库为 offline 后，**持续上报 busy 会拿到 409 `transition_rejected`**，直至它的首次
 * `idle`/`online` 上报重激活（`offline→online` 白名单已放行）。矩阵**不**因此扩 `offline→busy`。
 */
export function applyAgentState(db: Db, input: StateReportInput): StateReportOutcome {
  const agent = getAgent(db, input.agentId)
  if (agent === undefined) return { ok: false, error: "agent_not_found", status: 404 }
  const target = input.state === "idle" ? "online" : input.state
  if (target === agent.status) {
    touchAgent(db, input.agentId) // 同态上报 = 心跳触碰（spec §7 RPC 触碰判离线）
    return { ok: true }
  }
  if (target === "offline" && agent.parentId !== undefined) {
    return { ok: false, error: "child_never_offline", status: 409 } // 裁决：offline 仅根
  }
  if (!canTransition(agent.status, target)) {
    return { ok: false, error: "transition_rejected", status: 409 }
  }
  touchAgent(db, input.agentId, target)
  if (target === "online") {
    makeJobsDue(db, { agentId: input.agentId, now: input.now ?? Date.now() })
  }
  // 状态变化发布 `agent` WS 事件（Task 9：路由层只调用 core 导出函数，不直接广播）。
  emitAgentTree(db)
  return { ok: true }
}

export interface WakeBacklogResult {
  readonly messages: readonly Message[]
  readonly receipts: readonly { readonly messageId: string; readonly stage: ReceiptStage }[]
  /** 状态推进涉及的会话（调用方发布回执事件）。 */
  readonly conversations: readonly string[]
}

/**
 * 认领积压（pull 在途租约）：收件箱中回执未 delivered/read 的消息；runtime 收件方
 * 认领即置 `sending` + `CLAIM_TIMEOUT_MS` 租约（**不是** `accepted`——`accepted`
 * 只由 `/internal/result {delivered}` 派生）；job 缺失时补建为 `sending`，崩溃未回执
 * 则租约过期后下一次 wake 重投。已终态或在途租约仍有效的 `sending` 不重复认领。
 * logical（含 human）只取件不建 job。回执 stage 因此为 `sending`。
 */
export function claimWakeBacklog(
  db: Db,
  input: { readonly agentId: string; readonly now?: number },
): WakeBacklogResult {
  const agent = getAgent(db, input.agentId)
  if (agent === undefined) return { messages: [], receipts: [], conversations: [] }
  const now = input.now ?? Date.now()
  const shoutConversationId = getConversationByKey(db, SHOUT_KEY)?.id ?? ""
  const page = inboxMessages(db, {
    agentId: input.agentId,
    shoutConversationId,
    after: 0,
    limit: DEFAULT_INBOX_LIMIT,
  })
  const messages: Message[] = []
  const receipts: { messageId: string; stage: ReceiptStage }[] = []
  const conversations = new Set<string>()
  for (const message of page) {
    if (message.fromAgentId === input.agentId) continue // T4 交接：过滤自发消息（from != target）
    const stage = receiptState(db, message, input.agentId)
    if (stage === "delivered" || stage === "read") continue
    if (agent.kind === "runtime") {
      const claimed = claimWakeBacklogJob(db, {
        messageSeq: message.seq,
        agentId: input.agentId,
        now,
      })
      if (claimed === undefined) continue // 终态或在途租约仍有效：不重复认领
      conversations.add(message.conversationId)
    }
    messages.push(message)
    receipts.push({ messageId: message.id, stage: receiptState(db, message, input.agentId) })
  }
  return { messages, receipts, conversations: [...conversations] }
}

const stateBodySchema = z.object({ agentId: z.string().min(1), state: adapterStateSchema })
const wakeBodySchema = z.object({ agentId: z.string().min(1) })
const resultBodySchema = z.object({
  agentId: z.string().min(1),
  items: z.array(
    z.object({ messageId: z.string().min(1), result: z.enum(["delivered", "refused"]) }),
  ),
})
const retireBodySchema = z.object({ agentId: z.string().min(1) })

export interface InternalRoutesOptions {
  /** `hub_token` 路径（缺省 `config.hubTokenPath`）；测试注入临时 home。 */
  readonly hubTokenPath?: string
}

/** 三个内部端点的路由表；`db` 缺省时惰性取进程配置库（测试显式注入临时库）。 */
export function internalRoutes(db?: Db, options?: InternalRoutesOptions): Hono {
  let hubToken: string | undefined
  const token = (): string => {
    hubToken ??= ensureHubToken(options?.hubTokenPath ?? config.hubTokenPath)
    return hubToken
  }

  return new Hono()
    .use("/internal/*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${token()}`) {
        return c.json({ ok: false, error: "unauthorized" }, 401)
      }
      await next()
    })
    .post("/internal/state", async (c) => {
      const parsed = stateBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const outcome = applyAgentState(resolveDb(db), parsed.data)
      return outcome.ok
        ? c.json({ ok: true })
        : c.json({ ok: false, error: outcome.error }, outcome.status)
    })
    .post("/internal/wake", async (c) => {
      const parsed = wakeBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const database = resolveDb(db)
      const agent = getAgent(database, parsed.data.agentId)
      if (agent === undefined) return c.json({ ok: false, error: "agent_not_found" }, 404)
      const backlog = claimWakeBacklog(database, parsed.data)
      for (const conversationId of backlog.conversations) publishReceipt(database, conversationId)
      return c.json({ messages: backlog.messages, receipts: backlog.receipts })
    })
    .post("/internal/result", async (c) => {
      const parsed = resultBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      const database = resolveDb(db)
      let applied = 0
      for (const item of parsed.data.items) {
        const message = getById(database, item.messageId)
        if (message === undefined) continue
        const outcome = applyDeliveryResult(database, {
          agentId: parsed.data.agentId,
          messageSeq: message.seq,
          result: item.result,
          now: Date.now(),
        })
        if (outcome.stateChanged && outcome.conversationId !== undefined) {
          publishReceipt(database, outcome.conversationId)
        }
        applied += 1
      }
      return c.json({ ok: true, applied })
    })
    .post("/internal/retire", async (c) => {
      const parsed = retireBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ ok: false, error: "invalid_body" }, 400)
      try {
        retire(resolveDb(db), parsed.data.agentId)
      } catch (error) {
        if (error instanceof AgentNotFoundError) {
          return c.json({ ok: false, error: "agent_not_found" }, 404)
        }
        throw error
      }
      return c.json({ ok: true })
    })
}
