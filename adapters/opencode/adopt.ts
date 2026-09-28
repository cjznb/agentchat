/**
 * 会话收养（缺陷修复：仅靠 `session.created` 注册，导致「已存在/被恢复」的会话永不进入 AgentChat）。
 *
 * OpenCode 不会为已存在/被恢复的会话补发 `session.created`，插件此前只能在未映射会话上跳过并 warn。
 * 本模块提供两条收养路径（均复用既有 token 认领语义，绝不新建重复节点）：
 * - **A 懒收养**：任何带会话的事件指向未映射会话时，`client.session.get` 查询后按 `parentID` 收养：
 *   根 → 既有根注册路径；子且父已映射 → 子注册（`parent_ref` + `task_ref`）；子且父未映射 → 跳过并 warn
 *   （**绝不回落根**，不猜父）。查询失败/404 亦保持跳过并 warn，不崩溃。
 * - **B 启动枚举**：初始化后 fire-and-forget 地 `client.session.list`（`roots`+`limit`，默认 5，
 *   `AGENTCHAT_ADOPT_LIMIT` 可覆盖；`AGENTCHAT_ADOPT=0` 关闭），客户端过滤 `time.archived` 后逐个走
 *   与 A 相同的根收养；`session.list` 不可用/报错（老宿主）即记录并静默降级，只保留 A。
 *
 * 依赖经 `AdoptDeps` 注入（避免与 `plugin.ts` 的模块环），状态经 `AdoptState` 读写既有映射表。
 *
 * **形状容错（缺陷修复）**：宿主 `client.session.get`/`list` 可能返回裸值，也可能返回 SDK 的
 * `{ data, error, request, response }` 包装（见 `sdk-result.ts` 实证）。此前直接当 `Session` 用，
 * 包装被当成「无 `parentID` 的根」→ 误判根、把 `undefined` 写入映射；`list` 拿到 `{data:[…]}` 非数组
 * → `.filter` 抛错、B 静默失效。现统一经 `unwrapResult` 解包后再走原逻辑。
 */
import { describe } from "./flush"
import { unwrapResult } from "./sdk-result"
import type { Hub } from "./hub"
import type { OpencodeClient, OpencodeSession } from "./types"

/** 默认启动收养上限。 */
export const DEFAULT_ADOPT_LIMIT = 5
/** 允许的最小上限。 */
export const MIN_ADOPT_LIMIT = 1
/** 允许的最大上限（防止一次拉爆宿主）。 */
export const MAX_ADOPT_LIMIT = 50

/** 解析 `AGENTCHAT_ADOPT_LIMIT`：非法/非正回落默认 5，合法值钳制到 `[1,50]`（取整）。 */
export function parseAdoptLimit(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ADOPT_LIMIT
  return Math.min(MAX_ADOPT_LIMIT, Math.max(MIN_ADOPT_LIMIT, Math.floor(value)))
}

/** `AGENTCHAT_ADOPT=0` 关闭启动枚举收养（A 懒收养不受影响）。 */
export function isAdoptEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["AGENTCHAT_ADOPT"] !== "0"
}

/** `Session[]` 结构守卫：把解包后的 `unknown` 收窄为只读数组（非数组 = 不可用）。 */
function isSessionArray(value: unknown): value is readonly OpencodeSession[] {
  return Array.isArray(value)
}

/** 既有会话映射表的最小读写面（由 `plugin.ts` 的运行时状态实现）。 */
export interface AdoptState {
  get(sessionID: string): string | undefined
  set(sessionID: string, agentId: string): void
  /** 当前根节点 agent id（未注册时 undefined）。 */
  rootAgentId(): string | undefined
}

export interface AdoptDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly client: OpencodeClient
  readonly hub: Hub
  readonly vendor: string
  readonly state: AdoptState
  /** 既有根注册路径（读/写 join_token、陈旧 token 自愈后重注册）。 */
  readonly rootRegister: (session: OpencodeSession) => Promise<void>
  /** 与事件处理共用的串行队列（避免同一会话并发注册两次）。 */
  readonly enqueue: (task: () => Promise<void>) => void
  readonly log: (message: string) => void
}

