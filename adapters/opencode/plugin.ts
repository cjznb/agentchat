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
 * - `session.deleted`（根）/ `dispose` → `POST /internal/state {offline}`
 *
 * 所有事件处理入队即返回（fire-and-forget，串行保序），网络重试在后台推进，
 * 不阻塞宿主事件循环。详见 README.md。
 */
import {
  createHubClient,
  HubError,
  type AdapterState,
  type Hub,
  type RegisterArgs,
  type ResultItem,
  type WakeMessage,
} from "./hub"
import { readToken, resolveHome, tokenPath, writeToken } from "./token"
import type { Hooks, OpencodeEvent, OpencodeSession, Plugin, PluginInput } from "./types"
import { createTaskQueue, type TaskQueue } from "./util"

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
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  })
  const path = tokenPath(resolveHome(deps.env))
  const state: RuntimeState = { agentId: undefined, sessionToAgent: new Map(), lastState: new Map() }

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

  const rootRegister = async (session: OpencodeSession): Promise<void> => {
    const existing = readToken(path)
    const args: RegisterArgs = {
      vendor: ADAPTER_VENDOR,
      purpose: "coding-agent",
      ...(existing === undefined ? {} : { join_token: existing }),
    }
    try {
      const result = await hub.register(args)
      state.agentId = result.agentId
      state.sessionToAgent.set(session.id, result.agentId)
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

  const onCreated = async (session: OpencodeSession): Promise<void> => {
    if (session.parentID === undefined) {
      if (state.agentId === undefined) await rootRegister(session)
      else state.sessionToAgent.set(session.id, state.agentId)
      return
    }
    await childRegister(session)
  }

  const onStatus = async (sessionID: string, status: "idle" | "busy" | "retry"): Promise<void> => {
    const agentId = state.sessionToAgent.get(sessionID) ?? state.agentId
    if (agentId === undefined) return
    await reportState(agentId, status === "idle" ? "idle" : "busy")
  }

  const onIdle = async (sessionID: string): Promise<void> => {
    const agentId = state.sessionToAgent.get(sessionID) ?? state.agentId
    if (agentId === undefined) return
    // 回合末兜底：即使宿主只发 `session.idle`（未发 `session.status`），也保证报 idle。
    await reportState(agentId, "idle")
    let messages: readonly WakeMessage[]
    try {
      messages = (await hub.wake(agentId)).messages
    } catch (error) {
      log(`wake failed: ${describe(error)}`)
      return
    }
    if (messages.length === 0) return
    const items: ResultItem[] = []
    for (const message of messages) {
      try {
        await input.client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: formatInjection(message) }] },
        })
        items.push({ messageId: message.id, result: "delivered" })
      } catch (error) {
        log(`inject failed for ${message.id}: ${describe(error)}`)
        items.push({ messageId: message.id, result: "refused" })
      }
    }
    try {
      await hub.reportResult(agentId, items)
    } catch (error) {
      log(`result report failed: ${describe(error)}`)
    }
  }

  const onDeleted = async (session: OpencodeSession): Promise<void> => {
    const agentId = state.sessionToAgent.get(session.id)
    state.sessionToAgent.delete(session.id)
    if (session.parentID === undefined && agentId !== undefined) {
      await reportState(agentId, "offline")
    }
  }

  const dispatch = async (event: OpencodeEvent): Promise<void> => {
    switch (event.type) {
      case "session.created":
        await onCreated(event.properties.info)
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
      await queue.flush()
      if (state.agentId !== undefined) await reportState(state.agentId, "offline")
    },
  }
}

function formatInjection(message: WakeMessage): string {
  return [
    `[AgentChat] 来自 ${message.fromAgentId} 的消息（会话 ${message.conversationId}，消息 id ${message.id}）`,
    message.body,
    `（如需回复，请用 AgentChat 的 send 工具发给 ${message.fromAgentId}）`,
  ].join("\n")
}

function describe(error: unknown): string {
  if (error instanceof HubError) return `${error.kind}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** 宿主加载的插件导出（env 取 `process.env`，fetch 取全局 `fetch`）。 */
export const AgentChatPlugin: Plugin = createPluginHandle({
  env: process.env,
  fetch: globalThis.fetch,
}).plugin
