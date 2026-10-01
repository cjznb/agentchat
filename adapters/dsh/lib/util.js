/**
 * DSH 适配器内部小工具：类型守卫、串行任务队列、有界去重集合、错误审计字符串。
 *
 * 队列为单消费者、保序、**错误自吞**——宿主的钩子只入队即返回（fire-and-forget），
 * 网络重试等耗时工作在后台串行推进，**不阻塞宿主事件循环**；`flush()` 供测试等待排空。
 *
 * 本模块不 import 任何网络/文件模块，是**叶子依赖**（唯一例外是 `describe` 对错误对象的
 * 结构判定走鸭子类型，见下）。
 */

/** 日志中 JSON 化上游错误体的最大长度（超出即截断，避免刷屏/泄漏大 payload）。 */
const DESCRIBE_MAX = 200

/** 普通对象守卫（非 `null`、非数组）。 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 有界去重集合（FIFO 淘汰最旧）。用于按 messageId 去重「在途租约重投」的消息：
 * 已成功注入的 id 记入，Hub 租约超时重投同一 id 时**绝不重复注入**，只幂等补回执。
 *
 * @param {number} limit 上限（超出即淘汰最早加入的 id）
 * @returns {{has(id: string): boolean, add(id: string): void, size(): number}}
 */
export function createBoundedSet(limit) {
  const ids = new Map()
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return
      ids.set(id, true)
      if (ids.size > limit) {
        const oldest = ids.keys().next().value
        if (oldest !== undefined) ids.delete(oldest)
      }
    },
    size: () => ids.size,
  }
}

/**
 * 串行任务队列（单消费者、保序、错误自吞）。
 *
 * @returns {{push(task: () => Promise<void>): void, flush(): Promise<void>}}
 */
export function createTaskQueue() {
  let tail = Promise.resolve()
  return {
    push(task) {
      tail = tail.then(task).catch(() => undefined)
    },
    async flush() {
      let previous
      do {
        previous = tail
        await previous
      } while (previous !== tail)
    },
  }
}

/**
 * 上游错误的审计字符串（**不抛错**，任何形状都能渲染）。
 *
 * - `HubError`（鸭类型：`kind` 为字符串且 `name === "HubError"`）→ `kind: message`；
 * - `HubToolError`（`name === "HubToolError"`）→ `code: message`；
 * - `Error` → `message`；字符串 → 原样；
 * - 其它（实测：宿主包装失败时给的是**已解析的普通对象**，如 `{error:"not found"}`）→ JSON 化并
 *   截断到 200 字符（`String(error)` 会得到 `[object Object]`，无审计价值）；
 * - 循环引用 / BigInt 等不可序列化 → 回退 `String(error)`。
 *
 * 判定走 `name` 鸭子类型而**不 import** `hub-config.js`：本模块保持叶子依赖，避免
 * `hub-config → util → hub-config` 循环。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describe(error) {
  if (error instanceof Error) {
    const name = error.name
    const kind = /** @type {{kind?: unknown}} */ (error)["kind"]
    if (name === "HubError" && typeof kind === "string") return `${kind}: ${error.message}`
    const code = /** @type {{code?: unknown}} */ (error)["code"]
    if (name === "HubToolError") return `${typeof code === "string" ? code : "undefined"}: ${error.message}`
    return error.message
  }
  if (typeof error === "string") return error
  try {
    const json = JSON.stringify(error)
    if (json !== undefined) return json.length > DESCRIBE_MAX ? json.slice(0, DESCRIBE_MAX) : json
  } catch {
    // 循环引用 / BigInt 等不可序列化 → 回退 String
  }
  return String(error)
}
