/**
 * T13 全量矩阵的**共享夹具**（`adapters/test/__tests__/matrix-kit.ts`）。
 *
 * 为什么不是 `.test.ts`：本仓红线「单文件 ≤ 250 纯行（非空、非注释）」（CONTRIBUTING.md:80），
 * 42 条用例塞不进一个文件 —— 故矩阵按主题拆成 `matrix-*.test.ts`，公共件收在本文件
 * （文件名不以 `.test.ts` 结尾 → vitest 不收集，仅供 import）。
 *
 * 复用而非另起一套（task-13 硬约束）：
 * - Hub 往返走 `../lib/host.mjs` 的 `createTestHost`（真 `createHubClient` / `createIdleFlush` /
 *   `IdlePoller`，只替换"注入宿主"一步）；
 * - 进程内**真 Hub**：`server/index.ts` 的 `start({port:0, db, home, hubTokenPath, testApi:true})`；
 * - 时钟容差与 pull 预热口径沿用 `../lib/scenario-kit.mjs`（`isDue`/`CLOCK_SKEW_MS`/`warmPull`），
 *   **绝不**写裸 `retry_at <= Date.now()` 的跨进程时钟比较；
 * - 身份头 / `tools/list` / `instructions` 走 `@modelcontextprotocol/sdk` 真客户端
 *   （`adapters/test/lib/host.mjs` 的 `hub.mcp()` 不带自定义初始化头）。
 *
 * 断言口径：每条用例都断言到「库内状态（`/api/test/dump` 原始行）+ 交付物（注入录音）」两级。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { clearAdapters } from "../../../server/adapters/types"
import { Dispatcher } from "../../../server/core/dispatcher"
import { openDb, type Db } from "../../../server/db"
import { start, type RunningServer } from "../../../server/index"
import { ensureHubToken } from "../../../server/routes/internal"
import { createTestHost } from "../lib/host.mjs"
import { warmPull } from "../lib/scenario-kit.mjs"

export type TestHost = ReturnType<typeof createTestHost>
export type Dump = Awaited<ReturnType<TestHost["dump"]>>
export type Session = { readonly agentId: string }

/** 断言失败详情里的短码（agentId/messageId 前 8 位，便于下一个人立刻定位）。 */
export const short = (id: string): string => id.slice(0, 8)

/** 数值容差断言的可读证据（跨进程时钟场景一律给两端数值）。 */
export function span(value: number, min: number, max: number, label: string): string {
  return `${label}: 实际 ${value}ms，期望 [${min}, ${max}]ms`
}

// ── `/api/test/dump` 原始行（snake_case）的**强类型**镜像 ─────────────────────
// `.mjs` 侧的 JSDoc typedef 只覆盖了部分列（agents 无 custom_name、messages 无 meta、
// readStates/approvals 是 unknown[]）；测试要断言的正是这些列，故在此显式声明并做一次
// `unknown` 结构收窄（不用 `any`，符合本仓禁 `as any` 红线）。
export interface DumpAgentRow {
  readonly id: string
  readonly name: string
  readonly custom_name: string | null
  readonly kind: string
  readonly status: string
  readonly vendor: string
  readonly task_ref: string | null
  readonly parent_id: string | null
  readonly role_tag: string | null
}
export interface DumpMessageRow {
  readonly id: string
  readonly seq: number
  readonly conversation_id: string
  readonly from_agent_id: string
  readonly body: string
  readonly kind: string
  readonly meta: string | null
  readonly idempotency_key: string | null
  readonly revoked_at: number | null
}
export interface DumpJobRow {
  readonly id: number
  readonly message_id: number
  readonly agent_id: string
  readonly state: string
  readonly attempts: number
  readonly retry_at: number
  readonly pending_reason: string | null
  readonly notified_at: number | null
  readonly detail: string
  readonly created_at: number
}
export interface DumpApprovalRow {
  readonly id: string
  readonly kind: string
  readonly action: string
  readonly status: string
  readonly target: string | null
  readonly requester_agent_id: string
  readonly payload: string
  readonly result: string | null
}
export interface DumpReadStateRow {
  readonly conversation_id: string
  readonly agent_id: string
  readonly last_read_seq: number
}
export interface DumpConversationRow {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly name: string | null
  readonly created_by: string
}
export interface DumpParticipantRow {
  readonly conversation_id: string
  readonly agent_id: string
  readonly role: string
}
export interface MatrixDump {
  readonly agents: DumpAgentRow[]
  readonly conversations: DumpConversationRow[]
  readonly participants: DumpParticipantRow[]
  readonly messages: DumpMessageRow[]
  readonly approvals: DumpApprovalRow[]
  readonly wakeJobs: DumpJobRow[]
  readonly readStates: DumpReadStateRow[]
}

