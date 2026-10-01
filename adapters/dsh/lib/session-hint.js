/**
 * 会话身份提示（`<home>/agents/dsh.current`）、节点可读名与注册/释放竞态标记——自 `index.js`
 * 抽出，使插件入口留在本仓「单文件 ≤ 250 纯行」红线内（三者都是「会话 ↔ Hub 节点」的命名/归属
 * 语义，故同处一模块）。
 *
 * ## 为什么需要 dsh.current（出站身份必须是**会话节点**）
 * DSH 一进程只挂一个 MCP server，桥的 `x-agent-id` 只能表达**一个**节点；而 Hub 只在
 * `initialize` 时读该头（`server/routes/mcp.ts`），且 `role_tag=container` 的节点**不可作为
 * DM 收件方**（Hub `ContainerNotChatTargetError`）。若出站身份恒为实例容器，对端收到消息后
 * **无法回复**（适配器变单向）。故插件维护本文件：
 * - **恰好一个顶层会话**（父 = 实例节点；`origin==='subagent'` 的子代理不算）存活 → 写入该
 *   会话的 Hub 节点 id，桥用它作 `x-agent-id`：回复经 Hub 路由到该会话节点 → 插件唤醒它（双向）；
 * - **0 个或 ≥2 个顶层会话** → 删除该文件，桥回落到实例容器 id：出站调用仍可用，但**回复会被
 *   Hub 以「容器不是聊天对象」拒绝**（明确报错，绝不静默丢弃或改写收件方）。
 *
 * ## 为什么记录 disposed / reopened（僵尸注册）
 * `ensureSession` 先 `await hub.register`（约 3 次 MCP 往返）再登记本地映射。若期间该会话的
 * `agent/disposed` 到达，登记会把**已释放的 agent** 写回映射且再也不会被移除——之后 Hub 投递的
 * 消息会被注入这个僵尸对象，还会被回报 `delivered`（模型从未看见）。故这里提供一组**有界**标记：
 * 注册期被释放的会话记为 disposed（注册结束后据此放弃登记），新的 `agent/created` 到达清除标记
 * （重开的会话照常注册）。
 *
 * 纪律：所有文件操作都**不抛错**（`lib/token.js` 的写/删函数已自吞异常）；本模块无定时器、
 * 无网络、无第三方依赖，只做内存集合与「值真变了才触盘」的一次文件写。
 */
import { basename } from "node:path"
import { hostname } from "node:os"
import { clearToken, currentPath, readToken, writeToken } from "./token.js"

/** 本适配器的 Hub 厂商 id（也是 `config.json` adapters 里的名字）。 */
export const ADAPTER_VENDOR = "dsh"

/** 实例节点可读名：`dsh@<host>`（主机名缺失回退 `dsh`）；可用 `config.name` 覆盖。 */
export function instanceName(override) {
  if (typeof override === "string" && override !== "") return override
  const host = hostname()
  return host === "" ? "dsh" : `dsh@${host}`
}

/**
 * 会话 id 的**短标识**：剥掉 DSH 的 `session-` 前缀后再取前 8 位。
 *
 * 为什么必须剥前缀：DSH 的会话 id 形如 `session-<uuid>`，前缀恰好 8 个字符——直接
 * `slice(0, 8)` 会得到常量 `session-`，于是**同一目录下的每个会话都算出同一个名字**
 * （真实事故：`default-workspace-session-`），撞上 Hub `agents.name` 唯一索引后
 * **注册必然失败**，该会话在 Hub 里没有节点、消息无处投递。无前缀的 id（如 `4ed70484-…`）
 * 本来正常，故只在确实带该前缀时剥离，并在剥离后为空时回退原 id。
 *
 * @param {string} id 会话 id
 * @returns {string} 至多 8 个字符的短标识
 */
export function idSuffix(id) {
  const compact = id.startsWith("session-") ? id.slice("session-".length) : id
  return (compact === "" ? id : compact).slice(0, 8)
}

/**
 * 会话节点可读名：`<工作目录名>-<会话 id 短标识>`，无 cwd 则 `dsh-<短标识>`。
 *
 * **必须唯一**：Hub 的 `agents.name` 与展示名（`COALESCE(custom_name, name)`）都有唯一索引，
 * 同名注册会失败；同一目录下开多个会话时纯目录名会撞键，故一律带会话 id 短标识。
 * 标识的取法见 {@link idSuffix}（真机事故的根因就在那里）。极端情况下仍撞名时，
 * `lib/register.js` 会追加短哈希后缀重试一次。
 * 标题由 DSH 侧会话标题插件掌握，此处不猜也不跟随（避免与唯一索引反复冲突）。
 */
export function sessionName(header, sessionId) {
  const suffix = idSuffix(sessionId)
  const cwd = typeof header["cwd"] === "string" && header["cwd"] !== "" ? basename(header["cwd"]) : ""
  return cwd === "" ? `dsh-${suffix}` : `${cwd}-${suffix}`
}

/**
 * 建提示维护器。
 *
 * @param {string} home `AGENTCHAT_HOME`
 * @param {number} limit 竞态标记上限（有界 FIFO，防长跑进程泄漏）
 * @param {(message: string) => void} log 诊断（写文件日志，绝不写 stdout）
 * @returns {{
 *   isDisposed(sessionId: string): boolean,
 *   noteReopened(sessionId: string): void,
 *   reconcile(sessionId: string): boolean,
 *   onRegistered(sessionId: string, nodeId: string, topLevel: boolean): void,
 *   onDisposed(sessionId: string): void,
 *   clear(): void,
 * }}
 */
