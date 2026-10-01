/**
 * 带**名称冲突重试**的节点注册（Hub 的 `agents.name` 与展示名都有唯一索引）。
 *
 * 为什么需要：会话节点名由「工作目录名 + 会话 id 短标识」派生，原则上唯一，但仍有两种现实撞键——
 * ① 同目录两个会话 id 的短标识恰好相同（UUID 前 8 位不再是 DSH 的固定 `session-` 前缀后已极罕见）；
 * ② 上一代的同名节点还在（例如旧会话仍活着、或历史遗留节点未被清理）。
 * 撞名时 Hub 回 MCP 工具错误 `[name_taken]`，注册直接失败、该会话在 Hub 里不可见——这正是真机上
 * 发生的拒绝。此处**只重试一次**并追加会话 id 的短哈希后缀，保证确定性地拿到唯一名；
 * 第二次仍失败就把错误交回调用方（绝不循环）。
 *
 * @param {{register(args: Record<string, unknown>): Promise<{agentId: string, joinToken: string | undefined}>}} hub
 * @param {Record<string, unknown>} args 注册入参（`name` / `task_ref` 必填）
 * @param {(message: string) => void} log 诊断
 * @returns {Promise<{agentId: string, joinToken: string | undefined}>}
 */
import { createHash } from "node:crypto"
import { HubToolError } from "./hub.js"

/** 会话 id 的短哈希（6 位十六进制）：`task_ref` 不同则后缀不同。 */
function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 6)
}

export async function registerWithNameRetry(hub, args, log) {
  try {
    return await hub.register(args)
  } catch (error) {
    if (!(error instanceof HubToolError) || error.code !== "name_taken") throw error
    const base = String(args["name"])
    const taskRef = String(args["task_ref"])
    const alternate = { ...args, name: `${base}-${shortHash(taskRef)}` }
    log(`节点名「${base}」已被占用，改用「${alternate.name}」重试一次`)
    return hub.register(alternate)
  }
}
