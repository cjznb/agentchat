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
import { listAgents, touchAgent, unreadCounts, type Agent } from "../store/agents"
import { emit } from "../ws"

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
    name: agent.name,
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
 * 节点树快照发布（`agent` WS 事件；Task 9 发布点）——注册/退役与 `/internal/state`
 * 状态变化处调用；路由层只调用本 core 导出函数，不直接广播。
 * 纯快照：不回写、不重入（读路径的落库+发事件在 `rosterTree` 内完成）。
 */
export function emitAgentTree(db: Db): void {
  emit("agent", { tree: buildRoster(db, Date.now()) })
}
