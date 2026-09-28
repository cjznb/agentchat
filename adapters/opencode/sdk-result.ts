/**
 * 解包 OpenCode SDK 客户端方法的返回值（**形状容错**）。
 *
 * 实证（`@opencode-ai/sdk@1.18.32`，本机 `opencode-ai@1.18.32` 内置同一份）：
 * - 生成客户端 `dist/gen/client/client.gen.js` 仅在 `opts.responseStyle === "data"` 时返回裸数据；
 *   **否则返回 `{ data, error, request, response }` 包装**；且只有在 `opts.throwOnError` 为真时才抛错。
 * - 宿主 `createOpencodeClient`（`dist/client.js`）只做 `?directory=` 重写与 `x-opencode-directory` 头，
 *   **既未设 `responseStyle` 也未设 `throwOnError`** → 默认即 **fields 包装、不抛错**。
 * - 但宿主（打包单文件 exe）内部构造 client 时是否额外覆盖这两项**不可读**，故本适配器必须对
 *   **两种形状都容错**：包装（`{data,...}`）与裸值。
 *
 * 判定规则：`null`/`undefined` → 失败；`typeof === "object"` 且含 `data` 且含
 * `error`/`response`/`request` 之一 → 视为包装；其余 → 视为裸值成功。
 */
export interface Unwrapped<T> {
  readonly ok: boolean
  readonly data?: T
  readonly error?: unknown
}

/** 包装形状判别：对象、含 `data`、且含 `error`/`response`/`request` 任一（避免误判普通对象）。 */
function isWrapper(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (!("data" in value)) return false
  return "error" in value || "response" in value || "request" in value
}

/**
 * 把 `unknown` 收窄为可辨认结果。
 *
 * 裸值经 `as T` 收窄是本边界的**唯一必要断言**（调用方以泛型声明期望类型，运行时无法进一步验证）。
 * 包装形状用结构守卫判定，不依赖断言。
 */
export function unwrapResult<T>(value: unknown): Unwrapped<T> {
  if (value === null || value === undefined) return { ok: false }
  if (isWrapper(value)) {
    const error = value["error"]
    if (error !== undefined && error !== null) return { ok: false, error }
    const data = value["data"]
    if (data === undefined) return { ok: true }
    return { ok: true, data: data as T }
  }
  return { ok: true, data: value as T }
}
