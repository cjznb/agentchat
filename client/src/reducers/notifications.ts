/**
 * 通知/审批 reducer 纯原语（Plan 3 终审 F7 拆分自 `state.ts`）——快照→视图、按 kind 分流、
 * 乐观已决/已读迁移。
 */
import type {
  ApprovalEntry,
  ApprovalKind,
  ApprovalSnapshot,
} from "../../../shared/contracts"
import { markEntryRead, upsertDecided } from "../cards"
import type { AppState } from "./state"

export function toApprovalEntry(snapshot: ApprovalSnapshot): ApprovalEntry {
  return {
    id: snapshot.id,
    requesterAgentId: snapshot.requesterAgentId,
    kind: "action",
    target: "human",
    action: snapshot.action,
    payload: snapshot.payload,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    ...(snapshot.decidedAt === null ? {} : { decidedAt: snapshot.decidedAt }),
  }
}

/** 审批帧按 `kind` 分流：`action` 入审批列（已决移除），`ask` 归通知列（经重拉）。 */
export function mergeApproval(
  list: readonly ApprovalEntry[],
  kind: ApprovalKind,
  approval: ApprovalSnapshot,
): readonly ApprovalEntry[] {
  if (kind !== "action") return list
  const rest = list.filter((entry) => entry.id !== approval.id)
  if (approval.status !== "pending") return rest
  return [...rest, toApprovalEntry(approval)].sort((a, b) => a.createdAt - b.createdAt)
}

/** 卡提交成功：已决单据并入全部列表，并从「需我处理」列表移除（乐观对账）。 */
export function applyNotifDecided(state: AppState, approval: ApprovalEntry): AppState {
  return {
    ...state,
    notifications: state.notifications.filter((entry) => entry.id !== approval.id),
    notificationsAll: upsertDecided(state.notificationsAll, approval),
  }
}

/** 通知已读（幂等置位 `readAt`；两 scope 同步）。 */
export function applyNotifRead(state: AppState, id: string, at: number): AppState {
  return {
    ...state,
    notifications: markEntryRead(state.notifications, id, at),
    notificationsAll: markEntryRead(state.notificationsAll, id, at),
  }
}