/** `GET /api/test/dump` 的强类型视图（真相源；断言库内状态一律用它）。 */
export async function dumpOf(host: TestHost): Promise<MatrixDump> {
  return (await host.dump()) as unknown as MatrixDump
}

/** `dump.wakeJobs` 里该消息的 jobs。 */
export function jobsOf(dump: MatrixDump, seq: number): DumpJobRow[] {
  return dump.wakeJobs.filter((job) => job.message_id === seq)
}

/** `dump.messages` 里该会话的消息。 */
export function messagesOf(dump: MatrixDump, conversationId: string): DumpMessageRow[] {
  return dump.messages.filter((message) => message.conversation_id === conversationId)
}

/** 会话参与者 id 集合。 */
export function participantIds(dump: MatrixDump, conversationId: string): string[] {
  return dump.participants
    .filter((participant) => participant.conversation_id === conversationId)
    .map((participant) => participant.agent_id)
}

export interface MatrixCtx {
  readonly home: string
  readonly db: Db
  readonly server: RunningServer
  readonly token: string
  /** 无头假宿主；`baseUrl` 可指向死端口（N23 宿主不可达）。 */
  host(prefix: string, baseUrl?: string): TestHost
  /** 实例根（`role_tag:'container'`）+ 若干 runtime 会话（默认挂实例根下）→ `{taskRef: {agentId}}`。 */
  sessions(host: TestHost, taskRefs: readonly string[]): Promise<Record<string, Session>>
  /** 带任意请求头的 MCP SDK 客户端（身份头 / `instructions` / `tools/list`）。 */
  mcp(headers?: Record<string, string>): Promise<Client>
  /** 手动跑一轮真 dispatcher（D07 失败通知；本夹具不自动跑 2s 循环）。 */
  dispatcher(): Dispatcher
  run(sql: string, ...params: readonly unknown[]): void
  get<T>(sql: string, ...params: readonly unknown[]): T | undefined
  cleanup(): Promise<void>
}