export function createSessionHint(home, limit, log) {
  const path = currentPath(home)
  /** 注册期被释放的会话 id（有界 FIFO；只有新的 `agent/created` 能清除）。 */
  const disposed = new Map()
  /** 已收到新 `agent/created` 的会话 id（有界 FIFO）：与 `disposed` 区分「释放后重开」。 */
  const reopened = new Map()
  /** 当前存活**顶层**会话的 `sessionId → 节点 id`（`size` 即顶层会话数）。 */
  const live = new Map()
  /**
   * 最近一次写入/删除的值（`undefined` = 文件应不存在）：同值不重复触盘。
   *
   * **启动时取磁盘真值**（而不是留 `undefined`）：新进程里 `live` 为空，首次 `publish()` 算出的
   * `next` 是 `undefined`；若 `published` 也是 `undefined`，`next === published` 会让它**早退**，
   * 于是上一代进程留下的陈旧提示文件原样留在盘上——桥会按它把出站身份记到**早已不是当前会话**的
   * 旧节点上（真机事故：重启后 `dsh.current` 仍指向旧会话）。读一次磁盘即可消除这个窗口：
   * 陈旧值 ≠ `undefined` → 首次发布就会把文件删掉。
   */
  let published = readToken(path)

  /** 有界 FIFO 插入（重复插入不刷新年龄）。 */
  function remember(store, id, value) {
    store.delete(id)
    store.set(id, value)
    if (store.size > limit) {
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
  }

  /**
   * 出站身份应当指向的节点 id：**只在"恰好一个顶层会话"时给出**，否则一律 `undefined`。
   *
   * **fail-closed**（真机事故，安全级）：曾经在"多于一个"时取"最近进入 `running`"的会话——
   * 那是跨会话的 last-writer-wins 全局指针，等于把**谁的回合最后开始**当成**谁在说话**：
   * 同机两个会话并跑时，A 发出的消息会被挂到 B 名下（Hub 侧的归属、回执、ask 授权判定全部跟着错），
   * 即静默的**身份冒用**。任何"猜"都会制造这种污染，所以这里宁可**不给身份**：
   * 桥回落实例容器 id，Hub 会明确拒绝以容器为收件方的 DM（`container_not_chat_target`），
   * 错误显式可见、审计不被污染。
   *
   * 并发多会话下要精确归属，只有根治一条路：宿主原生工具面（每次调用天然带调用者上下文），
   * 见 `docs/adapters-guide.md` §5 第 3 条。
   */
  const currentNodeId = () => (live.size === 1 ? live.values().next().value : undefined)

  /**
   * 依据 {@link currentNodeId} 写/删提示文件：有确定对象 → 写其节点 id；无 → 删除。
   *
   * **发布前校验磁盘现值**（真机报告缺陷 7.4）：`published` 只是**进程内**记忆，
   * 另一进程/人工删除或改写文件后，仅凭它早退会让身份**永久**停留在回落（容器）态——
   * 例如补注册重试对同一会话再次 `onRegistered`（值不变）时正好早退。故同值也要看盘：
   * 盘中现值 === `next` 才跳过；否则重写/清除。文件操作失败只记日志（下次状态变化再试）。
   */
  function publish() {
    const next = currentNodeId()
    if (next === published && readToken(path) === next) return
    const result = next === undefined ? clearToken(path) : writeToken(path, next)
    if (!result.ok) log(`会话提示写入失败（继续）：${result.error ?? "unknown"}`)
    published = next
    log(next === undefined ? "会话提示已清除（顶层会话数为 0 或多于 1）" : `会话提示 = ${next}`)
  }

  return {
    /** 该会话是否在注册期被释放过（注册结束后据此放弃登记）。 */
    isDisposed: (sessionId) => disposed.has(sessionId),
    /**
     * `agent/created` 到达：该会话已「重开」，清除释放标记——否则重开后的会话注册会被误判为
     * 「注册期被释放」而永久拒绝登记。
     */
    noteReopened(sessionId) {
      reopened.set(sessionId, true)
      disposed.delete(sessionId)
    },
    /**
     * 注册收尾：注册期间被 `agent/disposed` 释放过（且此后没有新的 `agent/created`，即
     * `noteReopened` 未清除标记）→ 返回 `true`，调用方**不得**登记或上报 online。标记随即清除，
     * 因此只影响这一次在途注册。
     */
    reconcile(sessionId) {
      const wasDisposed = disposed.delete(sessionId)
      reopened.delete(sessionId)
      return wasDisposed
    },
    /** 该会话是否正是提示文件当前指向的对象（释放时只回退提示，不误删后来者的提示）。 */
    isCurrent: (sessionId) => live.get(sessionId) === currentNodeId(),
    /**
     * 注册成功：仅**顶层**会话纳入提示维护（子代理节点不参与「恰好一个」的计数，否则一个有子代理
     * 的会话会让提示消失；子代理本身也不该成为出站身份），随后按存活数发布提示文件。
     */
    onRegistered(sessionId, nodeId, topLevel) {
      if (!topLevel) return
      remember(live, sessionId, nodeId)
      publish()
    },
    /**
     * 释放：留「注册期被释放」标记（覆盖 `await` 竞态；只有新的 `agent/created` 能清除它），
     * 再摘除节点；随后按存活数重算提示（剩一个时自动改写为它的节点 id，否则删除提示）。
     */
    onDisposed(sessionId) {
      remember(disposed, sessionId, true)
      const nodeId = live.get(sessionId)
      if (nodeId === undefined) return
      live.delete(sessionId)
      publish()
    },
    /** 插件卸载：不再有存活会话 → 删除提示文件（键 = 节点 id，故整体清空）。 */
    clear() {
      live.clear()
      publish()
    },
  }
}
