/**
 * 测试适配器 A：**无头假宿主 + 测试客户端**（`adapters/test/lib/host.mjs`）。
 *
 * ## 为什么这样写（设计约束，别改成"另写一套客户端"）
 * - **复用真代码**：Hub 往返一律走 `adapters/dsh/lib/hub.js` 的 `createHubClient`
 *   （`register/reportState/wake/reportResult/mcp`），空闲取件闭环走 `lib/flush.js` 的
 *   `createIdleFlush`（seen 去重、租约重投只补回执、refused 不写 seen 全在真实现里），
 *   轮询走 `lib/poll.js` 的 `IdlePoller`，去重集合走 `lib/util.js` 的 `createBoundedSet`。
 *   本文件**只替换"把消息注入宿主"这一步**（`deliver`）：真宿主是 DSH 的
 *   `agent.followup/steer`，无头测试里改成"录音 + 可编程结果"。
 * - 因此 dsh 适配器的语义升级会**自动**被本适配器继承，不存在"测试副本与生产实现漂移"。
 * - 逐调用身份：`hub.mcp()` 已按 `createMcpClient({send}, bearer)` 的**正确形状**返回
 *   （历史事故：给 `createMcpClient` 传裸函数 → `transport.send is not a function` 静默失效）。
 * - **绝不碰真实 `~/.agentchat`**：`home` 必填，显式注入 env `AGENTCHAT_HOME`；
 *   且**不继承**进程里的 `HUB_TOKEN`（本机为真实 Hub 导出的票会让测试 401），
 *   需要时用 `options.token` 显式给。
 *
 * ## 对外接口（task-6 冻结面 + 少量测试用超集）
 * `createTestHost({home, baseUrl?, vendor?, log?, now?, token?, namePrefix?})` →
 * `{hub, root, registerRoot, registerSession, registerLogical, setState, flush, startPolling,
 *   deliver, deliveries, inboxOf, injectedIdsOf, messageStatus, receiptsOf, send, inbox, ack,
 *   call, dump, reset, close, ...}`。超集部分（`reset/createGroup/sendAsHuman/shoutAsHuman/
 *   jobOf/injectionsOf/...`）只在测试与 CLI 里用，均为**测试面 HTTP**（`/api/test/*`），
 *   仍是服务端真实业务路径（`routes/test.ts` → core），不是假数据。
 *
 * ## 拆文件（本仓红线「单文件 ≤ 250 纯行」）
 * 裸 HTTP（`/internal/state` 原始码 + `/api/test/*`）在 `lib/hub-http.mjs`；场景库在
 * `lib/scenario-kit.mjs` / `lib/scenarios-*.mjs` / `lib/scenarios.mjs`；输出层在 `lib/report.mjs`；
 * Hub 进程生命周期在 `lib/hub-process.mjs`。
 */
import { randomBytes } from "node:crypto"
import { createHubClient, resolveHubConfig } from "../../dsh/lib/hub.js"
import { createIdleFlush } from "../../dsh/lib/flush.js"
import { IdlePoller } from "../../dsh/lib/poll.js"
import { createBoundedSet } from "../../dsh/lib/util.js"
import { createHubHttp } from "./hub-http.mjs"
import { createProgrammableDeliver } from "./inject.mjs"

/** 注入去重集合上限（与 `adapters/dsh/index.js` 的 `SEEN_LIMIT` 同值，语义一致）。 */
export const SEEN_LIMIT = 256
/** 默认轮询间隔（`IdlePoller` 直接吃 ms，不经 `parsePollMs` 的 1s 下限钳制）。 */
export const DEFAULT_POLL_MS = 200
/** 默认厂商 id：Hub 侧未登记该 vendor 的适配器 → dispatcher 只退避、绝不注入。 */
export const DEFAULT_VENDOR = "agentchat-test"

/**
 * 注入文本 → messageId 列表。依赖 `flush.formatMessages` 的渲染约定
 * （`- [<id>] 来自 <fromAgentId>：<body>`）—— 这是测试与生产**共用**的渲染，
 * 所以这里解析出的 id 就是 Hub 认领时的真实 messageId。
 */
export function injectedIds(text) {
  const found = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^-\s+\[([^\]]+)\]\s+来自\s/.exec(line)
    if (match !== null) found.push(match[1])
  }
  return found
}

/**
 * 建无头假宿主。见文件头（`options.home` 必填）。
 *
 * @param {{home: string, baseUrl?: string, vendor?: string, log?: (m: string) => void,
 *   now?: () => number, token?: string, namePrefix?: string, timeoutMs?: number}} options
 */
