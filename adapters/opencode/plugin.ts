/**
 * AgentChat OpenCode 插件（进程外适配器，spec §7/§10）。
 *
 * 只经 HTTP 契约与 Hub 通信（不 import server 代码）。层级：**实例节点（根，`opencode@<host>`，
 * join_token 认领）→ 会话节点（子，`task_ref=session.id`，名字=会话标题）→ 子代理会话节点**：
 * - 首次需要时 MCP `register` 认领**实例节点**（无 token 首注册并把返回的 `join_token`
 *   写 `<home>/agents/opencode.token`；有 token 重连认领）。实例 id 落 `<home>/agents/opencode.id`
 *   供本地 MCP 桥作**回退出站身份**；实际出站身份**按会话**：`tool.execute.before` 把 `sessionID`
 *   注入工具入参 → 桥剥离并转 `x-agentchat-session` 头 → Hub 按会话节点 `task_ref` 解析
 *   （否则一进程一个 MCP 连接会让所有调用记在实例容器名下）。
 * - `session.created` / `session.updated`（根或子）→ MCP `register{parent_ref, task_ref, name}`
 *   收/改会话节点（根父=实例节点，子代理父=其所属会话节点）；标题变化才重注册（`adopt.ts`）。
 * - `session.status`（回合始/末）→ `POST /internal/state {busy|idle}`（**按会话节点 id**；
 *   同时对**实例节点**做一次同态上报 —— 实例是根容器，靠搭车 touch 刷新 `last_seen`）
 * - `session.idle` → `POST /internal/wake` → 经 `client.session.promptAsync` 逐条注入
 *   → `POST /internal/result {items:[{messageId, result:"delivered"|"refused"}]}`（**按会话节点 id**）
 * - idle 期间**周期轮询**（默认 10s，`AGENTCHAT_POLL_MS` 覆盖）：消息在「已经 idle 之后」
 *   到达时无事件可依，靠轮询补拉；走与 `session.idle` **同一**路径（每轮同时对实例节点
 *   同态心跳，防根容器从不心跳被判 offline），`messageId` 有界去重防重复注入；
 *   转 busy 即停、`dispose` 清理（见 `poll.ts`）。
 * - `session.deleted` → `POST /internal/retire`（**按会话节点 id 退役，绝不报 offline**）
 * - `dispose` → `POST /internal/state {offline}`（**实例节点**是根，报 offline 合规）
 *
 * 所有事件处理入队即返回（fire-and-forget，串行保序），网络重试在后台推进，
 * 不阻塞宿主事件循环。详见 README.md。
 */
import { createAdopter, instanceName, resolveHostname } from "./adopt"
import { createIdleFlush, describe } from "./flush"
import {
  createHubClient,
  HubToolError,
  type AdapterState,
  type Hub,
  type RegisterArgs,
  type RegisterResult,
} from "./hub"
import { resolveHome } from "./home"
import { createFileLog } from "./log"
import { IdlePoller, parsePollMs } from "./poll"
import { injectSessionHint } from "./session-hint"
import { agentIdPath, clearToken, readToken, tokenPath, writeToken } from "./token"
import type { Hooks, OpencodeEvent, Plugin, PluginInput } from "./types"
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
  // 默认诊断落 `<home>/logs/opencode-adapter.log`（绝不污染宿主终端；`AGENTCHAT_LOG=console` 回退）。
  const log = deps.log ?? createFileLog(deps.env, "plugin")
  const plugin: Plugin = async (input) => createRuntime(deps, input, queue, log)
  return { plugin, flush: () => queue.flush() }
}

interface RuntimeState {
  /** 实例节点 id（根，`opencode@<host>`）：MCP 出站身份 + 会话节点的父。 */
  instanceAgentId: string | undefined
  /** sessionID → 会话节点 id（层级 实例 → 会话 → 子代理）。 */
  readonly sessionToAgent: Map<string, string>
  /** sessionID → 上次已知会话名（名字随标题漂移时仅真正变化才重注册）。 */
  readonly sessionTitles: Map<string, string>
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
    instanceAgentId: undefined,
    sessionToAgent: new Map(),
    sessionTitles: new Map(),
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
   * 同时对**实例节点（根容器）**做一次同态心跳：实例自身从不上报状态、只在 register 时
   * touch 一次，不搭车心跳就会超阈值被 roster 判 offline（子节点还活着的「假离线」根因）。
   */
  const heartbeatIdle = async (agentId: string): Promise<void> => {
    try {
      await hub.reportState(agentId, "idle")
      state.lastState.set(agentId, "idle")
    } catch (error) {
      log(`idle heartbeat failed: ${describe(error)}`)
    }
    await reportInstance("idle", true)
  }

