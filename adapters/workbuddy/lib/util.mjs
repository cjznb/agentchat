/**
 * WorkBuddy 适配器共享小工具（无副作用、可单测）。
 *
 * 纯 JS（不参与 `tsc`）；只用 Node 内置模块；无第三方依赖。
 */

/** 普通对象守卫（排除 `null` 与数组）。 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 统一错误消息提取（`Error` 取 `message`，其余 `String()`）。 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 异步等待；`ms <= 0` 立即返回（hook 侧避免无谓延迟）。 */
export function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * 解析环境变量为整数并钳制到 `[min, max]`；非法/缺省回落 `fallback`。
 * 供 `AGENTCHAT_*` 系列开关使用（`0` 是合法值，故用 `Number.parseInt` 后判 `NaN`）。
 */
export function envInt(env, name, fallback, min, max) {
  const parsed = Number.parseInt(env[name] ?? "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * 布尔开关：`1`/`true`/`yes`/`on`（大小写不敏感）为真；`0`/`false`/`no`/`off` 为假；
 * 缺省/其余 → `fallback`。
 */
export function envFlag(env, name, fallback) {
  const raw = (env[name] ?? "").trim().toLowerCase()
  if (raw === "") return fallback
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  return fallback
}

/**
 * 从宿主会话 id 派生**稳定短标识**（指南 §7 坑 1）：
 * 先剥掉已知前缀（`session-` / `ses_` / `session_`），再取前 8 位；
 * 宿主 id 恰为纯 uuid 时不会因"前缀恰好 8 字符"而复用同一短标识。
 */
export function shortSessionId(sessionId) {
  const stripped = sessionId.replace(/^(session[-_]|ses_)/i, "")
  const body = stripped === "" ? sessionId : stripped
  return body.slice(0, 8) || "unknown"
}

/** 取最后一段路径作为可读目录名（`/`、`\` 双分隔符兼容；空白回落 `workbuddy`）。 */
export function baseNameOf(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "workbuddy"
  const parts = cwd.replace(/\\/g, "/").split("/").filter((part) => part !== "")
  const last = parts[parts.length - 1]
  return last === undefined || last === "" ? "workbuddy" : last
}
