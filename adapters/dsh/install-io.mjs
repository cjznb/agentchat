/**
 * DSH 安装器的极小 IO / 通用工具层：JSON 记录判定、错误文本、按需读文件。
 *
 * 与规划层（`install-plan.mjs`）、副作用层（`install-apply.mjs`）、CLI（`install.mjs`）分离，
 * 使每个文件都在本仓「单文件 ≤ 250 纯行」的红线内（见 CONTRIBUTING.md）。
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { existsSync, readFileSync } from "node:fs"

/** 普通对象判定（排除数组与 `null`）。 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 统一错误文本（`Error` → `message`，其它 → `String`）。 */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读文件；不存在 → `undefined`（在规划层 `undefined` 表示"该文件期望不存在"）。 */
export function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}
