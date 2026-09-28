/**
 * AgentChat OpenCode 插件（进程外适配器，spec §7/§10）。
 *
 * 只经 HTTP 契约与 Hub 通信（不 import server 代码）：
 * - `session.created`（根）→ MCP `register`（无 token 首注册并把返回的 `join_token`
 *   写 `<home>/agents/opencode.token`；有 token 重连认领）
 * - `session.created`（子，`info.parentID` 存在）→ MCP `register{parent_ref, task_ref}`
 * - `session.status`（回合始/末）→ `POST /internal/state {busy|idle}`
 * - `session.idle` → `POST /internal/wake` → 经 `client.session.promptAsync` 逐条注入
 *   → `POST /internal/result {items:[{messageId, result:"delivered"|"refused"}]}`
 * - idle 期间**周期轮询**（默认 10s，`AGENTCHAT_POLL_MS` 覆盖）：消息在「已经 idle 之后」
 *   到达时无事件可依，靠轮询补拉；走与 `session.idle` **同一**路径，`messageId` 有界去重防重复注入；
 *   转 busy 即停、`dispose` 清理（见 `poll.ts`）。
 * - `session.deleted`（根）/ `dispose` → `POST /internal/state {offline}`
 *
 * 所有事件处理入队即返回（fire-and-forget，串行保序），网络重试在后台推进，
 * 不阻塞宿主事件循环。详见 README.md。
 */
import { createAdopter } from "./adopt"
import { createIdleFlush, describe } from "./flush"
import {
  createHubClient,
  HubToolError,
  type AdapterState,
  type Hub,
  type RegisterArgs,
  type RegisterResult,
} from "./hub"
import { IdlePoller, parsePollMs } from "./poll"
import { agentIdPath, clearToken, readToken, resolveHome, tokenPath, writeToken } from "./token"
import type { Hooks, OpencodeEvent, OpencodeSession, Plugin, PluginInput } from "./types"
import { createBoundedSet, createTaskQueue, type BoundedSet, type TaskQueue } from "./util"

export const ADAPTER_VENDOR = "opencode"

export interface PluginDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof fetch
  readonly log?: (message: string) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
}

export interface PluginHandle {
  readonly plugin: Plugin
  /** 等待已入队的事件处理全部完成（测试用；宿主不需要）。 */
  flush(): Promise<void>
}

/**
 * 建插件句柄：`plugin` 供宿主 OpenCode 调用，`flush` 供测试等待后台队列排空。
 * 队列在句柄级创建，使测试可在插件实例化后确定性地等待处理完成。
 */
export function createPluginHandle(deps: PluginDeps): PluginHandle {
  const queue = createTaskQueue()
  const log = deps.log ?? ((message: string) => console.error(`[agentchat-opencode] ${message}`))
  const plugin: Plugin = async (input) => createRuntime(deps, input, queue, log)
  return { plugin, flush: () => queue.flush() }
}

interface RuntimeState {
  agentId: string | undefined
  readonly sessionToAgent: Map<string, string>
  readonly lastState: Map<string, AdapterState>
  /** 已成功注入的 messageId 去重集合（有界 FIFO）：Hub 的在途租约重投不重复注入。 */
  readonly seenMessages: BoundedSet
  /** 各 idle 会话的空闲轮询器（消息在「已经 idle 之后」到达时无事件可依，靠它补拉）。 */
  readonly pollers: Map<string, IdlePoller>
}

