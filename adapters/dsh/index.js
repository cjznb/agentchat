/**
 * AgentChat DSH 适配器（bundle 主机插件入口；DSH 版对应 `adapters/opencode/plugin.ts`）。
 *
 * 只经 HTTP 契约与 Hub 通信（**不 import 本仓 server 代码**）。层级与 OpenCode 适配器一致：
 * **实例节点（根容器 `dsh@<host>`，`role_tag=container`）
 * → 会话节点（子，`task_ref=<session.header.id>`）→ 子代理会话节点（`header.origin==='subagent'`）**。
 *
 * **出站身份与双向通信**：MCP 桥的 `x-agent-id` 需要是**会话节点**才是可回复的聊天对象（Hub 拒绝
 * 以容器为收件方的 DM）。桥自 `<home>/agents/dsh.current` 逐请求取该身份，本插件负责维护它：
 * 恰好一个**顶层会话**存活时写该会话节点 id，0 个或 ≥2 个时删除（桥回落实例容器 id）。详见
 * `lib/session-hint.js`。
 *
 * 事件映射（DSH 扩展点，核实自安装包的 `lib/types`，见 `docs/harness-api-notes.md`）：
 * - `agent/created`  → 懒注册实例节点；把该会话注册为子节点并上报 `online`
 * - `agent/status`   → `running` 上报 `busy` 并停轮询；`idle` 上报 `idle` 并启动空闲轮询
 * - `agent/disposed` → **只停本地跟踪，不退役**（见下）
 * - 空闲轮询         → 与 idle 状态**同一 `flush` 路径**（消息在「已经 idle 之后」到达时无事件可依）
 * - 插件卸载         → 停轮询 + 实例节点（根）上报 `offline`
 *
 * **为何 disposed 不退役**：Hub 的 `registerChild` 按 `task_ref` **收养**既有节点（同 id 重连认领），
 * 但**已退役节点会永久拒绝同 `task_ref` 的再注册**（`RegistrationError("retired")`）。DSH 的
 * `agent/disposed` 表示「agent 离开注册表」（关闭/切走会话也会触发），而 DSH 没有「会话被删除」事件——
 * 一旦在这里退役，用户重新打开同一会话就再也不能注册（单向门）。故此处只停跟踪；失联节点由 Hub 的
 * `last_seen` 阈值自然判 offline。`hub.retire` 仍保留在 `lib/hub.js` 供将来有明确删除事件时使用。
 *
 * 唤醒语义（核实自 `dsh-agent-loop` 运行时）：`agent.followup(msg)` = 开新回合并唤醒驱动；
 * `agent.steer(msg)` = 就近 step 边界交付并唤醒；`agent.inject(msg)` **不唤醒**（故不用于取件）。
 * 注入消息来源取 `{kind:'plugin:agentchat', form:'relay'}`（语义：另一个 agent 发来的消息；**不能**用 v4 已废弃的 `kind:'plugin'` 包装——会话格式校验会直接拒绝整轮）。
 *
 * 纪律：所有事件处理都**不阻塞宿主**——异步工作自行捕获异常并落日志，绝不冒泡到宿主事件循环。
 */

import { backfillSessions } from "./lib/backfill.js"
import { createIdleFlush } from "./lib/flush.js"
import { resolveHome } from "./lib/home.js"
import { createHubClient, HubToolError, resolveHubConfig } from "./lib/hub.js"
import { createFileLog } from "./lib/log.js"
import { createMessageBuilder } from "./lib/message.js"
import { IdlePoller, parsePollMs } from "./lib/poll.js"
import { registerWithNameRetry } from "./lib/register.js"
import { createRegistrationRetry } from "./lib/retry.js"
import { createTitleSync } from "./lib/title.js"
import { ADAPTER_VENDOR, createSessionHint, instanceName, sessionName } from "./lib/session-hint.js"
import { agentIdPath, clearToken, readToken, tokenPath, writeToken } from "./lib/token.js"
import { createBoundedSet, createGuard, describe, isRecord } from "./lib/util.js"

/** 插件名（DSH bundle 行与日志前缀）。 */
export const name = "agentchat"

/** 依赖的宿主服务：`agents` 注册表（加载期回填需要 `ctx.agents.list()`）；缺失时插件不激活。 */
export const inject = ["agents"]

/** 本适配器的 Hub 厂商 id（`agents.vendor`；定义在 `lib/session-hint.js`，此处再导出保持公开面）。 */
export { ADAPTER_VENDOR }

