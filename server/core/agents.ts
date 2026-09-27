/**
 * 节点注册、身份与层级树业务（spec §5.1–§5.2、§9 `register`/`roster`）。
 *
 * - 根：首次注册生成 `join_token`（哈希存 `agent_keys`，明文写
 *   `$AGENTCHAT_HOME/tokens/<id>`，0600）；重连带 token 认领同一节点并激活 online
 * - 子：`task_ref` 幂等入树（重复注册同 id、parent 不改写）；逻辑节点：永不上线
 * - 退役不可恢复：`retire` 后任何注册路径都拒绝复活
 * - `rosterTree()` 产出森林结构 + 联系人卡 + 直达未读；展示态离线在读取时计算
 */
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  rosterTreeSchema,
  type AgentKind,
  type AgentStatus,
  type RosterNode,
} from "../../shared/contracts"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  getAgent,
  getAgentByTaskRef,
  getAgentByTokenHash,
  insertAgent,
  insertAgentKey,
  listAgents,
  touchAgent,
  unreadCounts,
  type Agent,
  type InsertAgentInput,
} from "../store/agents"
import { makeJobsDue } from "../store/wake"
import { emit } from "../ws"
import { publishMessage, publishReceipt } from "./publish"
import { retireWakeJobs } from "./dispatcher"

/** 展示态离线阈值（brief：`last_seen` 超过 600000ms → roster 报 offline）。 */
export const OFFLINE_AFTER_MS = 600_000

/** 注册与退役的域错误；`code` 供调用方（MCP/UI）分流处理。 */
export class RegistrationError extends Error {
  constructor(
    readonly code: "invalid_join_token" | "retired" | "parent_not_found",
    message: string,
  ) {
    super(message)
    this.name = "RegistrationError"
  }
}

/**
 * 状态迁移白名单（brief Constraints）：`online↔busy`、`online|busy→offline`、任意→`retired`。
 * 注册认领的 `offline→online` 属 spec §5.2 身份认领（重启带 token），不走此白名单。
 */
const ALLOWED_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  online: ["busy", "offline", "retired"],
  busy: ["online", "offline", "retired"],
  offline: ["retired"],
  retired: [],
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** 节点卡公共字段（spec §5.1 / A2A AgentCard）。 */
interface CardInput {
  readonly name: string
  readonly vendor?: string
  readonly model?: string
  readonly purpose?: string
  readonly skills?: readonly string[]
  readonly roleTag?: string
  readonly remark?: string
}

export interface RegisterRootInput extends CardInput {
  /** 重连认领已有根；缺省 = 首次注册并生成新 token。 */
  readonly joinToken?: string
}

export interface RegisterChildInput extends CardInput {
  /** 运行时 task/session id，子注册的幂等键（spec §5.2）。 */
  readonly taskRef: string
  readonly parentId: string
}

export interface RegisterLogicalInput extends CardInput {
  readonly parentId?: string
}

export interface RegisterRootResult {
  readonly agent: Agent
  readonly joinToken: string
}

function cardToInsert(
  input: CardInput,
  fixed: {
    readonly kind: AgentKind
    readonly status: AgentStatus
    readonly parentId?: string
    readonly taskRef?: string
  },
): InsertAgentInput {
  return {
    name: input.name,
    vendor: input.vendor ?? "—",
    kind: fixed.kind,
    status: fixed.status,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.roleTag === undefined ? {} : { roleTag: input.roleTag }),
    ...(input.remark === undefined ? {} : { remark: input.remark }),
    ...(fixed.parentId === undefined ? {} : { parentId: fixed.parentId }),
    ...(fixed.taskRef === undefined ? {} : { taskRef: fixed.taskRef }),
  }
}

function joinTokenHash(joinToken: string): string {
  return createHash("sha256").update(joinToken).digest("hex")
}

function writeTokenFile(home: string, agentId: string, joinToken: string): void {
  const dir = join(home, "tokens")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, agentId)
  writeFileSync(path, joinToken, { mode: 0o600 })
  chmodSync(path, 0o600) // Windows 上尽力而为：调用成功但权限位可能不生效（见 task-3 报告）
}

function assertParentExists(db: Db, parentId: string): void {
  if (getAgent(db, parentId) === undefined) {
    throw new RegistrationError("parent_not_found", `parent agent not found: ${parentId}`)
  }
}

/**
 * 注册/认领 runtime 根（spec §5.2）：
 * - 无 `joinToken`：新建根，生成 join_token（哈希入 `agent_keys`，明文入 token 文件）
 * - 有 `joinToken`：认领同一根（同 id），非退役则激活 online；退役拒绝
 */
