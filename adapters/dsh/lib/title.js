/**
 * 会话标题 → Hub **展示名**（`custom_name`）。
 *
 * 为什么：Hub 里节点的显示名 = `COALESCE(custom_name, name)`。机器唯一名（`<目录名>-<id 短标识>`）
 * 保证唯一但难辨认——真机反馈："`default-workspace-f79d9a5c` 一眼看不出是谁"。DSH 每个会话都有标题
 * （`ctx.sessionTitle.get(session)` 折叠 `session/title` 事件，正是用户在 DSH 里看到的那句，
 * 例如"为 agentchat 编写 DSH 适配器"）。把它写进 `custom_name` 即"内部唯一 + 外部可认"两全：
 *
 * - **`name` 永不变**（`task_ref` 幂等收养、撞名重试都依赖它稳定）；
 * - 展示名走 Hub 的 `PATCH /api/agents/:id`（入参 `{name}`：trim 非空、**≤64 字符**、禁控制字符 `\p{Cc}`）；
 * - 展示名有唯一索引（`COALESCE(custom_name,name)`）→ 撞名回 **409 `name_taken`**：退化为"标题 + 会话短标识"
 *   再试一次（仍然只是展示名，不影响唯一性）；
 * - 标题常在第一轮之后才由模型生成，故除注册时读一次外，还订阅 `session/event` 的 `session/title` 修订；
 * - 同值不重复请求（每会话缓存"最后成功应用"的展示名）；任何失败只记日志，**绝不打断宿主**。
 *
 * @module lib/title
 */
import { idSuffix } from "./session-hint.js"

/** Hub 展示名的字符上限（`agentRenameSchema`：`.max(64)`）。 */
export const TITLE_MAX_CHARS = 64

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

/**
 * 建"标题同步"函数。
 *
 * @param {{ctx: {get?: (name: string) => unknown, on?: (name: string, listener: (...args: unknown[]) => void) => void},
 *   hub: {renameAgent(agentId: string, name: string): Promise<void>},
 *   log: (message: string) => void, enabled: boolean}} options
 * @returns {(sessionId: string, agent: unknown, nodeId: string) => Promise<void>}
 */
export function createTitleSync(options) {
  /** sessionId → 已成功应用的展示名（同值不重复请求）。 */
  const applied = new Map()
  /** sessionId → **在途**标题：同一标题的并发修订事件只发一次请求（防抖，避免重复改名）。 */
  const inflight = new Map()
  /** sessionId → { agent, nodeId }：标题修订事件到达时据此重放。 */
  const known = new Map()
  /** 服务缺失只提示一次，避免刷屏。 */
  let serviceWarned = false

  /** 读会话标题（服务不可用/异常 → `undefined`，绝不抛）。 */
  function readTitle(agent) {
    if (!options.enabled) return undefined
    try {
      const session = agent?.session
      const service = typeof options.ctx.get === "function" ? options.ctx.get("sessionTitle") : undefined
      if (session === undefined || typeof service?.get !== "function") {
        if (!serviceWarned) {
          serviceWarned = true
          options.log("sessionTitle 服务不可用：节点展示名保持机器唯一名（不影响功能）")
        }
        return undefined
      }
      return normalizeTitle(service.get(session)?.title)
    } catch (error) {
      options.log(`读取会话标题失败（忽略）：${String(error)}`)
      return undefined
    }
  }

  /** 应用一次标题：先试标题，409 撞名再试带短标识的退化名。 */
  async function applyTitle(sessionId, agent, nodeId) {
    const title = readTitle(agent)
    if (title === undefined || applied.get(sessionId) === title || inflight.get(sessionId) === title) return
    inflight.set(sessionId, title)
    try {
      const candidates = [title, alternateTitle(title, sessionId)].filter(
        (candidate, index, all) => candidate !== undefined && all.indexOf(candidate) === index,
      )
      for (const candidate of candidates) {
        try {
          await options.hub.renameAgent(nodeId, candidate)
          applied.set(sessionId, title)
          options.log(`会话 ${sessionId} 展示名已更新：${candidate}`)
          return
        } catch (error) {
          // 409 name_taken：展示名唯一索引冲突 → 换退化名再试；其它错误（含 404/400）不重试。
          if (error?.status === 409 && candidate !== candidates[candidates.length - 1]) continue
          options.log(`展示名同步失败（忽略，保留机器唯一名）：${String(error)}`)
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
      if (entry !== undefined) void applyTitle(sessionId, entry.agent, entry.nodeId)
    })
  } catch (error) {
    options.log(`订阅会话标题事件失败（忽略）：${String(error)}`)
  }

  return async (sessionId, agent, nodeId) => {
    if (!options.enabled) return
    known.set(sessionId, { agent, nodeId })
    await applyTitle(sessionId, agent, nodeId)
  }
}
