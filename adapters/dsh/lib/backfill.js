/**
 * 插件**加载期回填**与**当前 agent 枚举**：把已存在的 agent 会话补登记为 Hub 节点。
 *
 * 为什么必须：`agent/created` 只对加载**之后**新建的 agent 触发。把适配器装进一个正在运行的
 * DSH（profile 热重组、`plugin-manager` 安装、HMR、或宿主与 Hub 前后脚重启）时，用户当前打开的会话
 * 可能早已创建、或在插件挂监听**之前**就创建完了，它不会再有 `created` 事件，只能等下一次
 * `agent/status`（回合边界）被动收养——在那之前该会话在 Hub 里不可见、MCP 出站也没有身份。
 * `ctx.agents`（`@deepseek-ai/dsh-agent` 的 `AgentRegistry`）提供 `list(): Agent[]`，正是这份
 * "当前全部 agent"；**真机事故**：插件在 06:13 启动瞬间 `list()` 为空、且错过了本会话的
 * `agent/created`，于是本会话整整一轮都没有节点——所以除加载期回填外，补注册重试每轮也会**重新枚举**
 * （见 `lib/retry.js`）。
 *
 * 纪律：**尽力而为**——任何失败只记日志，绝不阻塞插件激活；每个 agent 的注册走与事件路径
 * 完全相同的 `ensure`（同一去重/竞态守卫），因此与并发的 `agent/created` 不会重复注册。
 *
 * @param {{get?: (name: string) => unknown}} ctx Cordis 上下文
 * @returns {readonly unknown[]} 当前 agent 列表（服务不可用/形状不符 → 空数组，绝不抛）
 */
export function enumerateAgents(ctx) {
  try {
    const registry = typeof ctx.get === "function" ? ctx.get("agents") : undefined
    const list = typeof registry === "object" && registry !== null && typeof registry["list"] === "function"
      ? registry["list"]()
      : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 加载期回填：对当前全部 agent 各触发一次注册（与事件路径同一条 `ensure`）。
 *
 * @param {{get?: (name: string) => unknown}} ctx Cordis 上下文
 * @param {(agent: unknown) => Promise<unknown>} ensure 与 `agent/created` 同一条注册路径
 * @param {(message: string) => void} log 诊断日志（绝不抛）
 * @returns {number} 本次回填的 agent 数（0 = 无已存在会话或服务不可用）
 */
export function backfillSessions(ctx, ensure, log) {
  const list = enumerateAgents(ctx)
  if (list.length === 0) return 0
  for (const agent of list) {
    void Promise.resolve(ensure(agent)).catch((error) => log(`回填会话失败（忽略）：${String(error)}`))
  }
  log(`加载期回填 ${list.length} 个已存在的 agent 会话`)
  return list.length
}