export function registerRoot(
  db: Db,
  home: string,
  input: RegisterRootInput,
): RegisterRootResult {
  if (input.joinToken !== undefined) {
    const existing = getAgentByTokenHash(db, joinTokenHash(input.joinToken))
    if (existing === undefined) {
      throw new RegistrationError(
        "invalid_join_token",
        `unknown join_token: ${input.joinToken}`,
      )
    }
    if (existing.status === "retired") {
      throw new RegistrationError("retired", `agent ${existing.id} retired, claim rejected`)
    }
    const agent = touchAgent(db, existing.id, "online")
    // 重连补投（spec §7）：pending 积压（含 pending(offline)）立即到期，由 dispatcher 补投。
    makeJobsDue(db, { agentId: agent.id, now: Date.now() })
    emitAgentTree(db)
    return { agent, joinToken: input.joinToken }
  }

  const joinToken = randomBytes(32).toString("base64url")
  const hash = joinTokenHash(joinToken)
  const agent = db.transaction((): Agent => {
    const created = insertAgent(db, cardToInsert(input, { kind: "runtime", status: "online" }))
    insertAgentKey(db, hash, created.id)
    return created
  }).immediate()
  writeTokenFile(home, agent.id, joinToken)
  emitAgentTree(db)
  return { agent, joinToken }
}

/**
 * 注册 runtime 子节点（spec §5.2：`task_ref` 幂等键）：
 * 重复注册返回原节点（`parent_id` 不改写）并激活 online；退役节点拒绝复活。
 */
export function registerChild(db: Db, input: RegisterChildInput): Agent {
  const existing = getAgentByTaskRef(db, input.taskRef)
  if (existing !== undefined) {
    if (existing.status === "retired") {
      throw new RegistrationError("retired", `agent ${existing.id} retired, register rejected`)
    }
    const reactivated = touchAgent(db, existing.id, "online")
    emitAgentTree(db)
    return reactivated
  }
  assertParentExists(db, input.parentId)
  const created = insertAgent(
    db,
    cardToInsert(input, {
      kind: "runtime",
      status: "online",
      parentId: input.parentId,
      taskRef: input.taskRef,
    }),
  )
  emitAgentTree(db)
  return created
}

/** 注册逻辑节点（spec §5.2：永不上线、收件箱常开；初始 status=offline）。 */
export function registerLogical(db: Db, input: RegisterLogicalInput): Agent {
  if (input.parentId !== undefined) assertParentExists(db, input.parentId)
  const created = insertAgent(
    db,
    cardToInsert(input, {
      kind: "logical",
      status: "offline",
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    }),
  )
  emitAgentTree(db)
  return created
}

/** 退役节点（spec §5.2：不可恢复；树上灰显保留）。幂等：已退役原样返回。 */
export function retire(db: Db, id: string): Agent {
  const current = getAgent(db, id)
  if (current === undefined) throw new AgentNotFoundError(id)
  if (current.status === "retired") return current
  // 任意→retired 恒在白名单内（canTransition 矩阵测试锁定）。
  const retired = touchAgent(db, id, "retired")
  // 退役取消（spec §7）：未投递 job 全 cancelled + 发送方收 system 消息「对方已离场」。
  for (const conversationId of retireWakeJobs(db, id)) {
    publishMessage(db, conversationId)
    publishReceipt(db, conversationId)
  }
  emitAgentTree(db)
  return retired
}

// roster 线格式 schema/类型单源在 shared/contracts（Task 9 上移，REST/WS/前端共用）；
// 此处 re-export 保持既有导入路径（`core/agents.rosterTreeSchema`）。
export { rosterTreeSchema }
export type { RosterNode }

/**
 * 展示态状态（读取时计算，**不回写库**）：
 * 存储为 online/busy 但 `last_seen` 超过阈值 → 报 offline；offline/retired 原样。
 */
function displayStatus(agent: Agent, now: number): AgentStatus {
  if (agent.status === "online" || agent.status === "busy") {
    return now - agent.lastSeen > OFFLINE_AFTER_MS ? "offline" : agent.status
  }
  return agent.status
}

/** 森林结构 + 联系人卡 + 直达未读（spec §9 `roster`）。 */
export function rosterTree(db: Db): RosterNode[] {
  const now = Date.now()
  const unread = unreadCounts(db)
  const childrenByParent = new Map<string, Agent[]>()
  const roots: Agent[] = []
  for (const agent of listAgents(db)) {
    if (agent.parentId === undefined) {
      roots.push(agent)
      continue
    }
    const bucket = childrenByParent.get(agent.parentId)
    if (bucket === undefined) childrenByParent.set(agent.parentId, [agent])
    else bucket.push(agent)
  }
  const build = (agent: Agent): RosterNode => ({
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    parent_id: agent.parentId ?? null,
    vendor: agent.vendor,
    model: agent.model,
    status: displayStatus(agent, now),
    status_text: agent.statusText ?? null,
    purpose: agent.purpose ?? null,
    role_tag: agent.roleTag ?? null,
    remark: agent.remark ?? null,
    unread: unread.get(agent.id) ?? 0,
    children: (childrenByParent.get(agent.id) ?? []).map(build),
  })
  return roots.map(build)
}

/**
 * 节点树快照发布（`agent` WS 事件；Task 9 发布点）——注册/退役与 `/internal/state`
 * 状态变化处调用；路由层只调用本 core 导出函数，不直接广播。
 */
export function emitAgentTree(db: Db): void {
  emit("agent", { tree: rosterTree(db) })
}
