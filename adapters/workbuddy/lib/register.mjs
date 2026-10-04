/**
 * 节点注册：实例（容器）节点的懒注册 + `join_token` 认领，会话节点的懒注册 + 收养。
 *
 * 节点模型（指南 §2）：
 * ```
 * workbuddy@<host>               根，role_tag=container，join_token 落盘认领
 * └─ <目录名>-<会话短标识>        会话节点，task_ref = WorkBuddy session_id（重启/续聊稳定）
 * ```
 *
 * 纪律：
 * - **整个任务体放进 try/finally**（指南 §7 坑 2：注册失败若在 try 之前 return，会留下在途记录永不清理）；
 * - `invalid_join_token` → 清 token 按"首次注册"重来，**保留 `.id`**（不新建根）；
 * - `name_taken` → 以**稳定别名**重试**一次**（坑 1）；
 * - 任何失败只记日志，绝不抛给宿主。
 */
import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { mcpRegister } from "./hub.mjs"
import { VENDOR } from "./paths.mjs"
import { aliasedName, instanceName, sessionName } from "./session-hint.mjs"
import { readJson, readText, removeFile, writeJson, writeText, writeToken } from "./token.mjs"
import { errorMessage, isRecord, shortSessionId } from "./util.mjs"

/** 本机主机名；异常/空 → `undefined`（`instanceName` 再回落可读名 `workbuddy`）。 */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return undefined
  }
}

/** 实例名的可读基名：`AGENTCHAT_INSTANCE_NAME` 可覆盖（多实例共存时用）。 */
export function instanceBaseName() {
  const override = process.env["AGENTCHAT_INSTANCE_NAME"]
  return override !== undefined && override.trim() !== "" ? override.trim() : instanceName(safeHostname())
}

/**
 * 根节点注册参数（`role_tag=container` 标记为分组容器，不是聊天对象）。
 *
 * `suffix` 是 **§7 坑 1 在根节点上的推广**：`agents.name` 全局唯一，而 `retire` 是**单向门**
 * —— 上一次实例节点被退役（或 join_token 丢失后重建）会让 `workbuddy@<host>` 这个名字
 * **永久占位**，此后每次根注册都 `name_taken`。故撞名时生成一个**持久化**后缀并复用，
 * 既绕开占位，又保证"重复启动仍是同一个节点"。
 */
function rootArgs(joinToken, suffix) {
  const base = instanceBaseName()
  const name = suffix === undefined || suffix === "" ? base : `${base}#${suffix}`
  const args = { vendor: VENDOR, purpose: "coding-agent", name, role_tag: "container" }
  return joinToken === undefined ? args : { ...args, join_token: joinToken }
}

/** 生成并持久化实例名后缀（只生成一次；此后每次启动稳定复用它）。 */
function instanceSuffix(paths) {
  const existing = readText(paths.instance)
  if (existing !== undefined) return existing
  const value = randomBytes(3).toString("hex")
  writeText(paths.instance, value)
  return value
}

/** 认领失败中"换一条路即可自愈"的错误码（其余按真实故障上报）。 */
const RECLAIM_CODES = ["invalid_join_token", "retired", "agent_not_found"]

function isReclaimable(error) {
  return error instanceof Error && typeof error.code === "string" && RECLAIM_CODES.includes(error.code)
}

/** 读会话映射台账（`{ [sessionId]: {agentId, name, at} }`）；缺失/损坏 → `{}`。 */
export function readSessions(paths) {
  const value = readJson(paths.sessions)
  return isRecord(value) ? value : {}
}

/** 写入某会话的映射（合并式：不动其它会话条目）。 */
export function writeSession(paths, sessionId, entry) {
  const sessions = readSessions(paths)
  sessions[sessionId] = { ...entry, at: Date.now() }
  writeJson(paths.sessions, sessions)
}

/**
 * 确保实例（容器）节点已注册并返回其 id；`join_token` 落盘供下次重连**认领同一节点**。
 *
 * 自愈阶梯（每一步都只走一次，绝不循环）：
 * 1. 有 token → `register{join_token}` 认领；遇 `invalid_join_token` / `retired` / `agent_not_found`
 *    → 删 token（**保留 `.id` 与 `.instance`**）改走"首次注册"；
 * 2. 无 token → 以 `workbuddy@<host>` 首次注册；遇 `name_taken` → 生成并持久化后缀重试一次。
 */
