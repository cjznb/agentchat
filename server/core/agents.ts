/**
 * 节点注册、身份与层级树业务（spec §5.1–§5.2、§9 `register`/`roster`）。
 *
 * - 根：首次注册生成 `join_token`（哈希存 `agent_keys`，明文写
 *   `$AGENTCHAT_HOME/tokens/<id>`，0600）；重连带 token 认领同一节点并激活 online
 * - 子：`task_ref` 幂等入树（重复注册同 id、parent 不改写）；逻辑节点：永不上线
 * - 退役不可恢复：`retire` 后任何注册路径都拒绝复活
 * - roster 读模型与展示态离线回写在 `core/roster`（`rosterTree`/`emitAgentTree`
 *   由本模块 re-export 保持既有导入路径）
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
  touchAgent,
  updateAgentCard,
  type Agent,
  type AgentCardPatch,
  type InsertAgentInput,
} from "../store/agents"
import { makeJobsDue } from "../store/wake"
import { publishMessage, publishReceipt } from "./publish"
import { emitAgentTree } from "./roster"
import { retireWakeJobs } from "./dispatcher"

// roster 读模型（展示态落库 + 树快照发布）自 `core/roster` re-export：既有导入路径不变。
export { conversationRoster, emitAgentTree, memberCards, OFFLINE_AFTER_MS, rosterTree, type MemberCard } from "./roster"

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
 * 注册认领的 `offline→online` 属 spec §5.2 身份认领（重启带 token），不走此白名单；
 * 另经状态上报的 `offline→online` 是展示态落库后的**重激活**（roster 把超阈值节点写成
 * offline，活节点的心跳上报必须能拉回，否则永久卡死）——白名单放行，`touchAgent` 拉回。
 *
 * **有意不放行 `offline→busy`（spec 既有裁决，勿扩矩阵）**：展示态落库 offline 后，
 * 节点若持续上报 busy 会收到 409，直至其首次 idle/online 上报重激活（白名单 offline→online
 * 已放行）。即「忙回合跨过阈值被判离线」的节点在下一帧 idle 前会短暂 409，这是**有意为之**
 * （busy 不是一次可自行脱离的重激活入口，只有回到 online/idle 才证明它活着）。
 */
const ALLOWED_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  online: ["busy", "offline", "retired"],
  busy: ["online", "offline", "retired"],
  offline: ["online", "retired"],
  retired: [],
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** 节点卡公共字段（spec §5.1 / A2A AgentCard）；`name` **可选**：未提供即视为「不改名」。 */
interface CardInput {
  readonly name?: string
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

/**
 * 兜底名（调用方**未提供** `name` 且是**新建**时生成；重注册路径永不受影响）：
 * `vendor-model-hex`（4 位 hex）——格式与旧 MCP 层 `resolveName` 完全一致，既有断言不变。
 */
function fallbackName(input: CardInput): string {
  return `${input.vendor ?? "unknown"}-${input.model ?? "unknown"}-${randomBytes(2).toString("hex")}`
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
    name: input.name ?? fallbackName(input),
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

/**
 * 卡片字段白名单投影：只带**已提供**（非 `undefined`）的项，供重注册更新既有节点。
 * `vendor`/`kind`/`parentId`/`taskRef`/`status` 等身份结构字段**永不在内**（不因重注册改写）。
 * `name` 同样只在**调用方真的提供了**时才进投影——否则「不带 name 的认领」（如 Claude 每次
 * SessionStart）会被兜底随机名改写（Part 1 回归）。
 */
function cardPatch(input: CardInput): AgentCardPatch {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.roleTag === undefined ? {} : { roleTag: input.roleTag }),
    ...(input.remark === undefined ? {} : { remark: input.remark }),
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
 * - 有 `joinToken`：认领同一根（同 id），非退役则激活 online 并按已提供卡片字段更新；退役拒绝
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
    touchAgent(db, existing.id, "online")
    // 重认领可更新卡片字段（名字随会话标题漂移等）；身份/结构字段不动（cardPatch 白名单）。
    const agent = updateAgentCard(db, existing.id, cardPatch(input))
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
 * 重复注册返回原节点（`parent_id` 不改写）、激活 online，并按**已提供**卡片字段更新名字等；
 * 退役节点拒绝复活。
 */
export function registerChild(db: Db, input: RegisterChildInput): Agent {
  const existing = getAgentByTaskRef(db, input.taskRef)
  if (existing !== undefined) {
    if (existing.status === "retired") {
      throw new RegistrationError("retired", `agent ${existing.id} retired, register rejected`)
    }
    touchAgent(db, existing.id, "online")
    // 幂等重注册可更新卡片字段（名字随会话标题漂移）；parent/kind/vendor/status 不动。
    const reactivated = updateAgentCard(db, existing.id, cardPatch(input))
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
