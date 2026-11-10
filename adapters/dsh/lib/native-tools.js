/**
 * DSH **原生工具面**：把 Hub 的 MCP 工具面注册为宿主原生工具，**逐调用**按调用者会话注入身份。
 *
 * 为什么需要（真机事故，安全级）：MCP 桥只有**一个**连接，出站身份只能来自进程级共享状态
 * （`agents/dsh.current` 单文件）。多顶层会话并存时无法唯一确定"谁在说话"，任何启发式都会变成
 * 静默冒名（真机已发生：成员A 的消息被记成成员B，`respond_ask` 亦被拒）。fail-closed 只把
 * "错挂"换成"无身份"，精确归属仍缺失。
 *
 * 原生工具面从根上解决：宿主按**调用**把调用方 agent 交给工具（`execute(args, exec)` 的
 * `exec.agent`，见 `@deepseek-ai/dsh-tools` 的 `ToolExecutionInput.agent`），
 * 于是每次调用都能拿到自己的 `session.header.id` → 映射到该会话的 Hub 节点 → 经
 * `x-agentchat-session` 头**逐请求**记账。并发多会话天然正确，且不再依赖 MCP 桥与共享文件。
 *
 * 纪律：
 * - **绝不抛**给宿主：注册失败逐工具忽略并记日志；调用失败转成文本结果（模型可见、可自救）；
 * - **拿不到调用者会话就拒发**（不回落容器、不猜）：返回明确文案，避免再次污染审计；
 * - 工具定义从 Hub 的 `tools/list` **动态生成**（不硬编码 schema，Hub 加工具自动跟随）；
 * - **P8 自动注册**：插件加载时 Hub 常常还没起来（一次失败就永不再试 = 「收得到、发不出」，只能重启
 *   DSH）；`startAutoRegister()` 会指数退避重试到成功为止，`dispose()` 停止定时器并反注册。
 *
 * @module lib/native-tools
 */
import { createAutoRegister } from "./tool-register.js"
import { describe, isRecord } from "./util.js"

/**
 * 自动注册句柄（= `lib/tool-register.js` 的 `createAutoRegister` 返回值）。
 *
 * @typedef {{start: () => void, stop: () => void, attempts: () => number, failures: () => number,
 *   succeeded: () => boolean, running: () => boolean, nextDelayMs: () => number | undefined}} AutoRegisterHandle
 */

/** 原生工具名前缀（与 MCP 面的 `mcp__agentchat__*` 区分，避免同一模型看到两个同名工具）。 */
export const TOOL_PREFIX = "agentchat_"

/** 拿不到调用者会话时的拒发文案（**不猜身份**）。 */
export const NO_SESSION_TEXT =
  "本会话尚未在 AgentChat 注册（或该调用无调用方会话），未发送任何请求以避免身份错挂；请稍后在会话内重试。"

/**
 * 把一条 Hub 工具描述转成 DSH 工具定义（纯函数，便于单测）。
 *
 * @param {{name: string, description?: unknown, inputSchema?: unknown}} tool Hub `tools/list` 的一项
 * @param {(name: string, args: unknown, exec: unknown) => Promise<string>} run 执行体（已绑定身份解析）
 * @returns {Record<string, unknown>} DSH 工具定义（`name`/`description`/`parameters`/`output`/`execute`）
 */
export function toolDefinition(tool, run) {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} }
  return {
    name: `${TOOL_PREFIX}${tool.name}`,
    description:
      typeof tool.description === "string" && tool.description !== ""
        ? tool.description
        : `AgentChat：${tool.name}`,
    parameters: schema,
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      /** 纯投影：把规范化值渲染成模型可见文本。 */
      render: (_args, value) => [
        { type: "text", text: isRecord(value) && typeof value["text"] === "string" ? value["text"] : "" },
      ],
    },
    execute: async (args, exec) => ({ text: await run(tool.name, args, exec) }),
  }
}

/**
 * 建原生工具面。
 *
 * @param {{ctx: {get?: (name: string) => unknown}, hub: {mcp(): {list(): Promise<unknown[]>, call(name: string, args: unknown, taskRef?: string): Promise<string>}},
 *   sessions: Map<string, {nodeId: string}>, log: (message: string) => void,
 *   service?: {register?(definition: Record<string, unknown>): (() => void) | undefined}}} options
 *   `service` 缺省取 `ctx.get("tools")`（测试可注入）；**必须以方法形式调用** `register`（内部用 `this`）
 * @returns {{registerAll: (log?: (message: string) => void) => Promise<number>,
 *   startAutoRegister: (overrides?: object) => AutoRegisterHandle | undefined,
 *   dispose: () => void, definitions: Record<string, unknown>[]}}
 */