export async function ensureInstance(config, paths, log) {
  try {
    return await registerInstance(config, paths, log)
  } catch (error) {
    log(`ensureInstance failed: ${errorMessage(error)}`)
    return undefined
  } finally {
    // 指南 §7 坑 2：任务体全部在 try 内，finally 保证无在途残留。
  }
}

async function registerInstance(config, paths, log) {
  const token = readText(paths.token)
  const stored = readText(paths.instance)
  if (token !== undefined) {
    // 认领时**必须带同一个持久化后缀**：Hub 的收养按 `task_ref`/`join_token` 命中既有节点并
    // 用入参里的 `name` 更新卡片——若这里回退成不带后缀的名字，反而会撞上那个占位的旧名字。
    try {
      return await settleInstance(paths, log, await mcpRegister(config, rootArgs(token, stored)))
    } catch (error) {
      if (!isReclaimable(error)) throw error
      log(`instance token rejected (${String(error.code)}); clearing and re-registering as root`)
      removeFile(paths.token)
    }
  }
  try {
    return await settleInstance(paths, log, await mcpRegister(config, rootArgs(undefined, stored)))
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "name_taken") throw error
    const suffix = stored ?? instanceSuffix(paths)
    log(`instance name taken; registering as ${instanceBaseName()}#${suffix}`)
    return await settleInstance(paths, log, await mcpRegister(config, rootArgs(undefined, suffix)))
  }
}

/** 落盘实例 id 与 join_token（写失败只记日志，不影响本次可用性）。 */
function settleInstance(paths, log, registered) {
  const idWrite = writeText(paths.agentId, registered.agentId)
  if (!idWrite.ok) log(`instance id write failed: ${idWrite.error}`)
  if (registered.joinToken !== undefined) {
    const tokenWrite = writeToken(paths.token, registered.joinToken)
    if (!tokenWrite.ok) log(`token write failed: ${tokenWrite.error}`)
  }
  return registered.agentId
}

/** 会话节点名（剥前缀再截断，避免 `session-<uuid>` 同目录撞名）。 */
export function sessionNodeName(cwd, sessionId) {
  return sessionName(cwd, shortSessionId(sessionId))
}

/**
 * 确保会话节点已注册（懒注册 + 收养）并返回 `{agentId, containerId}`。
 * 已映射 → 直接返回（**不重复注册**，避免刷请求）。
 */
export async function ensureSession(config, paths, input, log) {
  const containerId = await ensureInstance(config, paths, log)
  if (containerId === undefined) return undefined
  const mapped = readSessions(paths)[input.sessionId]
  if (isRecord(mapped) && typeof mapped.agentId === "string") {
    return { agentId: mapped.agentId, containerId }
  }
  const name = sessionNodeName(input.cwd, input.sessionId)
  const attempt = (registerName) =>
    mcpRegister(config, { vendor: VENDOR, parent_ref: containerId, task_ref: input.sessionId, name: registerName })
  try {
    const result = await attempt(name)
    writeSession(paths, input.sessionId, { agentId: result.agentId, name })
    return { agentId: result.agentId, containerId }
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "name_taken") {
      log(`session register failed for ${input.sessionId}: ${errorMessage(error)}`)
      return { agentId: containerId, containerId, degraded: true }
    }
    const alias = aliasedName(name, input.sessionId)
    try {
      const result = await attempt(alias)
      log(`session ${input.sessionId} name taken; registered as "${alias}"`)
      writeSession(paths, input.sessionId, { agentId: result.agentId, name: alias })
      return { agentId: result.agentId, containerId }
    } catch (retryError) {
      log(`session register failed for ${input.sessionId}: ${errorMessage(retryError)}`)
      return { agentId: containerId, containerId, degraded: true }
    }
  }
}

/** 已注册的会话节点 id（只读台账）；未映射 → `undefined`。 */
export function mappedSessionAgentId(paths, sessionId) {
  const mapped = readSessions(paths)[sessionId]
  return isRecord(mapped) && typeof mapped.agentId === "string" ? mapped.agentId : undefined
}
