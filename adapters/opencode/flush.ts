/**
 * idle 拉取闭环（Plan 5 修复 1 抽出，供 `session.idle` 事件与空闲轮询**同一路径**复用）：
 * 上报 idle 心跳 → `POST /internal/wake` 认领积压 → 逐条注入 → `POST /internal/result` 回执。
 *
 * 去重：`messageId` 有界去重集是唯一权威——Hub 的 `sending` 在途租约到期重投时，
 * 已注入的消息**绝不重复注入**，只幂等补回执。返回 `true` = 本轮 Hub 往返成功（供轮询器退避）。
 *
 * **形状容错（缺陷修复）**：`client.session.promptAsync` 的返回值可能被 SDK 包成
 * `{ data, error, request, response }`——此时**失败不会抛错**（错误在 `error` 字段）而旧代码只依赖
 * `try/catch`，导致注入失败被当作成功、`refused` 路径形同虚设、租约重投语义失效。现经
 * `unwrapResult` 判定：包装 `error` 有值 → `refused`（不写 `seen`）；204 成功无内容（裸
 * `undefined` 或空包装）→ `delivered`（**明确取舍**：`undefined` 无法与「无 error 的空返回」区分，
 * 按宿主 204 语义视为成功）。
 */
import { HubError, HubToolError, type Hub, type ResultItem } from "./hub"
import { unwrapResult } from "./sdk-result"
import type { OpencodeClient } from "./types"
import { formatInjection, type BoundedSet } from "./util"

/** 上游错误的审计字符串（`HubError`/`HubToolError` 带 `kind`/`code`）。 */
export function describe(error: unknown): string {
  if (error instanceof HubError) return `${error.kind}: ${error.message}`
  if (error instanceof HubToolError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

export interface IdleFlushDeps {
  readonly hub: Hub
  /** 注入入口（`client.session.promptAsync`）。 */
  readonly client: OpencodeClient
  /** 已成功注入的 messageId 有界去重集（租约重投不重复注入）。 */
  readonly seen: BoundedSet
  /** 同态上报即心跳触碰（每次轮询都发，刷新 `last_seen`）。 */
  readonly heartbeat: (agentId: string) => Promise<void>
  readonly log: (message: string) => void
}

/** 构造 `flushIdle(sessionID, agentId)`；返回 `false` = 本轮失败（供轮询器退避）。 */
export function createIdleFlush(
  deps: IdleFlushDeps,
): (sessionID: string, agentId: string) => Promise<boolean> {
  return async (sessionID, agentId) => {
    await deps.heartbeat(agentId)
    let messages
    try {
      messages = (await deps.hub.wake(agentId)).messages
    } catch (error) {
      deps.log(`wake failed: ${describe(error)}`)
      return false
    }
    if (messages.length === 0) return true
    const items: ResultItem[] = []
    for (const message of messages) {
      if (deps.seen.has(message.id)) {
        // 租约重投的重复消息：已注入过，绝不重复注入，仅补回执（幂等）。
        items.push({ messageId: message.id, result: "delivered" })
        continue
      }
      try {
        const raw: unknown = await deps.client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: formatInjection(message) }] },
        })
        const result = unwrapResult<unknown>(raw)
        // 只有「包装且 error 有值」才算失败；裸 `undefined`（204 无内容）按成功处理。
        if (!result.ok && result.error !== undefined) {
          deps.log(`inject failed for ${message.id}: ${describe(result.error)}`)
          items.push({ messageId: message.id, result: "refused" })
          continue
        }
        deps.seen.add(message.id)
        items.push({ messageId: message.id, result: "delivered" })
      } catch (error) {
        deps.log(`inject failed for ${message.id}: ${describe(error)}`)
        items.push({ messageId: message.id, result: "refused" })
      }
    }
    try {
      await deps.hub.reportResult(agentId, items)
      return true
    } catch (error) {
      deps.log(`result report failed: ${describe(error)}`)
      return false
    }
  }
}