export function createNativeTools(options) {
  /**
   * **缓存一个** MCP 会话：身份是**逐请求头**（`x-agentchat-session`），
   * 所以同一会话可承载任意多会话的调用——不要每次调用重新握手。
   */
  let client
  const mcp = () => (client ??= options.hub.mcp())

  /** 执行体：解析调用者会话 → 该会话的 `task_ref` 作为逐调用身份；解析不到就拒发。 */
  async function run(name, args, exec) {
    const sessionId = exec?.agent?.session?.header?.id
    if (typeof sessionId !== "string" || !options.sessions.has(sessionId)) return NO_SESSION_TEXT
    try {
      return await mcp().call(name, args ?? {}, sessionId)
    } catch (error) {
      // Hub 侧会话失效（换库/重启 → 400/404）：丢弃缓存会话，下次调用重新握手自愈。
      if (error?.status === 400 || error?.status === 404) client = undefined
      options.log(`原生工具 ${name} 调用失败：${describe(error)}`)
      return `AgentChat 调用失败：${describe(error)}`
    }
  }

  /** 已注册定义（含 disposer），供 `dispose()` 反注册。 */
  const registered = []
  /** 现役定义（测试与排查用）。 */
  const definitions = []
  /** 已 dispose：此后的注册请求一律拒绝，且竞态里刚注册上的工具立刻反注册（见下）。 */
  let disposed = false
  /** 自动注册句柄（`startAutoRegister()` 幂等：已启动即返回同一句柄，不叠加定时器）。 */
  let retry

  /**
   * 单次注册尝试（**行为与 P7 完全一致**，仅多了可选日志出口）：返回实际注册成功的工具数。
   *
   * @param {(message: string) => void} [log] 诊断出口；缺省 `options.log`。自动注册会传入一个
   *   **捕获式**出口，由调度器按节流策略决定是否真的落日志（避免每轮重试刷屏）。
   * @returns {Promise<number>}
   */
  async function registerAll(log = options.log) {
    if (disposed) return 0
    let service
    try {
      service = options.service ?? options.ctx.get?.("tools")
    } catch (error) {
      log(`取 tools 服务失败（忽略）：${String(error)}`)
      return 0
    }
    if (typeof service?.register !== "function") {
      // **响亮告警**（P7）：默认工具面就是原生面；拿不到 tools 服务时本会话没有任何 AgentChat 工具，
      // 必须让用户看见并给出可执行的补救（保留 MCP 桥工具行）——绝不静默降级。
      log(
        "原生工具面不可用：宿主没有 tools 服务（ctx.get('tools')）→ 本插件未注册任何 AgentChat 工具；" +
          "若你依赖 MCP 桥工具行，请用 `node adapters/dsh/install.mjs --with-mcp-bridge` 重装（或升级 DSH）",
      )
      return 0
    }
    const tools = await mcp().list()
    let count = 0
    for (const tool of tools) {
      // dispose 竞态：反注册后绝不继续注册（否则宿主工具表里会留下调用不到的僵尸工具）。
      if (disposed) break
      if (!isRecord(tool) || typeof tool["name"] !== "string") continue
      const definition = toolDefinition(
        /** @type {{name: string, description?: unknown, inputSchema?: unknown}} */ (tool),
        run,
      )
      try {
        // **必须以方法形式调用**（`service.register(...)`）：注册表内部用到 `this`
        // （真机事故：解构成裸函数后调用 → `this` undefined → TypeError: reading 'layers' → 12 个工具全部注册失败）。
        const disposer = service.register(definition)
        const off = typeof disposer === "function" ? disposer : () => {}
        if (disposed) {
          // 注册期间恰好 dispose：立刻反注册这一个，绝不留在宿主里。
          off()
          break
        }
        registered.push(off)
        definitions.push(definition)
        count += 1
      } catch (error) {
        // 宿主 schema 校验拒绝（例如 Hub 用了宿主不支持的 schema 关键字）：跳过该工具即可。
        log(`注册原生工具 ${String(tool["name"])} 失败（忽略）：${String(error)}`)
      }
    }
    log(`原生工具面已注册 ${count} 个工具（逐调用按会话注入身份，不依赖共享文件）`)
    return count
  }

  /**
   * 启动**自动注册**（P8）：首次立即尝试；失败（拿不到 `tools` 服务 / `mcp().list()` 抛错 / 注册 0 个）
   * 按指数退避重试——`5s → 10s → 20s → 40s → 封顶 60s`（±10% 抖动）；**一旦成功即停止**，此后不再重试。
   *
   * 为什么需要：插件加载时 Hub 常还没起来，一次失败就永不再试 = 「收得到消息、发不出去」，只能重启 DSH。
   *
   * 幂等：重复调用返回同一句柄（不会叠加定时器）。`dispose()` 会 `stop()` 它。**绝不抛**给宿主。
   *
   * @param {{log?: (message: string) => void, baseMs?: number, capMs?: number, logEveryAttempts?: number,
   *   logEveryMs?: number, jitter?: number, now?: () => number, random?: () => number,
   *   setTimeout?: (fn: () => void, ms: number) => unknown, clearTimeout?: (id: unknown) => void}} [overrides]
   *   单测注入点（定时器/时钟/随机数）；生产不传。
   * @returns {AutoRegisterHandle | undefined} 句柄（构造失败时 `undefined`）
   */
  function startAutoRegister(overrides = {}) {
    if (retry !== undefined) return retry
    try {
      retry = createAutoRegister({
        // 捕获式日志：由调度器按节流策略 flush（首次失败/原因变化/每 N 次/每 N 分钟）。
        attempt: async () => {
          const captured = []
          const count = await registerAll((message) => captured.push(message))
          return { count, captured }
        },
        log: overrides.log ?? options.log,
        baseMs: overrides.baseMs,
        capMs: overrides.capMs,
        logEveryAttempts: overrides.logEveryAttempts,
        logEveryMs: overrides.logEveryMs,
        jitter: overrides.jitter,
        now: overrides.now,
        random: overrides.random,
        setTimeout: overrides.setTimeout,
        clearTimeout: overrides.clearTimeout,
      })
      retry.start()
      return retry
    } catch (error) {
      options.log(`原生工具面自动注册启动失败（忽略）：${describe(error)}`)
      return undefined
    }
  }

  return {
    registerAll,
    startAutoRegister,
    definitions,
    dispose() {
      // 顺序有意义：先置 disposed（在途的 registerAll 立刻停止/反注册），再停表（不再有下一次尝试）。
      disposed = true
      retry?.stop()
      retry = undefined
      for (const disposer of registered.splice(0)) {
        try {
          disposer()
        } catch {
          // 反注册失败不得影响卸载流程。
        }
      }
      definitions.length = 0
    },
  }
}