  /**
   * 实例节点（根容器）同态上报：会话状态上报与空闲轮询心跳时顺带触碰一次，
   * id 复用 `state.instanceAgentId`（**绝不**上报父节点，避免子代理会话放大调用量）。
   * - 状态上报路径走去重（同态即心跳，重复信号无需再发 —— `同态去重已有`）；
   * - `always`（空闲轮询心跳）不走去重：心跳必须周期性发出才能刷新 `last_seen`。
   */
  const reportInstance = async (next: AdapterState, always = false): Promise<void> => {
    const instanceId = state.instanceAgentId
    if (instanceId === undefined) return
    if (!always && state.lastState.get(instanceId) === next) return
    try {
      await hub.reportState(instanceId, next)
      state.lastState.set(instanceId, next)
    } catch (error) {
      log(`instance state ${next} failed: ${describe(error)}`)
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

  /** 实例节点（根）注册入参：可读名 `opencode@<host>`，主机名缺失回退 `opencode`；
   * `role_tag="container"` 标记其为分组容器（不是聊天对象，spec §11.2 Task 2）。 */
  const registerArgs = (joinToken: string | undefined): RegisterArgs => ({
    vendor: ADAPTER_VENDOR,
    purpose: "coding-agent",
    name: instanceName(resolveHostname()),
    role_tag: "container",
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

  /**
   * 确保实例节点（根，`opencode@<host>`）已注册：读/写 join_token 与 id 文件；成功后返回其 id。
   *
   * 实例节点是 **MCP 出站身份**（`<home>/agents/opencode.id`）与会话节点的父；每个会话都是它的
   * 子节点（投递/状态按会话节点，不用实例 id）。
   */
  const registerInstance = async (): Promise<string | undefined> => {
    if (state.instanceAgentId !== undefined) return state.instanceAgentId
    const existing = readToken(path)
    try {
      const result = await registerRootAgent(existing)
      state.instanceAgentId = result.agentId
      const idWritten = writeToken(idPath, result.agentId)
      if (!idWritten.ok) log(`agent id write failed (continuing): ${idWritten.error ?? "unknown"}`)
      if (result.joinToken !== undefined) {
        const written = writeToken(path, result.joinToken)
        if (!written.ok) log(`token write failed (continuing): ${written.error ?? "unknown"}`)
      }
      return result.agentId
    } catch (error) {
      log(`root register failed: ${describe(error)}`)
      return undefined
    }
  }

  /**
   * 会话节点退役（`session.deleted` 与**会话归档**共用）：停轮询 + 清映射 + `/internal/retire`
   * （幂等，`404` 视为已退役）。会话节点皆为实例节点的**子节点**：退役**绝不报 offline**
   * （子节点 offline 会被 Hub `409 child_never_offline` 拒绝），且退役后不再往该会话注入。
   */
  const retireSession = async (sessionID: string): Promise<void> => {
    const agentId = state.sessionToAgent.get(sessionID)
    stopPolling(sessionID)
    state.sessionToAgent.delete(sessionID)
    state.sessionTitles.delete(sessionID)
    if (agentId === undefined) return
    state.lastState.delete(agentId)
    try {
      await hub.retire(agentId)
    } catch (error) {
      log(`retire failed for ${agentId}: ${describe(error)}`)
    }
  }

  // 收养器：A 懒收养 + B 启动枚举（构造即 fire-and-forget 枚举，不阻塞宿主）。配置见 README。
  const adopter = createAdopter({
    env: deps.env, client: input.client, hub, vendor: ADAPTER_VENDOR,
    state: {
      get: (id) => state.sessionToAgent.get(id),
      set: (id, a) => state.sessionToAgent.set(id, a),
      getTitle: (id) => state.sessionTitles.get(id),
      setTitle: (id, name) => state.sessionTitles.set(id, name),
    },
    ensureInstance: registerInstance, retire: retireSession,
    enqueue: (task) => queue.push(task), log,
  })

  const onStatus = async (sessionID: string, status: "idle" | "busy" | "retry"): Promise<void> => {
    // 未映射会话先尝试懒收养（已存在/被恢复的会话不会再发 `session.created`）；仍失败才跳过并 warn。
    const agentId = await adopter.resolve(sessionID)
    if (agentId === undefined) {
      log(`status for unmapped session ${sessionID}; skipped`)
      return
    }
    const next = status === "idle" ? "idle" : "busy"
    await reportState(agentId, next)
    await reportInstance(next) // 每次会话状态上报同时对实例节点做同态上报（实例是根，touch 即心跳）
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

  const dispatch = async (event: OpencodeEvent): Promise<void> => {
    switch (event.type) {
      // 建会话即登记为实例节点的子节点；被恢复/改标题的旧会话经 `session.updated` 收养或改名；
      // **归档会话**（`time.archived`）在 `adoptSession` 内被拦下：未映射不注册、已映射即退役。
      case "session.created":
      case "session.updated":
        await adopter.adoptSession(event.properties.info)
        return
      case "session.status":
        await onStatus(event.properties.sessionID, event.properties.status.type)
        return
      case "session.idle":
        await onIdle(event.properties.sessionID)
        return
      case "session.deleted":
        await retireSession(event.properties.info.id)
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
    // 出站身份按**会话**归属（M2）：注入当前会话 id，桥剥离并转请求头，Hub 按会话节点解析发送方。
    // 实现与红线（只原地改、非对象跳过、绝不抛）见 `session-hint.injectSessionHint`。
    "tool.execute.before": (input, output) => injectSessionHint(input.tool, input.sessionID, output.args, log),
    dispose: async () => {
      for (const poller of state.pollers.values()) poller.stop()
      state.pollers.clear()
      await queue.flush()
      // 实例节点是根：dispose 报 offline（会话节点是子节点，已随事件退役，不在此列）。
      if (state.instanceAgentId !== undefined) await reportState(state.instanceAgentId, "offline")
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
