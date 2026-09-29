/**
 * roster 展示态与节点树快照（spec §9 `roster`；读路径的状态一致性回写）。
 *
 * - `rosterTree()` 产出森林结构 + 联系人卡 + 直达未读；
 * - 展示态离线：存储为 online/busy 但 `last_seen` 超阈值 → 展示 offline，并把该行
 *   **持久化为 offline**（`touchAgent(id,'offline')`）——dispatcher 的 `recipientStatus`
 *   与 `enqueueWakeJobs` 读的是**库里的 status**，不落库它们永远认为死节点 online
 *   （status coherence 修复：死节点从「`defer(reason=null)` 空转」变为按 offline 退避）；
 * - 写库仅在展示态与存储态真的背离时发生（同一次读取内幂等：落库后再次读取零写、
 *   零事件），落库后照旧发一次 `agent` 树事件；未超阈值/offline/retired/logical 节点原样；
 * - 落库是**可失败的副作用**，失败绝不拖垮读（见 `rosterTree` 的 try/catch 说明）：
 *   读方拿的永远是已算出的展示态，写失败仅记日志、下次读重试（多行落库单事务）。
 * - `emitAgentTree()` 走**纯快照**（不回写、不重入）：注册/状态变化路径与读路径的
 *   「落库+发事件」互不叠加（同一次请求内不会发出两条同态事件）。
 *
 * 从 `core/agents` 拆出：注册/退役与 roster 读模型职责分离（亦守单文件 ≤250 纯行）。
 */
import { type AgentStatus, type RosterNode } from "../../shared/contracts"
import type { Db } from "../db"
import {
  AgentNotFoundError,
  agentDisplayName,
  getAgent,
  listAgents,
  touchAgent,
  unreadCounts,
  type Agent,
} from "../store/agents"
import { getConversation, isParticipant, listParticipants, SHOUT_KEY } from "../store/conversations"
import { emit } from "../ws"
import { NotParticipantError } from "./messaging"

/** 展示态离线阈值（brief：`last_seen` 超过 600000ms → roster 报 offline）。 */
export const OFFLINE_AFTER_MS = 600_000

/**
 * 展示态状态（读取时计算）：
 * 存储为 online/busy 但 `last_seen` 超过阈值 → 报 offline；offline/retired 原样。
 */
function displayStatus(agent: Agent, now: number): AgentStatus {
  if (agent.status === "online" || agent.status === "busy") {
    return now - agent.lastSeen > OFFLINE_AFTER_MS ? "offline" : agent.status
  }
  return agent.status
}

/**
 * 落库记账：展示态与存储态的**唯一背离**就是「online/busy 超阈值 → offline」，
 * 命中即记入 `stale`（调用方统一回写）。offline/retired/logical 无背离，永不在内。
 */
function noteStale(agent: Agent, displayed: AgentStatus, stale: string[]): AgentStatus {
  if (displayed !== agent.status) stale.push(agent.id)
  return displayed
}

/**
 * 森林结构构建（纯读模型）；`stale` 收集本次读取发现的「存储 online/busy 但已超阈值」
 * 行 id（缺省丢弃 —— `emitAgentTree` 快照路径不需要回写记账）。
 */
function buildRoster(db: Db, now: number, stale: string[] = []): RosterNode[] {
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
    name: agentDisplayName(agent),
    kind: agent.kind,
    parent_id: agent.parentId ?? null,
    vendor: agent.vendor,
    model: agent.model,
    status: noteStale(agent, displayStatus(agent, now), stale),
    status_text: agent.statusText ?? null,
    purpose: agent.purpose ?? null,
    role_tag: agent.roleTag ?? null,
    remark: agent.remark ?? null,
    skills: agent.skills,
    unread: unread.get(agent.id) ?? 0,
    children: (childrenByParent.get(agent.id) ?? []).map(build),
  })
  return roots.map(build)
}

/**
 * 森林结构 + 联系人卡 + 直达未读（spec §9 `roster`）。
 * 展示态 offline 的行**就地持久化**（仅状态真的变化时写、幂等），随后照旧发一次
 * `agent` 树事件；再次读取无背离 → 零写、零事件（读→发→读 不成事件风暴）。
 *
 * **写失败不影响读（Important #1）**：落库与发事件整体包在 `try/catch` 内 ——
 * `touchAgent` 会抛（`AgentNotFoundError` / `SQLITE_READONLY` / `SQLITE_FULL` / `IOERR`），
 * 而本函数的调用方（`GET /api/roster`、MCP `roster`、`agentCard`）没有 `app.onError`
 * 兜底，异常上抛会把**本可成功的读**变成 500、整份 roster 拿不到，尽管展示态已经算对。
 * 故失败只记日志、**仍返回已算出的树**；落库幂等 → 下次读自动重试补齐。
 */