function createRuntime(
  deps: PluginDeps,
  input: PluginInput,
  queue: TaskQueue,
  log: (message: string) => void,
): Hooks {
  const hub: Hub = createHubClient({
    env: deps.env,
    fetch: deps.fetch,
    log,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  })
  const path = tokenPath(resolveHome(deps.env))
  const idPath = agentIdPath(resolveHome(deps.env))
  const pollMs = parsePollMs(deps.env["AGENTCHAT_POLL_MS"])
  const state: RuntimeState = {
    agentId: undefined,
    sessionToAgent: new Map(),
    lastState: new Map(),
    seenMessages: createBoundedSet(256),
    pollers: new Map(),
  }

  /** 上报状态并去重同态（同态即心跳，重复信号无需再发）；失败不记账以便下次重试。 */
  const reportState = async (agentId: string, next: AdapterState): Promise<void> => {
    if (state.lastState.get(agentId) === next) return
    try {
      await hub.reportState(agentId, next)
      state.lastState.set(agentId, next)
    } catch (error) {
      log(`state ${next} failed: ${describe(error)}`)
    }
  }

  /**
   * idle 心跳：**每次**都上报（同态上报在 Hub 侧即 `touchAgent`），刷新 `last_seen`，
   * 修复「长时间空闲被判 offline」；与 `reportState` 的同态去重刻意不同（心跳需要周期性发出）。
   */
  const heartbeatIdle = async (agentId: string): Promise<void> => {
    try {
      await hub.reportState(agentId, "idle")
      state.lastState.set(agentId, "idle")
    } catch (error) {
      log(`idle heartbeat failed: ${describe(error)}`)
    }
  }

  /** 与 `session.idle` 事件完全同一路径的拉取闭环（供事件与空闲轮询共用）。 */
  const flush = createIdleFlush({
    hub,
    client: input.client,
    seen: state.seenMessages,
    heartbeat: heartbeatIdle,
    log,
  })

  const stopPolling = (sessionID: string): void => {
    state.pollers.get(sessionID)?.stop()
    state.pollers.delete(sessionID)
  }

  /** 会话进入 idle 时启动（幂等）；每轮走与 idle 事件同一的 `flush` 拉取路径。 */
  const ensurePolling = (sessionID: string, agentId: string): void => {
    if (state.pollers.has(sessionID)) return
    const poller = new IdlePoller({ intervalMs: pollMs, run: () => flush(sessionID, agentId) })
    state.pollers.set(sessionID, poller)
    poller.start()
  }

  const registerArgs = (joinToken: string | undefined): RegisterArgs => ({
    vendor: ADAPTER_VENDOR,
    purpose: "coding-agent",
    ...(joinToken === undefined ? {} : { join_token: joinToken }),
  })

  /**
   * 陈旧 token（Hub DB 重置/切换）→ `invalid_join_token`（语义：`getAgentByTokenHash` 查无此人）
   * 安全回退：清空本地 token 后按「无 token 首次注册」重新注册为根；此时不存在可重复的根。
   */
  const registerRootAgent = async (existing: string | undefined): Promise<RegisterResult> => {
    try {
      return await hub.register(registerArgs(existing))
    } catch (error) {
      if (
        existing === undefined ||
        !(error instanceof HubToolError) ||
        error.code !== "invalid_join_token"
      ) {
        throw error
      }
      const cleared = clearToken(path)
      // 注意：**不要**删除 `<home>/agents/opencode.id`。旧实现连带清除它，而 OpenCode 配置曾以
      // `{file:…opencode.id}` 引用该文件：文件缺失会让 OpenCode 在解析配置前就致命失败（无法启动），
      // 于是插件再也不会注册、文件永不生成 —— 死锁。注册成功后下方 `writeToken(idPath, …)` 会覆盖为
      // 正确 id，故这里保留旧 id 即可打断「删除→砖」的连锁。
      log(
        `stale join_token rejected; re-registering as a new root${
          cleared.ok ? "" : ` (token clear failed: ${cleared.error ?? "unknown"})`
        }`,
      )
      return hub.register(registerArgs(undefined))
    }
  }

  const rootRegister = async (session: OpencodeSession): Promise<void> => {
    const existing = readToken(path)
    try {
      const result = await registerRootAgent(existing)
      state.agentId = result.agentId
      state.sessionToAgent.set(session.id, result.agentId)
      const idWritten = writeToken(idPath, result.agentId)
      if (!idWritten.ok) log(`agent id write failed (continuing): ${idWritten.error ?? "unknown"}`)
      if (result.joinToken !== undefined) {
        const written = writeToken(path, result.joinToken)
        if (!written.ok) log(`token write failed (continuing): ${written.error ?? "unknown"}`)
      }
    } catch (error) {
      log(`root register failed: ${describe(error)}`)
    }
  }

  const childRegister = async (session: OpencodeSession): Promise<void> => {
    const mapped = session.parentID === undefined ? undefined : state.sessionToAgent.get(session.parentID)
    // ② 父子关联兜底：事件无可用父映射时，按「当前根（父回合窗口）」关联。
    const parentAgentId = mapped ?? state.agentId
    if (parentAgentId === undefined) {
      log(`child session ${session.id} seen before any root registration; skipped`)
      return
    }
    try {
      const result = await hub.register({
        vendor: ADAPTER_VENDOR,
        parent_ref: parentAgentId,
        task_ref: session.id,
      })
      state.sessionToAgent.set(session.id, result.agentId)
    } catch (error) {
      log(`child register failed for ${session.id}: ${describe(error)}`)
    }
  }

  // 收养器：A 懒收养 + B 启动枚举（构造即 fire-and-forget 枚举，不阻塞宿主）。配置见 README。
  const adopter = createAdopter({
    env: deps.env, client: input.client, hub, vendor: ADAPTER_VENDOR,
    state: { get: (id) => state.sessionToAgent.get(id), set: (id, a) => state.sessionToAgent.set(id, a), rootAgentId: () => state.agentId },
    rootRegister, enqueue: (task) => queue.push(task), log,
  })

  const onCreated = async (session: OpencodeSession): Promise<void> => {
    if (session.parentID === undefined) {
      await adopter.adoptRoot(session)
      return
    }
    await childRegister(session)
  }

  const onStatus = async (sessionID: string, status: "idle" | "busy" | "retry"): Promise<void> => {
    // 未映射会话先尝试懒收养（已存在/被恢复的会话不会再发 `session.created`）；仍失败才跳过并 warn。
    const agentId = await adopter.resolve(sessionID)
    if (agentId === undefined) {
      log(`status for unmapped session ${sessionID}; skipped`)
      return
    }
    const next = status === "idle" ? "idle" : "busy"
    await reportState(agentId, next)
    if (next === "idle") ensurePolling(sessionID, agentId)
    else stopPolling(sessionID)
  }

  const onIdle = async (sessionID: string): Promise<void> => {
    // 未映射会话先尝试懒收养；仍失败才跳过并 warn（不回落根，避免「给根取件、往子会话注入」）。
    const agentId = await adopter.resolve(sessionID)
    if (agentId === undefined) {
      log(`idle for unmapped session ${sessionID}; skipped`)
      return
    }
    // 回合末兜底：即使宿主只发 `session.idle`（未发 `session.status`），也保证报 idle。
    await flush(sessionID, agentId)
    // 已 idle：启动空闲轮询，补拉「本轮 idle 之后」才到达的消息（无新事件可依）。
    ensurePolling(sessionID, agentId)
  }

  const onDeleted = async (session: OpencodeSession): Promise<void> => {
    const agentId = state.sessionToAgent.get(session.id)
    stopPolling(session.id)
    state.sessionToAgent.delete(session.id)
    if (agentId === undefined) return
    if (session.parentID === undefined) {
      await reportState(agentId, "offline")
      return
    }
    // 子会话消失 → 退役子节点（不可复活；Hub 侧取消待投递 job），
    // 避免名单残留与向已死参与者投递。根保持既有 offline 语义，不退役。
    state.lastState.delete(agentId)
    try {
      await hub.retire(agentId)
    } catch (error) {
      log(`retire failed for ${agentId}: ${describe(error)}`)
    }
  }

  const dispatch = async (event: OpencodeEvent): Promise<void> => {
    switch (event.type) {
      case "session.created":
        await onCreated(event.properties.info)
        return
      // 被恢复的旧会话一旦被使用（touch/setTitle 等）就会发 `session.updated`：借它懒收养。
      case "session.updated":
        await adopter.resolve(event.properties.info.id)
        return
      case "session.status":
        await onStatus(event.properties.sessionID, event.properties.status.type)
        return
      case "session.idle":
        await onIdle(event.properties.sessionID)
        return
      case "session.deleted":
        await onDeleted(event.properties.info)
        return
      // OpenCode 事件面很宽；其余事件与本适配器无关，刻意忽略。
      default:
        return
    }
  }

  return {
    event: async ({ event }) => {
      queue.push(() => dispatch(event))
    },
    dispose: async () => {
      for (const poller of state.pollers.values()) poller.stop()
      state.pollers.clear()
      await queue.flush()
      if (state.agentId !== undefined) await reportState(state.agentId, "offline")
    },
  }
}