export function createTestHost(options = {}) {
  const home = options.home
  if (typeof home !== "string" || home === "") {
    throw new Error("createTestHost: options.home 必填（= AGENTCHAT_HOME；绝不回落 ~/.agentchat）")
  }
  const clock = options.now ?? Date.now
  const vendor = options.vendor ?? DEFAULT_VENDOR
  const namePrefix = options.namePrefix ?? `t6-${randomBytes(2).toString("hex")}`
  const logs = []
  const log = (message) => {
    logs.push(`${new Date(clock()).toISOString()} ${message}`)
    options.log?.(message)
  }

  const env = { ...process.env, AGENTCHAT_HOME: home }
  delete env.HUB_TOKEN
  if (options.token !== undefined) env.HUB_TOKEN = options.token
  const resolved = resolveHubConfig(env)
  const baseUrl = (options.baseUrl ?? resolved.baseUrl).replace(/\/+$/, "")
  env.AGENTCHAT_URL = baseUrl
  // 裸 HTTP 面（`/internal/state` 要拿原始 409；`/api/test/*` 是测试面）在 `hub-http.mjs`；
  // 注入闭环（wake/result/mcp）一律走上面的真 `createHubClient`。
  const { httpJson, setState, dump, reset, createGroup, createDm, sendAsHuman, shoutAsHuman, markRead } =
    createHubHttp({ baseUrl, token: resolved.token, log })

  const hub = createHubClient({
    env,
    fetch: globalThis.fetch,
    log,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  /** MCP 通用客户端：一次握手 + 逐调用 `x-agentchat-session` 身份（真代码）。 */
  const mcp = hub.mcp()

  // ── 可编程注入（"脱 LLM"的关键：真宿主这一步被替换，其余闭环全真）──
  const { deliver, deliveries, state: injectState } = createProgrammableDeliver({ now: clock })

  /** flush 用的 hub 视图：wake 是真实现；结果上报可按剧本"崩掉"（模拟宿主崩溃）。 */
  const flushHub = {
    wake: (agentId) => hub.wake(agentId),
    reportResult: async (agentId, items) => {
      if (injectState.suppressLeft > 0) {
        injectState.suppressLeft -= 1
        throw new Error("simulated crash: result receipt suppressed")
      }
      return hub.reportResult(agentId, items)
    },
  }
  /**
   * **每个假宿主会话一个 `createIdleFlush` 实例**（真实现的实例化方式变了，语义没变）。
   *
   * 为什么不是全 host 共用一个 `seen`：`messageId` 在 Hub 全局唯一，而 `seen` 的语义是
   * "**该注入目标**已成功注入过哪些 id"。若多个会话共用一份 `seen`，同一条群消息/喊话
   * 被 A 会话注入后，B 会话的 flush 会把 `fresh` 过滤成空 → 只补回执、**不注入正文**，
   * 但 Hub 侧照样记 `accepted`（发送方看到 delivered）→ 静默丢消息。
   * 真实 DSH 插件当前正是"每插件实例一份 `seen`"（`adapters/dsh/index.js:82`），
   * 同一实例内两个会话同收一条群消息即会命中该缺陷（已在 task-6 报告中作为生产缺陷上报，
   * 本适配器不就地修 dsh 代码）。测试面需要的是"每个会话各自一台宿主"的忠实模型，
   * 故按 nodeId 各持一个 flush 实例（`createIdleFlush` 本身仍是同一份真代码）。
   */
  const flushes = new Map()
  function flush(nodeId, agentId) {
    let idleFlush = flushes.get(nodeId)
    if (idleFlush === undefined) {
      idleFlush = createIdleFlush({
        hub: flushHub,
        deliver,
        seen: createBoundedSet(SEEN_LIMIT),
        // 与 dsh 插件同款心跳：flush 前先按 idle 上报（Hub 侧 `idle` → `online` + makeJobsDue）。
        heartbeat: (target) => hub.reportState(target, "idle"),
        log,
      })
      flushes.set(nodeId, idleFlush)
    }
    return idleFlush(nodeId, agentId)
  }

  const pollers = new Set()
  function startPolling(nodeId, agentId, pollOptions = {}) {
    const poller = new IdlePoller({
      intervalMs: pollOptions.intervalMs ?? DEFAULT_POLL_MS,
      run: () => flush(nodeId, agentId),
    })
    pollers.add(poller)
    poller.start()
    return () => {
      poller.stop()
      pollers.delete(poller)
    }
  }

  // ── 节点注册（register 是 MCP 工具，走真 `mcpRegister` 握手）──
  let root
  const sessions = new Map()
  const counter = { value: 0 }
  const nextName = (label) => {
    counter.value += 1
    return `${namePrefix}-${label}-${counter.value}`
  }

  async function registerRoot(input = {}) {
    const roleTag = input.roleTag === undefined ? "container" : input.roleTag
    const result = await hub.register({
      vendor: input.vendor ?? vendor,
      name: input.name ?? nextName("root"),
      purpose: input.purpose ?? "test-harness",
      ...(roleTag === null ? {} : { role_tag: roleTag }),
      ...(input.joinToken === undefined ? {} : { join_token: input.joinToken }),
    })
    const info = { agentId: result.agentId, joinToken: result.joinToken }
    root ??= info
    return info
  }

  /**
   * "新建会话"：无 LLM 也可注册一个 runtime 会话节点。
   * - `parentRef` 缺省 → 挂在本 host 的实例根下（`role_tag:'container'` 的容器不是聊天实体）
   * - `parentRef: null` → **不挂父**（注册为独立 runtime 根）：唯一能合法上报 `offline` 的形状
   *   （子节点 `offline` 被 Hub 以 409 `child_never_offline` 拒绝）
   */
  async function registerSession(input = {}) {
    const taskRef = input.taskRef
    if (typeof taskRef !== "string" || taskRef === "") {
      throw new Error("registerSession: taskRef 必填（Hub 以 task_ref 作会话幂等键与身份解析键）")
    }
    const cached = sessions.get(taskRef)
    if (cached !== undefined) return cached
    const parentRef = input.parentRef === undefined ? root?.agentId : input.parentRef
    const common = {
      vendor: input.vendor ?? vendor,
      name: input.name ?? nextName(taskRef),
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    }
    if (parentRef === undefined || parentRef === null) {
      // 不挂父 = 独立 runtime 根（唯一能合法上报 offline 的形状）。**不传** role_tag：
      // MCP `register` 的 schema 是 `role_tag?: string`（拒 null），省略即"无标记、非容器"。
      const result = await hub.register({ ...common })
      const session = { agentId: result.agentId, joinToken: result.joinToken, taskRef, parentRef: null }
      sessions.set(taskRef, session)
      return session
    }
    const result = await hub.register({ ...common, parent_ref: parentRef, task_ref: taskRef })
    const session = { agentId: result.agentId, joinToken: result.joinToken, taskRef, parentRef }
    sessions.set(taskRef, session)
    return session
  }

  /** 逻辑节点（`kind:'logical'`，Hub 侧落 `status=offline`）：只收件箱、不建 wake job。 */
  async function registerLogical(input = {}) {
    const parentRef = input.parentRef === undefined ? root?.agentId : input.parentRef
    const result = await hub.register({
      kind: "logical",
      vendor: input.vendor ?? vendor,
      name: input.name ?? nextName("logical"),
      ...(parentRef === undefined || parentRef === null ? {} : { parent_ref: parentRef }),
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    })
    return { agentId: result.agentId }
  }

  // ── MCP 身份调用（真 `createMcpClient`；逐调用 `x-agentchat-session`）──
  async function call(taskRef, name, args) {
    return JSON.parse(await mcp.call(name, args, taskRef))
  }
  /** @returns {Promise<import("./hub-http.mjs").McpSendResult>} */
  const send = (taskRef, args) => call(taskRef, "send", args)
  /** @returns {Promise<{messages: import("./hub-http.mjs").McpMessage[], unread: number, timedOut?: boolean}>} */
  const inbox = (taskRef, args = {}) => call(taskRef, "inbox", args)
  /** @returns {Promise<{confirmed: number}>} */
  const ack = (taskRef, ids) => call(taskRef, "ack", { message_ids: ids })
  /** @returns {Promise<{id: string, receipts: import("./hub-http.mjs").McpReceipt[]}[]>} */
  const messageStatus = (ids, taskRef) => call(taskRef, "message_status", { ids })

  /** `message_status` → `Map<"<messageId>:<agentId>", stage>`（真回执派生）。 */
  async function receiptsOf(ids, taskRef) {
    const results = await messageStatus(ids, taskRef)
    const map = new Map()
    for (const item of results) {
      for (const receipt of item.receipts) map.set(`${item.id}:${receipt.agentId}`, receipt.stage)
    }
    return map
  }

  /** 取某条消息的 `wake_jobs` 原始行（dump 真相源；无行 → undefined）。 */
  async function jobOf(messageSeq, agentId) {
    const snapshot = await dump()
    return snapshot.wakeJobs.find((job) => job.message_id === messageSeq && job.agent_id === agentId)
  }

  /** 该 nodeId（= 注入路由键）收到的注入文本（每次注入一条文本）。 */
  const inboxOf = (nodeId) =>
    deliveries.filter((entry) => entry.nodeId === nodeId).flatMap((entry) => entry.texts)
  /** 该 nodeId 已注入的 messageId（按注入顺序；解析自真实注入文本）。 */
  const injectedIdsOf = (nodeId) => inboxOf(nodeId).flatMap(injectedIds)
  /** 该 nodeId 的注入记录（含被拒/抛错的那次，便于"重投次数"断言）。 */
  const injectionsOf = (nodeId) => deliveries.filter((entry) => entry.nodeId === nodeId)

  function close() {
    for (const poller of pollers) poller.stop()
    pollers.clear()
  }

  return {
    hub,
    mcp,
    baseUrl,
    home,
    vendor,
    logs,
    // 用 getter 而非快照：`root` 在 `registerRoot` 之后才有值，返回值若按值捕获会恒为 undefined。
    get root() {
      return root
    },
    registerRoot,
    registerSession,
    registerLogical,
    setState,
    flush,
    startPolling,
    deliver,
    deliveries,
    inboxOf,
    injectedIdsOf,
    injectionsOf,
    messageStatus,
    receiptsOf,
    send,
    inbox,
    ack,
    call,
    jobOf,
    dump,
    reset,
    createGroup,
    createDm,
    sendAsHuman,
    shoutAsHuman,
    markRead,
    httpJson,
    close,
  }
}
