/**
 * 会话标题 → Hub **展示名**（`custom_name`）。
 *
 * 为什么：Hub 里节点的显示名 = `COALESCE(custom_name, name)`。机器唯一名（`<目录名>-<id 短标识>`）
 * 保证唯一但难辨认——真机反馈："`default-workspace-f79d9a5c` 一眼看不出是谁"。DSH 每个会话都有标题
 * （`ctx.sessionTitle.get(session)` 折叠 `session/title` 事件，正是用户在 DSH 里看到的那句，
 * 例如"为 agentchat 编写 DSH 适配器"）。把它写进 `custom_name` 即"内部唯一 + 外部可认"两全。
 *
 * ## 铁律：**绝不覆盖用户手动改名**（真机事故）
 * 标题同步曾把用户在 AgentChat 里改好的名字（"AgentChat群聊测试员A"）在会话标题变化时又覆盖回
 * 会话标题（"AgentChat群聊测试准备"）。用户改名不可撤销地丢失，且无任何提示。
 *
 * 现在的判定（每个会话独立，状态**持久化**到 `<home>/agents/dsh.titles.json`）：
 * 1. 同步前先读 Hub 上的**当前展示名**（`GET /api/agents/:id` → `node.name`）；
 * 2. 若「上次写入值」存在且当前名 ≠ 它 → **用户改过名** → 该会话标记 `detached`，**永久停用**自动同步；
 * 3. 若没有「上次写入值」（首装/状态文件丢失）且当前名 ≠ 机器名（且 ≠ 本次标题）→ 说明已存在
 *    别人（用户）设的自定义名 → 同样标记 `detached`；
 * 4. 只有"当前名 == 机器名"或"当前名 == 我们上次写入的值"时才继续同步。
 *
 * 其它约束（沿用）：
 * - **`name` 永不变**（`task_ref` 幂等收养、撞名重试都依赖它稳定）；
 * - 展示名走 `PATCH /api/agents/:id`（入参 `{name}`：trim 非空、**≤64 字符**、禁控制字符 `\p{Cc}`）；
 * - 撞名回 **409 `name_taken`** → 退化为"标题 + 会话短标识"再试一次；
 * - 同值不重复请求；任何失败只记日志，**绝不打断宿主**；
 * - 读不到当前名（Hub 抖动/404）时**降级为旧行为**（继续尝试同步），不让可观测性故障阻断标题同步。
 *
 * @module lib/title
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { idSuffix } from "./session-hint.js"

/** Hub 展示名的字符上限（`agentRenameSchema`：`.max(64)`）。 */
export const TITLE_MAX_CHARS = 64

/** 标题同步状态文件名（相对 `<home>/agents/`）。 */
export const TITLE_STATE_FILE = "dsh.titles.json"

/**
 * 归一化标题：去控制字符（`\p{Cc}` → 空格）、折叠空白、去首尾空白、按**码点**截断到 64 字符。
 *
 * @param {unknown} raw 原始标题（来自 `sessionTitle.get(session)?.title`）
 * @returns {string | undefined} 可用标题；空/非字符串/全为空白 → `undefined`
 */
export function normalizeTitle(raw) {
  if (typeof raw !== "string") return undefined
  const flat = raw.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim()
  if (flat === "") return undefined
  const chars = [...flat]
  const clamped = chars.length <= TITLE_MAX_CHARS ? flat : chars.slice(0, TITLE_MAX_CHARS).join("").trim()
  return clamped === "" ? undefined : clamped
}

/**
 * 撞名时的退化展示名：`<截断后的标题>·<会话短标识>`，仍受限 64 字符。
 *
 * @param {string} title 已归一化标题
 * @param {string} sessionId 会话 id
 * @returns {string | undefined} 退化展示名（截断后为空 → `undefined`）
 */
