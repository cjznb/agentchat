/**
 * 会话收养与「会话即联系人」登记（缺陷修复 + 会话联系人特性）。
 *
 * **层级**：实例节点（根，`opencode@<host>`，join_token 认领）→ 会话节点（子，
 * `task_ref=session.id`，名字=会话标题）→ 子代理会话节点（子，父=其所属会话节点）。
 *
 * 两条收养路径（均复用 `task_ref` 幂等语义，绝不新建重复节点）：
 * - **A 懒收养**：任何带会话的事件指向未映射会话时，`client.session.get` 查询后登记：
 *   根会话父 = 实例节点；子代理父 = 其父会话节点（父未映射则跳过并 warn，**绝不回落实例**）。
 *   查询失败/404 亦保持跳过并 warn，不崩溃。
 * - **B 启动枚举**：初始化后 fire-and-forget 地 `client.session.list`（`roots`+`limit`，默认 5，
 *   `AGENTCHAT_ADOPT_LIMIT` 可覆盖；`AGENTCHAT_ADOPT=0` 关闭），客户端过滤 `time.archived` 后
 *   逐个按同一规则收为**实例节点的子节点**；`session.list` 不可用/报错即记录并静默降级，只保留 A。
 *
 * **标题同步**：每会话记录「上次已知标题」，仅当标题真的变化时重注册（`session.updated` 会频繁
 * touch，未变即 no-op，避免刷屏）；重注册靠 Hub 侧「重注册可更新卡片字段」（Part 1）落到名字。
 *
 * 依赖经 `AdoptDeps` 注入（避免与 `plugin.ts` 的模块环），状态经 `AdoptState` 读写映射表。
 *
 * **形状容错**：宿主 `client.session.get`/`list` 可能返回裸值，也可能返回 SDK 的
 * `{ data, error, request, response }` 包装（见 `sdk-result.ts` 实证）；统一经 `unwrapResult`
 * 解包后再走原逻辑。
 */
import { hostname } from "node:os"
import { describe } from "./flush"
import { unwrapResult } from "./sdk-result"
import type { Hub } from "./hub"
import type { OpencodeClient, OpencodeSession } from "./types"
import { isRecord } from "./util"

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