export interface Adopter {
  /** A：解析 `sessionID` 的 agentId；未映射则查询并收养，失败返回 undefined。 */
  resolve(sessionID: string): Promise<string | undefined>
  /** 根会话收养（`session.created` 与 B 枚举共用；已有根则挂到同一节点）。 */
  adoptRoot(session: OpencodeSession): Promise<void>
}

/** 建收养器；构造即触发 B 的 fire-and-forget 启动枚举。 */
export function createAdopter(deps: AdoptDeps): Adopter {
  /** 根：已有根节点则挂到同一节点（不新建重复根）；否则走既有 token 认领注册。 */
  const adoptRoot = async (session: OpencodeSession): Promise<void> => {
    const agentId = deps.state.rootAgentId()
    if (agentId === undefined) await deps.rootRegister(session)
    else deps.state.set(session.id, agentId)
  }

  /** 子：严格以父节点注册；父未映射由调用方拦截（本函数只做已确认父的注册）。 */
  const adoptChild = async (session: OpencodeSession, parentAgentId: string): Promise<void> => {
    try {
      const result = await deps.hub.register({
        vendor: deps.vendor,
        parent_ref: parentAgentId,
        task_ref: session.id,
      })
      deps.state.set(session.id, result.agentId)
    } catch (error) {
      deps.log(`child register failed for ${session.id}: ${describe(error)}`)
    }
  }

  /** 按会话对象分支收养；已映射即跳过（幂等）。 */
  const adopt = async (session: OpencodeSession): Promise<void> => {
    if (deps.state.get(session.id) !== undefined) return
    if (session.parentID === undefined) {
      await adoptRoot(session)
      return
    }
    const parentAgentId = deps.state.get(session.parentID)
    if (parentAgentId === undefined) {
      deps.log(`adopt child ${session.id} skipped: parent ${session.parentID} not mapped`)
      return
    }
    await adoptChild(session, parentAgentId)
  }

  const resolve = async (sessionID: string): Promise<string | undefined> => {
    const mapped = deps.state.get(sessionID)
    if (mapped !== undefined) return mapped
    const get = deps.client.session.get
    if (get === undefined) {
      deps.log(`session lookup unavailable for ${sessionID}; skipped`)
      return undefined
    }
    let raw: unknown
    try {
      raw = await get({ path: { id: sessionID } })
    } catch (error) {
      deps.log(`session lookup failed for ${sessionID}: ${describe(error)}`)
      return undefined
    }
    const result = unwrapResult<OpencodeSession>(raw)
    const session = result.data
    if (!result.ok || session === undefined) {
      // 包装 `error`（如 404）或空数据：保持既有「跳过 + warn」，**绝不误判为根**。
      const summary = result.error === undefined ? "no session data" : describe(result.error)
      deps.log(`session lookup failed for ${sessionID}: ${summary}`)
      return undefined
    }
    await adopt(session)
    return deps.state.get(sessionID)
  }

  const enumerate = (): void => {
    if (!isAdoptEnabled(deps.env)) return
    const list = deps.client.session.list
    if (list === undefined) {
      deps.log("startup adoption skipped: session.list unavailable")
      return
    }
    const limit = parseAdoptLimit(deps.env["AGENTCHAT_ADOPT_LIMIT"])
    deps.enqueue(async () => {
      let raw: unknown
      try {
        raw = await list({ query: { scope: "project", roots: true, limit } })
      } catch (error) {
        deps.log(`startup adoption list failed: ${describe(error)}`)
        return
      }
      const result = unwrapResult<unknown>(raw)
      const data = result.data
      if (!result.ok || !isSessionArray(data)) {
        // 包装 `error` 或非数组（老宿主）：记录并**静默降级**（只保留 A），绝不抛错。
        const summary = result.error === undefined ? "unexpected shape" : describe(result.error)
        deps.log(`startup adoption list unavailable: ${summary}`)
        return
      }
      const roots = data.filter((session) => session.time?.archived == null).slice(0, limit)
      for (const session of roots) {
        if (deps.state.get(session.id) !== undefined) continue
        await adoptRoot(session)
      }
    })
  }

  enumerate()
  return { resolve, adoptRoot }
}