export function rosterTree(db: Db): RosterNode[] {
  const stale: string[] = []
  const tree = buildRoster(db, Date.now(), stale)
  if (stale.length > 0) {
    try {
      // 单事务写完全部 stale 行：要么全成、要么全不成（避免「半个 roster 落库」）。
      // `immediate` 开局取写锁，规避 WAL 下读→写升级的 SQLITE_BUSY（与 registerRoot 同法）。
      db.transaction((ids: readonly string[]) => {
        for (const id of ids) touchAgent(db, id, "offline")
      }).immediate(stale)
      // 只在**真的写入了任何行**后发一次（事务抛 → 不发）。
      emitAgentTree(db)
    } catch (error) {
      // 只记错误对象（SQLite 错误码/消息与域错误名），不输出行数据/token 等敏感值。
      console.error("[agentchat] roster offline persist failed", error)
    }
  }
  return tree
}

/**
 * 过滤变体（Task 5）：只保留 `memberIds` 中的节点，仍返回 `RosterNode[]` 森林。
 * 非成员祖先被整节点跳过 —— 其成员子节点上浮到该位置（输出**只含成员**，
 * 不留只作结构用途的非成员节点）；成员的成员子节点保持原层级。
 */
function pickMembers(nodes: readonly RosterNode[], memberIds: ReadonlySet<string>): RosterNode[] {
  const kept: RosterNode[] = []
  for (const node of nodes) {
    const children = pickMembers(node.children, memberIds)
    if (memberIds.has(node.id)) kept.push({ ...node, children })
    else kept.push(...children)
  }
  return kept
}

/**
 * 会话成员 roster（spec §4.4；Task 5）：只返回该会话成员的过滤森林（`RosterNode[]`）。
 *
 * - **成员闸门**（口径同 `ask-group` F1 / `resolveConversation`，T4 范式）：
 *   非 human 且非会话成员 → `NotParticipantError`（code `not_participant`）——
 *   堵死「非成员 agent 枚举他群成员名单」的越权读。单一核心函数，显式 requester 传参：
 *   MCP `roster {conversation}` 传调用方身份；HTTP `GET /api/roster?conversation=`
 *   传 human 身份（人类 UI 视图 → 超观察者豁免），不写两套。
 * - shout 广播会话**无 participants 行**（`store/conversations` 决议 3）→ 该参数不接受
 *   喊话会话：先于闸门判定、恒返回 `[]`（选「返回空」：无成员即空，无需新错误码）。
 * - 未知会话 id：成员集为空 → `[]`；非成员 agent 先被闸门以 `not_participant` 拒绝
 *   （未知 id 与既有非成员会话同码，不泄露会话存在性）。
 */
export function conversationRoster(
  db: Db,
  requesterId: string,
  conversationId: string,
): RosterNode[] {
  if (getConversation(db, conversationId)?.key === SHOUT_KEY) return []
  const requester = getAgent(db, requesterId)
  if (requester === undefined) throw new AgentNotFoundError(requesterId)
  if (requester.vendor !== "human" && !isParticipant(db, conversationId, requesterId)) {
    throw new NotParticipantError(requesterId, conversationId)
  }
  const memberIds = new Set(listParticipants(db, conversationId).map((row) => row.agentId))
  return pickMembers(rosterTree(db), memberIds)
}

/** 群成员卡片（`group op:list.member_cards`，spec §4.4；id + 展示名 + 展示态）。 */
export interface MemberCard {
  readonly id: string
  readonly name: string
  readonly status: AgentStatus
}

/**
 * 会话成员卡片（Task 5）：id/name/status 与 roster 节点**同口径**（走 `rosterTree`
 * 的展示态；Task 6 落展示名后改 `buildRoster` 即同时回归 roster 与本卡）。
 * 无闸门 —— 供 `group op:list`（既有无闸读）在 `members` 旁附卡片。
 */
export function memberCards(db: Db, conversationId: string): MemberCard[] {
  const memberIds = new Set(listParticipants(db, conversationId).map((row) => row.agentId))
  if (memberIds.size === 0) return []
  const cards: MemberCard[] = []
  const walk = (nodes: readonly RosterNode[]): void => {
    for (const node of nodes) {
      if (memberIds.has(node.id)) cards.push({ id: node.id, name: node.name, status: node.status })
      walk(node.children)
    }
  }
  walk(rosterTree(db))
  return cards
}

/**
 * 节点树快照发布（`agent` WS 事件；Task 9 发布点）——注册/退役与 `/internal/state`
 * 状态变化处调用；路由层只调用本 core 导出函数，不直接广播。
 * 纯快照：不回写、不重入（读路径的落库+发事件在 `rosterTree` 内完成）。
 */
export function emitAgentTree(db: Db): void {
  emit("agent", { tree: buildRoster(db, Date.now()) })
}
