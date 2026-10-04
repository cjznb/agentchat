/**
 * 文件日志：`<home>/logs/workbuddy-adapter.log`，超 1 MiB 轮转（只保留一份 `.1`）。
 *
 * 纪律（指南 §4 骨架）：诊断**只落文件**。hook 脚本的 stdout 属于宿主协议通道
 * （Stop 的决策 JSON），MCP 桥的 stdout 恒为 JSON-RPC 帧 —— 任何日志写 stdout 都会污染宿主。
 * 日志本身失败也绝不抛错（不得影响宿主）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { adapterPaths } from "./paths.mjs"

/** 轮转阈值：1 MiB（与 OpenCode / Claude Code 适配器对齐）。 */
export const LOG_ROTATE_BYTES = 1024 * 1024

/**
 * 追加一行带 ISO 时间戳的日志。`tag` 用于区分来源（`stop` / `bridge` / …），缺省不写。
 * 任何异常（目录不可建、文件被占用）都被吞掉 —— 日志不得影响宿主。
 */
export function appendLog(home, message, tag) {
  try {
    const path = adapterPaths(home).log
    mkdirSync(dirname(path), { recursive: true })
    try {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat !== undefined && stat.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // 轮转失败（Windows 文件被占用等）不阻断本次追加
    }
    const prefix = tag === undefined ? "" : `[${tag}] `
    appendFileSync(path, `${new Date().toISOString()} ${prefix}${message}\n`)
  } catch {
    // 忽略：日志失败不得影响宿主
  }
}

/** 建一个绑定 `home` 与 `tag` 的日志器（桥 / 长驻逻辑用，避免到处传 home）。 */
export function createLogger(home, tag) {
  return (message) => appendLog(home, message, tag)
}
