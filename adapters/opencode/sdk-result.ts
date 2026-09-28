/**
 * 解包 OpenCode SDK 客户端方法的返回值（**形状容错**）。
 *
 * 实证（`@opencode-ai/sdk@1.18.32`，`createOpencodeClient` + 假 `fetch` 实测）：
 * - 生成客户端 `dist/gen/client/client.gen.js` 仅在 `opts.responseStyle === "data"` 时返回裸数据；
 *   **否则返回 fields 包装**；且只有在 `opts.throwOnError` 为真时才抛错。
 * - 宿主 `createOpencodeClient`（`dist/client.js`）**既未设 `responseStyle` 也未设 `throwOnError`**
 *   → 默认即 **fields 包装、不抛错**（宿主打包 exe 内部是否额外覆盖不可读，故两种形状都容错）。
 * - **实测键集（关键）**：
 *   - 成功（如 `session.list` 成功）→ `{ data, request, response }`，**无 `error` 键**，`data` 为数组；
 *   - 失败（如 `session.get` / `session.promptAsync` 404）→ `{ error, request, response }`，
 *     **无 `data` 键**，`error` 为**已解析的错误体（普通对象**，如 `{error:"not found"}`），**且不抛错**。
 *   故「失败包装无 `data`」必须覆盖：任何以 `data` 存在为前提的判定都会把失败误判为「裸值成功」。
 *
 * 判定规则：`null`/`undefined` → 失败；对象（非数组）且含 `data`/`error`/`request`/`response`
 * **任一** → 视为包装；其余 → 视为裸值成功。包装 `error` 为显式 `null`/`undefined` 仍视为成功。
 */
export interface Unwrapped<T> {
  readonly ok: boolean
  readonly data?: T
  readonly error?: unknown
}

/**
 * 包装形状判别：对象、非数组，且含 `data`/`error`/`request`/`response` **任一**。
 *
 * **不得**以 `data` 存在为必要条件——实测失败包装 `{error,request,response}` 无 `data` 键，
 * 若要求 `data` 会把失败误判为裸值成功（缺陷根因）。裸 `Session`/裸 `Session[]` 不含这些键，
 * 且裸数组已被 `Array.isArray` 排除，故无假阳性。
 */
function isWrapper(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return "data" in value || "error" in value || "request" in value || "response" in value
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