/** 宿主加载的插件导出（env 取 `process.env`，fetch 取全局 `fetch`）。 */
export const AgentChatPlugin: Plugin = createPluginHandle({
  env: process.env,
  fetch: globalThis.fetch,
}).plugin

/**
 * OpenCode 期望的插件模块形态（`@opencode-ai/plugin` 的 `PluginModule`）。
 *
 * 依据 OpenCode 1.18.32 加载器（`plugin/index.ts` + `plugin/shared.ts`）：
 * - `readV1Plugin` **只读 `mod.default`**，要求其为含 `server()` 函数的记录，取其 `server`；
 * - **文件来源**插件（本地路径）必须带 `id`，否则 `resolvePluginId` 抛 `must export id`；
 * - 回退（legacy）路径遍历模块全部导出并要求皆为函数——本模块另有 `ADAPTER_VENDOR` 字符串导出，
 *   故必须命中 v1 探测（提供 `default`）而非 legacy 回退。
 *
 * 因此默认导出 `{ id, server }`。`plugin` 配置项指向本目录时即按此形态加载。
 */
export interface AgentChatPluginModule {
  readonly id: string
  readonly server: Plugin
}

export const AgentChatPluginModule: AgentChatPluginModule = {
  id: "agentchat",
  server: AgentChatPlugin,
}

export default AgentChatPluginModule