/** 建一份矩阵夹具：一次性临时 home + 进程内真 Hub（testApi 开启）+ 同一张 hub_token。 */
export async function createMatrixCtx(prefix = "agentchat-t13-"): Promise<MatrixCtx> {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const db = openDb(join(home, "agentchat.db"))
  // 适配器注册表是**进程级单例**：逐用例清空，避免某 vendor 的 pull 占位跨用例渗漏。
  clearAdapters()
  const token = ensureHubToken(join(home, "hub_token"))
  const server = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token"), testApi: true })
  const hosts: TestHost[] = []
  const clients: Client[] = []

  const host = (namePrefix: string, baseUrl?: string): TestHost => {
    const created = createTestHost({
      home,
      baseUrl: baseUrl ?? server.url,
      namePrefix,
    })
    hosts.push(created)
    return created
  }

  const sessions = async (
    target: TestHost,
    taskRefs: readonly string[],
  ): Promise<Record<string, Session>> => {
    await target.registerRoot({ name: "root" })
    const out: Record<string, Session> = {}
    for (const taskRef of taskRefs) {
      out[taskRef] = await target.registerSession({ taskRef, name: taskRef })
    }
    // pull 预热（`scenario-kit.warmPull` 同口径）：首次取件即把该 vendor 登记为 pull 适配器，
    // dispatcher 此后不改写这些 job 的 attempts/retry_at，断言不受 2s tick 抢时序。
    const first = taskRefs[0]
    if (first !== undefined) await warmPull({ host: target }, out[first]!.agentId)
    return out
  }

  const mcp = async (headers: Record<string, string> = {}): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
    })
    const client = new Client({ name: "t13-matrix", version: "0.0.0" })
    await client.connect(transport as Transport)
    clients.push(client)
    return client
  }

  const run = (sql: string, ...params: readonly unknown[]): void => {
    db.prepare<unknown[], unknown>(sql).run(...params)
  }
  const get = <T>(sql: string, ...params: readonly unknown[]): T | undefined =>
    db.prepare<unknown[], T>(sql).get(...params)

  return {
    home,
    db,
    server,
    token,
    host,
    sessions,
    mcp,
    dispatcher: () => new Dispatcher({ db, home }),
    run,
    get,
    cleanup: async () => {
      for (const client of clients.splice(0)) await client.close().catch(() => undefined)
      for (const created of hosts.splice(0)) created.close()
      await server.close()
      clearAdapters()
      db.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** 读某节点收到的注入文本（未注册 → 空数组），用于"未注入方不得假 delivered"类断言。 */
export function injectedText(host: TestHost, agentId: string): string {
  return host.inboxOf(agentId).join("\n")
}

/** 服务端写入的 token 文件内容（`ensureHubToken` 同源；MCP 裸客户端用）。 */
export function hubTokenOf(home: string): string {
  return readFileSync(join(home, "hub_token"), "utf8").trim()
}

/** 取 MCP 工具结果的文本（`unknown` 入参 + 运行时收窄，避开 SDK 结果类型并集）。 */
export function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error(`expected tool result with content, got ${JSON.stringify(result)}`)
  }
  const content: unknown = result.content
  if (!Array.isArray(content)) throw new Error("expected content array")
  const block: unknown = content[0]
  if (typeof block !== "object" || block === null || !("text" in block)) {
    throw new Error("expected text content block")
  }
  const text: unknown = block.text
  if (typeof text !== "string") throw new Error("expected text string")
  return text
}

/** MCP 工具结果是否为错误（`isError`）。 */
export function toolFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("isError" in result)) return false
  return result.isError === true
}

/** roster 树（`RosterNode[]`，节点可嵌套 `children`）→ 全部节点 id（递归）。 */export function collectIds(nodes: unknown): string[] {
  const out: string[] = []
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue
      const node = item as { id?: unknown; children?: unknown }
      if (typeof node.id === "string") out.push(node.id)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * 注入文本 → messageId 的**解析契约**：有注入却解析不到 id → 显式失败。
 *
 * 为什么单列一个断言：`host.mjs` 的 `injectedIds` 依赖 `flush.formatMessages` 的行前缀
 * `- [<id>] 来自 <from>：`（test 与生产共用同一渲染）。若 P4/task-10 改坏该前缀，解析会
 * **静默变 0**，令"未注入"类断言假绿 —— 这里把它变成响亮失败。
 */
export function assertInjectionPrefix(host: TestHost, agentId: string): readonly string[] {
  const texts = host.inboxOf(agentId)
  const ids = host.injectedIdsOf(agentId).filter((id): id is string => typeof id === "string")
  if (texts.length > 0 && ids.length === 0) {
    throw new Error(
      `注入文本无法解析出 messageId（前缀契约「- [<id>] 来自 <from>：」可能被改坏）：` +
        texts.join(" | ").slice(0, 300),
    )
  }
  return ids
}