export function alternateTitle(title, sessionId) {
  const suffix = idSuffix(sessionId)
  const budget = TITLE_MAX_CHARS - suffix.length - 1
  const head = [...title].slice(0, Math.max(1, budget)).join("").trim()
  return normalizeTitle(head === "" ? suffix : `${head}·${suffix}`)
}

/** 状态文件路径（`<home>/agents/dsh.titles.json`）。 */
export function titleStatePath(home) {
  return join(home, "agents", TITLE_STATE_FILE)
}

/**
 * 读状态文件：`{ [sessionId]: { synced?: string, detached?: boolean } }`。
 * 缺失/损坏/形状不符 → 空对象并记日志（**绝不抛**）。
 *
 * @param {string | undefined} path
 * @param {(message: string) => void} log
 * @returns {Record<string, {synced?: string, detached?: boolean}>}
 */
export function loadTitleState(path, log) {
  if (path === undefined) return {}
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return {} // 首次运行：文件不存在是最常见路径，不记日志
  }
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const state = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue
      const synced = typeof value["synced"] === "string" ? value["synced"] : undefined
      const detached = value["detached"] === true
      state[sessionId] = { ...(synced === undefined ? {} : { synced }), ...(detached ? { detached: true } : {}) }
    }
    return state
  } catch (error) {
    log(`标题同步状态文件不是合法 JSON（忽略并从空开始）：${String(error)}`)
    return {}
  }
}

/** 落盘（best-effort：失败只记日志，内存态继续生效）。 */
function persist(path, state, log) {
  if (path === undefined) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  } catch (error) {
    log(`标题同步状态写入失败（忽略）：${String(error)}`)
  }
}

/**
 * 建"标题同步"函数。
 *
 * @param {{
 *   ctx: {get?: (name: string) => unknown, on?: (name: string, listener: (...args: unknown[]) => void) => void},
 *   hub: {renameAgent(agentId: string, name: string): Promise<void>,
 *         readAgentDisplayName?: (agentId: string) => Promise<string | undefined>},
 *   log: (message: string) => void,
 *   enabled: boolean,
 *   home?: string,
 *   statePath?: string,
 * }} options `statePath` 显式优先，其次 `<home>/agents/dsh.titles.json`
 * @returns {(sessionId: string, agent: unknown, nodeId: string, machineName?: string) => Promise<void>}
 */