/** 已注入 messageId 去重集合上限（Hub 在途租约重投不重复注入）。 */
const SEEN_LIMIT = 256

/** 未注册会话的补注册重试间隔（`config.retryMs` 可覆盖；`IdlePoller` 失败时指数退避到 60s）。 */
const RETRY_MS = 15_000

/**
 * 插件入口：注册实例/会话节点、镜像状态、空闲取件注入。所有资源用 `ctx.on` / `ctx.effect`
 * 注册，卸载时由 Cordis 自动释放；实例节点（根）在释放时上报 `offline`。
 *
 * @param {object} ctx Cordis 上下文（DSH Host）
 * @param {object} [config] bundle 行 `config`：`pollMs`（覆盖 `AGENTCHAT_POLL_MS`）、
 *   `name`（覆盖实例节点可读名 `dsh@<host>`，同一台机器跑多个不同 `AGENTCHAT_HOME` 的实例时用它避重名）
 */
export function apply(ctx, config) {
  const cfg = isRecord(config) ? config : {}
  const env = process.env
  const home = resolveHome(env)
  const log = createFileLog(env, "plugin")
  const hub = createHubClient({ env, fetch: globalThis.fetch, log })
  const pollMs = parsePollMs(
    cfg["pollMs"] === undefined ? env["AGENTCHAT_POLL_MS"] : String(cfg["pollMs"]),
  )
  const tokenFile = tokenPath(home)
  const idFile = agentIdPath(home)
  const seen = createBoundedSet(SEEN_LIMIT)

  /** sessionId → { nodeId, agent, busy }；`busy` 决定注入用 followup 还是 steer。 */
  const sessions = new Map()
  /**
   * sessionId → agent：**见过的**会话（加载期回填 + `agent/created`/`agent/status`）。
   * 用于补注册重试：Hub 抖动导致注册失败时，靠它按自己的节奏重试，而不必等下一次回合事件。
   */
  const known = new Map()
  /**
   * sessionId → `{ agent, promise }`：进行中的注册（**同一 agent** 的并发事件合并为一次注册；
   * 会话重开后是新 agent，故走新注册，旧注册据 `pending` 归属把自己作废）。
   */
  const pending = new Map()
  /** 各空闲会话的轮询器。 */
  const pollers = new Map()
  /** nodeId → 最近一次上报状态（同态去重；心跳走 `always`）。 */
  const lastState = new Map()
  /**
   * 会话身份提示（`agents/dsh.current`）与 disposed/重开标记：见 `lib/session-hint.js`。
   * 「顶层会话」= 挂实例节点下的会话（子代理 `origin==='subagent'` 与已知父会话的 fork 都不算）。
   */
  const hint = createSessionHint(home, SEEN_LIMIT, (message) => log(message))
  let instanceAgentId

  const warn = (message) => {
    log(message)
    try {
      ctx.logger?.warn?.(`agentchat: ${message}`)
    } catch {
      // 宿主日志失败不得影响适配器
    }
  }

  /** 实例节点注册参数（根 + 容器标记；join_token 认领重连）。 */
  const rootArgs = (joinToken) => ({
    vendor: ADAPTER_VENDOR,
    purpose: "coding-agent",
    name: instanceName(cfg["name"]),
    role_tag: "container",
    ...(joinToken === undefined ? {} : { join_token: joinToken }),
  })

  /**
   * 陈旧 join_token（Hub 数据重置/换库）→ `invalid_join_token`：清本地 token 后按首次注册重来。
   * 此时不存在可重复的根，故安全；**不删** `<home>/agents/dsh.id`（MCP 桥的出站身份文件）。
   */
  async function registerRoot(existing) {
    try {
      return await hub.register(rootArgs(existing))
    } catch (error) {
      if (existing === undefined || !(error instanceof HubToolError) || error.code !== "invalid_join_token") {
        throw error
      }
      const cleared = clearToken(tokenFile)
      warn(`join_token 失效，按首次注册重建根节点${cleared.ok ? "" : `（token 清理失败：${cleared.error ?? "unknown"}`}`)
      return hub.register(rootArgs(undefined))
    }
  }

  /**
   * 确保实例节点已注册（幂等）；失败返回 `undefined` 并降级为「本次不注册会话节点」。
   *
   * **在途合并**：加载期回填与并发的 `agent/created` 会同时调用本函数；若不合并在途请求，
   * 两个并发的根注册会争同一名字（`dsh@<host>`）——后到者被 Hub 判 `name_taken`，于是多出一个
   * 带哈希后缀的"伪根"。故共享同一次在途注册（与 `lib/session-hint.js` 的 `published` 同为
   * 「同一事实只提交一次」的纪律）。
   */
  let instancePending
  async function registerInstance() {
    if (instanceAgentId !== undefined) return instanceAgentId
    if (instancePending !== undefined) return instancePending
    instancePending = (async () => {
      const existing = readToken(tokenFile)
      try {
        const result = await registerRoot(existing)
        instanceAgentId = result.agentId
        const idWrite = writeToken(idFile, result.agentId)
        if (!idWrite.ok) warn(`实例 id 写入失败（继续）：${idWrite.error ?? "unknown"}`)
        if (result.joinToken !== undefined) {
          const tokenWrite = writeToken(tokenFile, result.joinToken)
          if (!tokenWrite.ok) warn(`join_token 写入失败（继续）：${tokenWrite.error ?? "unknown"}`)
        }
        return result.agentId
      } catch (error) {
        warn(`实例节点注册失败：${describe(error)}`)
        return undefined
      } finally {
        instancePending = undefined
      }
    })()
    return instancePending
  }

  /** 状态上报（同态去重视为心跳触碰；`always` 用于轮询心跳必须周期性发出）。 */
  async function reportState(nodeId, next, always = false) {
    if (nodeId === undefined) return
    if (!always && lastState.get(nodeId) === next) return
    try {
      await hub.reportState(nodeId, next)
      lastState.set(nodeId, next)
    } catch (error) {
      warn(`状态 ${next} 上报失败（${nodeId}）：${describe(error)}`)
    }
  }

  /**
   * 实例节点（根容器）同态上报：**会话状态上报与空闲心跳都搭车触碰一次**（与
   * `adapters/opencode/plugin.ts` 的 `reportInstance` 同语义）。
   *
   * 为什么必须搭车：实例节点自己从不上报状态，只在注册时 touch 一次；一个长时间 `busy`
   * （或长期不 idle）的会话若不搭车心跳，容器会先被 roster 的 `last_seen` 阈值判 offline——
   * 这正是「子节点还活着但根显示离线」的假离线根因。
   * `always`（空闲轮询心跳）不走去重：心跳必须周期性发出才能刷新 `last_seen`。
   */
  async function reportInstance(next, always = false) {
    await reportState(instanceAgentId, next, always)
  }

  /** 取件心跳：会话节点 + 实例节点（根容器不搭车心跳会被判 offline）。 */
  async function heartbeat(nodeId) {
    await reportState(nodeId, "idle", true)
    await reportInstance("idle", true)
  }

  /** 会话标题 → Hub 展示名（`custom_name`；`name` 不动）：见 `lib/title.js`。`config.titleAsName: false` 可关。 */
  const syncTitle = createTitleSync({ ctx, hub, log: warn, enabled: cfg["titleAsName"] !== false })

  /** 注入消息工厂（宿主 `createUserMessage` → profile 农场绝对路径 → 最小 UserMessage 兜底）。 */
  const buildMessage = createMessageBuilder(env, warn)

  /**
   * 注入入口（`flush` 的唯一宿主相关操作）：把认领到的消息交给该会话的 agent。
   * 空闲 → `followup`（开新回合并唤醒）；运行中 → `steer`（下一个 step 边界即见）。
   * 抛错/找不到 agent 一律 `refused`（不写 `seen`，下次仍会尝试）。
   */
  async function deliver(sessionId, texts) {
    const entry = sessions.get(sessionId)
    if (entry === undefined) {
      warn(`注入失败：会话 ${sessionId} 未注册节点`)
      return "refused"
    }
    try {
      const message = await buildMessage(texts.join("\n\n"))
      if (entry.busy) entry.agent.steer(message)
      else entry.agent.followup(message)
      return "delivered"
    } catch (error) {
      warn(`注入失败（${sessionId}）：${describe(error)}`)
      return "refused"
    }
  }

  const flush = createIdleFlush({ hub, deliver, seen, heartbeat, log: warn })

  function stopPolling(sessionId) {
    pollers.get(sessionId)?.stop()
    pollers.delete(sessionId)
  }

  /** 会话进入 idle 时启动（幂等）；每轮走与 idle 状态同一的 `flush` 路径。 */
  function ensurePolling(sessionId, nodeId) {
    if (pollers.has(sessionId)) return
    const poller = new IdlePoller({ intervalMs: pollMs, run: () => flush(sessionId, nodeId) })
    pollers.set(sessionId, poller)
    poller.start()
  }

  /**
   * 注册一个会话节点（`agent/created` 与「状态先到」的懒收养共用；并发调用合并为一次注册）。
   * 父节点：`header.parentSession` 已注册则挂其下，否则挂实例节点（根会话/顺序未定时的兜底）。
   */
  async function ensureSession(agent) {
    const header = agent?.session?.header
    const sessionId = header?.id
    if (typeof sessionId !== "string" || sessionId === "") {
      warn("agent/created：会话缺少 header.id，跳过注册")
      return undefined
    }
    known.set(sessionId, agent)
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const inflight = pending.get(sessionId)
    // 合并**同一 agent** 的并发注册；重开后是新 agent（不同对象）→ 不合并，走一次新的注册
    // （旧注册收尾时按 `pending` 归属检查放弃登记，绝不用已释放的 agent 覆盖新条目）。
    if (inflight !== undefined && inflight.agent === agent) return inflight.promise

    const task = (async () => {
      // **整个任务体**都在 try/finally 内：任何提前返回（含 `registerInstance()` 失败）都必须清掉
      // 本会话的在途记录，否则后续所有重试都会命中上面那条 `inflight.agent === agent` 分支、
      // 拿回**已落定的旧 promise**，从此静默不再注册（真机事故：Hub 抖动一次后该会话再也不上线）。
      try {
        const parentId = await registerInstance()
        if (parentId === undefined) return undefined
        const parentSession = header["parentSession"]
        const parentNode = typeof parentSession === "string" ? sessions.get(parentSession)?.nodeId : undefined
        const isSubagent = header["origin"] === "subagent"
        // 「顶层」= 子代理节点之外的会话（没有已知父会话节点者挂实例根，故 `parent_ref` 回落实例 id）。
        const topLevel = !isSubagent
        const result = await registerWithNameRetry(
          hub,
          {
            vendor: ADAPTER_VENDOR,
            purpose: isSubagent ? "subagent" : "coding-agent",
            name: sessionName(header, sessionId),
            parent_ref: parentNode ?? parentId,
            task_ref: sessionId,
          },
          warn,
        )
        // 注册期间被 `agent/disposed` 释放且未重开 → 放弃登记（否则映射里会留下僵尸 agent，
        // 后续唤醒会注入已释放对象并被 Hub 记为 delivered；见 `lib/session-hint.js`）。重开后
        // 已有更新的注册接管了 `pending` → 同样放弃，绝不用旧 agent 覆盖新条目。
        if (hint.reconcile(sessionId) || pending.get(sessionId)?.agent !== agent) {
          warn(`会话 ${sessionId} 的注册已作废（期间被释放或被更新的注册取代），放弃登记`)
          return undefined
        }
        const entry = { nodeId: result.agentId, agent, busy: false }
        sessions.set(sessionId, entry)
        hint.onRegistered(sessionId, result.agentId, topLevel)
        await reportState(entry.nodeId, "online")
        // **登记即开轮询**（与 `adapters/opencode` 的 `onAdopted` 同款）：会话可能在**注册之前就已 idle**
        // （`agent/created`/加载期回填/补注册重试都不带 idle 跳变），若只由 `agent/status=idle` 启动轮询，
        // 空闲期到达的消息将**永远无人认领**——真机症状：AgentChat 里一直「排队中」。
        ensurePolling(sessionId, entry.nodeId)
        // 展示名 = DSH 会话标题（可读）；`name` 仍是机器唯一名。失败只记日志。
        guard(syncTitle(sessionId, agent, entry.nodeId))
        return entry
      } catch (error) {
        warn(`会话节点注册失败（${sessionId}）：${describe(error)}`)
        return undefined
      } finally {
        // 只清理**自己**的在途记录（新的注册可能已经接管）。
        if (pending.get(sessionId)?.agent === agent) pending.delete(sessionId)
      }
    })()
    pending.set(sessionId, { agent, promise: task })
    return task
  }

  /**
   * 回合始/末：`running` → busy（停轮询 + 容器搭车同态上报）；`idle` → 先起空闲轮询再取件。
   *
   * 顺序要点：`ensurePolling` **在 `flush` 的网络往返之前**调用——Hub 慢或挂住时（单请求超时
   * 3s、含退避更久）空闲会话不能因此失去补拉通道；状态本身由 `flush` 的心跳（会话节点 + 实例
   * 节点 `idle`，`always`）上报。
   */
  async function onStatus(payload) {
    const agent = payload?.agent
    const entry = (await ensureSession(agent)) ?? sessions.get(agent?.session?.header?.id)
    if (entry === undefined) return
    const sessionId = agent.session.header.id
    const running = payload?.status === "running"
    entry.busy = running
    entry.agent = agent
    if (running) {
      stopPolling(sessionId)
      await reportState(entry.nodeId, "busy")
      await reportInstance("busy")
      return
    }
    ensurePolling(sessionId, entry.nodeId)
    await flush(sessionId, entry.nodeId)
  }

  /**
   * `agent/disposed`：停轮询 + 丢弃本地映射，**不退役 Hub 节点**。
   *
   * 理由见文件头：Hub 已退役节点永久拒绝同 `task_ref` 再注册，而 DSH 的 disposed 也会在
   * 「关闭后还能重新打开」的会话上触发。子节点也不能报 offline（Hub 以 `child_never_offline` 拒绝），
   * 故离开即静默；失联由 Hub `last_seen` 阈值判 offline。
   */
  async function onDisposed(payload) {
    const sessionId = payload?.agent?.session?.header?.id
    if (typeof sessionId !== "string") return
    const entry = sessions.get(sessionId)
    stopPolling(sessionId)
    // 不清理 `pending`：在途注册要么被 `hint.reconcile` 放弃，要么（若该会话马上重开）由
    // `noteReopened` 清除标记后交给既有的在途任务收尾——**不重复注册**同一 Hub 节点。
    hint.onDisposed(sessionId)
    if (entry === undefined) return
    sessions.delete(sessionId)
    known.delete(sessionId)
    lastState.delete(entry.nodeId)
    log(`会话 ${sessionId} 的 agent 已释放，停止跟踪（节点保留，待 Hub 判 offline）`)
  }

  /** 事件入口：**fire-and-forget**，异常在各自处理函数内消化，绝不冒泡到宿主（见 `lib/util.js`）。 */
  const guard = createGuard(warn)

  // 加载期回填 + 加载日志（见 lib/backfill.js）：运行中安装/HMR 时，已存在的会话没有 created 事件。
  log(`插件已加载（轮询间隔 ${pollMs}ms，Hub ${resolveHubConfig(env).baseUrl}）`)
  backfillSessions(ctx, ensureSession, warn)

  // 补注册重试（见 lib/retry.js）：每轮重新枚举 ctx.agents，覆盖"加载瞬间 list 为空 / 错过 created"与 Hub 抖动。
  const stopRetry = createRegistrationRetry({
    intervalMs: parsePollMs(cfg["retryMs"] === undefined ? String(RETRY_MS) : String(cfg["retryMs"])),
    ctx, known, sessions, ensure: ensureSession, log: warn, limit: SEEN_LIMIT,
  })

  // `agent/created`：先记「重开」（清除 disposed 标记），再走与懒收养同一条注册路径。
  ctx.on("agent/created", (payload) => {
    const sessionId = payload?.agent?.session?.header?.id
    if (typeof sessionId === "string") hint.noteReopened(sessionId)
    guard(ensureSession(payload?.agent))
  })
  ctx.on("agent/status", (payload) => guard(onStatus(payload)))
  ctx.on("agent/disposed", (payload) => guard(onDisposed(payload)))

  ctx.effect(
    () => () => {
      stopRetry()
      for (const poller of pollers.values()) poller.stop()
      pollers.clear()
      sessions.clear()
      known.clear()
      pending.clear()
      // 卸载 = 0 个存活会话：删除会话身份提示（桥回落到实例 id，不留陈旧会话身份）。
      hint.clear()
      // 实例节点是根：卸载报 offline 合规；会话子节点不退役（见 `onDisposed` 的取舍）。
      if (instanceAgentId === undefined) return undefined
      const nodeId = instanceAgentId
      // Cordis **等待** disposer 的返回值，故必须把上报 Promise 返回出去（否则卸载可能先于请求完成）。
      return hub.reportState(nodeId, "offline").catch((error) => warn(`离线上报失败：${describe(error)}`))
    },
    "agentchat: 停止轮询并上报实例 offline",
  )
}