/** 取本机主机名；异常/空回落 `undefined`（调用方再回退可读名 `opencode`）。 */
export function resolveHostname(): string | undefined {
  try {
    const value = hostname()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

/** 实例节点可读名：`opencode@<host>`；主机名缺失/空白回退 `opencode`。 */
export function instanceName(host: string | undefined): string {
  const trimmed = host?.trim()
  return trimmed === undefined || trimmed === "" ? "opencode" : `opencode@${trimmed}`
}

/** 会话节点名：优先会话标题（trim 后非空）；否则 `opencode:<sessionid 前 8 位>`。 */
export function sessionName(session: OpencodeSession): string {
  const title = session.title?.trim()
  return title === undefined || title === "" ? `opencode:${session.id.slice(0, 8)}` : title
}

/**
 * 会话节点 `model`（发布类型未声明该字段，运行期形状不定）：字符串或 `{id}` 记录取其值，
 * 否则 `undefined`（调用方省略该字段，不写假值）。
 */
export function sessionModel(session: OpencodeSession): string | undefined {
  const value = session.model
  if (typeof value === "string") return value === "" ? undefined : value
  if (isRecord(value)) {
    const id = value["id"]
    if (typeof id === "string" && id !== "") return id
  }
  return undefined
}

/** `Session[]` 结构守卫：把解包后的 `unknown` 收窄为只读数组（非数组 = 不可用）。 */
function isSessionArray(value: unknown): value is readonly OpencodeSession[] {
  return Array.isArray(value)
}

/** 会话映射与标题台账（由 `plugin.ts` 的运行时状态实现）。 */
export interface AdoptState {
  /** sessionID → 会话节点 id。 */
  get(sessionID: string): string | undefined
  set(sessionID: string, agentId: string): void
  /** sessionID → 上次已知会话名（标题或回退名），用于仅标题变化时重注册。 */
  getTitle(sessionID: string): string | undefined
  setTitle(sessionID: string, name: string): void
}

export interface AdoptDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly client: OpencodeClient
  readonly hub: Hub
  readonly vendor: string
  readonly state: AdoptState
  /** 确保实例节点（根）已注册并返回其 id（含 join_token 认领与 token/id 落盘）。 */
  readonly ensureInstance: () => Promise<string | undefined>
  /** 与事件处理共用的串行队列（避免同一会话并发注册两次）。 */
  readonly enqueue: (task: () => Promise<void>) => void
  readonly log: (message: string) => void
}

export interface Adopter {
  /** A：解析 `sessionID` 的会话节点 id；未映射则查询并收养，失败返回 undefined。 */
  resolve(sessionID: string): Promise<string | undefined>
  /** 会话（根/子代理）登记为节点；已映射且标题未变则 no-op，父未定/失败返回 undefined。 */
  adoptSession(session: OpencodeSession): Promise<string | undefined>
}

/** 建收养器；构造即触发 B 的 fire-and-forget 启动枚举。 */
export function createAdopter(deps: AdoptDeps): Adopter {
  /** 父节点：根会话 → 实例节点；子代理 → 其父会话节点（未映射 = undefined，不回落实例）。 */
  const parentOf = async (session: OpencodeSession): Promise<string | undefined> => {
    if (session.parentID === undefined) return deps.ensureInstance()
    return deps.state.get(session.parentID)
  }

  /** 按 `task_ref=session.id` 登记/重登记会话节点（重注册可更新名字，见 Part 1）。 */
  const register = async (session: OpencodeSession): Promise<string | undefined> => {
    const parentId = await parentOf(session)
    if (parentId === undefined) {
      if (session.parentID === undefined) {
        deps.log(`session ${session.id} skipped: instance not registered`)
      } else {
        deps.log(`adopt child ${session.id} skipped: parent ${session.parentID} not mapped`)
      }
      return undefined
    }
    const name = sessionName(session)
    const model = sessionModel(session)
    try {
      const result = await deps.hub.register({
        vendor: deps.vendor,
        parent_ref: parentId,
        task_ref: session.id,
        name,
        ...(model === undefined ? {} : { model }),
      })
      deps.state.set(session.id, result.agentId)
      deps.state.setTitle(session.id, name)
      return result.agentId
    } catch (error) {
      deps.log(`session register failed for ${session.id}: ${describe(error)}`)
      return undefined
    }
  }

  /** 已映射：标题未变即 no-op；变了则重注册以更新名字（其余字段由已有节点保留）。 */
  const adoptSession = async (session: OpencodeSession): Promise<string | undefined> => {
    const mapped = deps.state.get(session.id)
    if (mapped === undefined) return register(session)
    if (deps.state.getTitle(session.id) === sessionName(session)) return mapped
    return register(session)
  }

  const resolve = async (sessionID: string): Promise<string | undefined> => {
    const mapped = deps.state.get(sessionID)
    if (mapped !== undefined) return mapped
    // **必须经接收者调用**：SDK 生成类的方法体读 `this._client`，解绑（`const get = …get`）会丢 `this`
    // 而抛 `undefined is not an object (evaluating 'this._client')`。故只做「方法存在」守卫，保留 `.get(...)` 形态。
    const sessionApi = deps.client.session
    if (sessionApi.get === undefined) {
      deps.log(`session lookup unavailable for ${sessionID}; skipped`)
      return undefined
    }
    let raw: unknown
    try {
      raw = await sessionApi.get({ path: { id: sessionID } })
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
    return adoptSession(session)
  }

  const enumerate = (): void => {
    if (!isAdoptEnabled(deps.env)) return
    const limit = parseAdoptLimit(deps.env["AGENTCHAT_ADOPT_LIMIT"])
    deps.enqueue(async () => {
      // **必须经接收者调用**（同 `resolve`）：解绑 SDK 方法会丢 `this` 而抛 `this._client` 未定义。
      const sessionApi = deps.client.session
      if (sessionApi.list === undefined) {
        deps.log("startup adoption skipped: session.list unavailable")
        return
      }
      let raw: unknown
      try {
        raw = await sessionApi.list({ query: { scope: "project", roots: true, limit } })
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
        await adoptSession(session)
      }
    })
  }

  enumerate()
  return { resolve, adoptSession }
}