export function createTitleSync(options) {
  const log = options.log
  const enabled = options.enabled !== false
  const path =
    options.statePath ?? (typeof options.home === "string" ? titleStatePath(options.home) : undefined)
  /** sessionId → { synced?: string; detached?: boolean }（持久化）。 */
  const state = loadTitleState(path, log)
  /** sessionId → 已成功应用的标题（同值不重复请求；进程内缓存）。 */
  const applied = new Map()
  /** sessionId → **在途**标题：同一标题的并发修订事件只发一次请求（防抖，避免重复改名）。 */
  const inflight = new Map()
  /** sessionId → { agent, nodeId, machineName }：标题修订事件到达时据此重放。 */
  const known = new Map()
  /** 服务缺失只提示一次，避免刷屏。 */
  let serviceWarned = false

  /** 读会话标题（服务不可用/异常 → `undefined`，绝不抛）。 */
  function readTitle(agent) {
    if (!enabled) return undefined
    try {
      const session = agent?.session
      const service = typeof options.ctx.get === "function" ? options.ctx.get("sessionTitle") : undefined
      if (session === undefined || typeof service?.get !== "function") {
        if (!serviceWarned) {
          serviceWarned = true
          log("sessionTitle 服务不可用：节点展示名保持机器唯一名（不影响功能）")
        }
        return undefined
      }
      return normalizeTitle(service.get(session)?.title)
    } catch (error) {
      log(`读取会话标题失败（忽略）：${String(error)}`)
      return undefined
    }
  }

  /**
   * "该会话是否归用户（已被手动改名）"：返回 `true` = 停用自动同步。
   * 读不到当前名时返回 `false`（降级为旧行为：继续尝试同步）。
   */
  async function userOwnsName(sessionId, nodeId, title, machineName) {
    const read = options.hub.readAgentDisplayName
    if (typeof read !== "function") return false // 老 hub 客户端：无判定能力，保持旧行为
    let current
    try {
      current = await read(nodeId)
    } catch (error) {
      log(`读取节点展示名失败（降级为继续同步）：${String(error)}`)
      return false
    }
    if (current === undefined) return false // 节点暂不可读/404 → 不据此判断
    const entry = state[sessionId] ?? {}
    // ① 我们同步过，但现在名字不是我们写的 → 用户改过
    if (entry.synced !== undefined && current !== entry.synced) {
      markDetached(sessionId, entry, `展示名已被手动修改为「${current}」`)
      return true
    }
    // ② 我们从没同步过，但已存在自定义名（≠ 机器名、≠ 本次标题）→ 别覆盖
    if (
      entry.synced === undefined &&
      typeof machineName === "string" &&
      current !== machineName &&
      current !== title
    ) {
      markDetached(sessionId, entry, `已存在自定义展示名「${current}」`)
      return true
    }
    return false
  }

  /** 标记该会话"归用户"，持久化并只记一次日志。 */
  function markDetached(sessionId, entry, reason) {
    if (entry.detached === true) return
    state[sessionId] = { ...entry, detached: true }
    persist(path, state, log)
    log(`会话 ${sessionId} ${reason}：停止自动同步（保留用户改名）`)
  }

  /** 应用一次标题：先试标题，409 撞名再试带短标识的退化名。 */
  async function applyTitle(sessionId, agent, nodeId, machineName) {
    if (!enabled) return
    const title = readTitle(agent)
    if (title === undefined || applied.get(sessionId) === title || inflight.get(sessionId) === title) return
    if (state[sessionId]?.detached === true) return // 用户已改名：永不覆盖
    if (await userOwnsName(sessionId, nodeId, title, machineName)) return

    inflight.set(sessionId, title)
    try {
      const candidates = [title, alternateTitle(title, sessionId)].filter(
        (candidate, index, all) => candidate !== undefined && all.indexOf(candidate) === index,
      )
      for (const candidate of candidates) {
        try {
          await options.hub.renameAgent(nodeId, candidate)
          applied.set(sessionId, title)
          // 记录"我们写进去的名字"，下次据此判断是否被用户改过。
          state[sessionId] = { ...(state[sessionId] ?? {}), synced: candidate }
          persist(path, state, log)
          log(`会话 ${sessionId} 展示名已更新：${candidate}`)
          return
        } catch (error) {
          // 409 name_taken：展示名唯一索引冲突 → 换退化名再试；其它错误（含 404/400）不重试。
          if (error?.status === 409 && candidate !== candidates[candidates.length - 1]) continue
          log(`展示名同步失败（忽略，保留机器唯一名）：${String(error)}`)
          return
        }
      }
    } finally {
      // 失败时清除在途标记，让后续标题修订仍能重试。
      if (inflight.get(sessionId) === title) inflight.delete(sessionId)
    }
  }

  // 标题常在第一轮之后才生成/修订：订阅会话事件里的 `session/title`，按会话精确重放。
  try {
    options.ctx.on?.("session/event", (session, event) => {
      if (event?.type !== "session/title") return
      const sessionId = session?.header?.id
      const entry = typeof sessionId === "string" ? known.get(sessionId) : undefined
      if (entry !== undefined) void applyTitle(sessionId, entry.agent, entry.nodeId, entry.machineName)
    })
  } catch (error) {
    log(`订阅会话标题事件失败（忽略）：${String(error)}`)
  }

  return async (sessionId, agent, nodeId, machineName) => {
    if (!enabled) return
    known.set(sessionId, { agent, nodeId, machineName })
    await applyTitle(sessionId, agent, nodeId, machineName)
  }
}
