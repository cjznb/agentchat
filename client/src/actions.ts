/**
 * store 动作组（Plan 3 终审 F7 拆分自 `store.tsx`）——REST 副作用接线（重拉 / 发送 / 决议 /
 * 通知已读 / DM）。副作用集中在 `createActions`，`store.tsx` 只保留 reducer 装配、WS 生命周期
 * 与 context 出口。
 *
 * 真乐观插入（F4）：`sendMessage` 先以临时 id 入桶（即时气泡），成功后 `reconcile` 按服务端 id
 * 对账去重，失败 `rollback` 移除临时气泡（草稿由调用方保留）。
 */
import type { Dispatch, MutableRefObject } from "react"
import {
  ensureDm,
  loadMessages,
  markConversationRead as postConversationRead,
  markNotificationRead as postNotificationRead,
  respondAsk as postRespondAsk,
  decideApproval as postDecision,
  revokeMessage as postRevoke,
  sendMessage as postMessage,
  shout as postShout,
  type ReloadPlan,
} from "./api"
import type {
  ApprovalDecision,
  ApprovalEntry,
  ChatMessage,
  RespondAskInput,
  ShoutResult,
} from "../../shared/contracts"
import { buildRosterView } from "./chat"
import type { AppState, StoreAction } from "./reducers"

/** UI 组件消费的动作面（不含 state/reload/retry，那两个由 provider 直接提供）。 */
export interface StoreActions {
  openConversation(conversationId: string | null): void
  /** 点击会话行：打开 + 按需载入消息 + 推进已读位点（徽标经重拉清零）。 */
  openAndRead(conversationId: string): void
  /** 资料卡「发消息」：确保 human↔节点 DM（取或建，幂等）后打开；失败 reject（不切空视图）。 */
  openDm(nodeId: string): Promise<void>
  sendMessage(conversationId: string, body: string): Promise<void>
  /** 撤回排队中消息（仅发送方；尽力撤回）：成功后重拉该会话消息以带出撤回标记。 */
  revokeMessage(conversationId: string, messageId: string): Promise<void>
  /** 喊话频道发送（`POST /api/shout`，human 即时执行）；成功后消息入桶并重拉会话/回执。 */
  shoutBroadcast(body: string): Promise<ShoutResult>
  /** 上翻分页：拉取 `beforeSeq` 之前一页并入会话；返回本页条数（< 页大小 = 无更多）。 */
  loadOlder(conversationId: string, beforeSeq: number): Promise<number>
  markConversationRead(conversationId: string): Promise<void>
  /** 审批决议（卡内/通知页共用）：成功乐观置已决并重拉对账；失败重拉后抛出。 */
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<ApprovalEntry>
  /** 批示答复（卡内/通知页共用）：首答生效；409/400 抛出且重拉对账。 */
  respondAsk(askId: string, answer: RespondAskInput): Promise<ApprovalEntry>
  /** 通知标记已读（幂等）：请求成功后更新本地未读点；不阻塞跳转。 */
  markNotificationRead(id: string): Promise<void>
}

/** createActions 依赖（provider 注入稳定引用）。 */
export interface ActionDeps {
  readonly dispatch: Dispatch<StoreAction>
  readonly reload: (plan: ReloadPlan) => void
  readonly stateRef: MutableRefObject<AppState>
}

/** 临时消息 seq 基准：远高于服务端全局 seq，保证排在同会话既有消息之后。 */
let tempSeq = 2 ** 40

function newTempId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid === undefined ? `local:${String(Date.now())}-${Math.random().toString(16).slice(2)}` : `local:${uuid}`
}

function humanIdOf(state: AppState): string | null {
  return buildRosterView(state.roster).humanId
}

export function createActions({ dispatch, reload, stateRef }: ActionDeps): StoreActions {
  const openConversation = (conversationId: string | null): void => {
    dispatch({ type: "open", conversationId })
    if (conversationId !== null && !stateRef.current.messages.has(conversationId)) {
      reload({ roster: false, conversations: false, notifications: false, approvals: false, messages: [conversationId] })
    }
  }

  const markConversationRead = async (conversationId: string): Promise<void> => {
    await postConversationRead(conversationId)
    reload({ roster: false, conversations: true, notifications: false, approvals: false, messages: [] })
  }

  const openAndRead = (conversationId: string): void => {
    dispatch({ type: "open", conversationId })
    if (!stateRef.current.messages.has(conversationId)) {
      reload({ roster: false, conversations: false, notifications: false, approvals: false, messages: [conversationId] })
    }
    // 打开即标已读；重拉 conversations 后该会话/容器聚合徽标随之更新。
    void markConversationRead(conversationId)
  }

  const openDm = async (nodeId: string): Promise<void> => {
    // 不吞错（F3）：ensure 失败（含退役目标 409）向上 reject，由 UI 展示错误且不切空视图。
    const { conversation } = await ensureDm(nodeId)
    reload({ roster: false, conversations: true, notifications: false, approvals: false, messages: [] })
    openAndRead(conversation.id)
  }

  const sendMessage = async (conversationId: string, body: string): Promise<void> => {
    const tempId = newTempId()
    const temp: ChatMessage = {
      seq: tempSeq++,
      id: tempId,
      conversationId,
      fromAgentId: humanIdOf(stateRef.current) ?? "",
      body,
      kind: "text",
      createdAt: Date.now(),
    }
    dispatch({ type: "optimistic", chat: temp })
    try {
      const result = await postMessage(conversationId, body)
      dispatch({ type: "reconcile", tempId, chat: result.message })
    } catch (error) {
      dispatch({ type: "rollback", conversationId, tempId })
      throw error
    }
  }

  const revokeMessage = async (conversationId: string, messageId: string): Promise<void> => {
    await postRevoke(conversationId, messageId)
    reload({
      roster: false,
      conversations: false,
      notifications: false,
      approvals: false,
      messages: [conversationId],
    })
  }

  const shoutBroadcast = async (body: string): Promise<ShoutResult> => {
    const result = await postShout(body)
    if ("message" in result) {
      dispatch({ type: "message", chat: result.message })
      reload({ roster: false, conversations: true, notifications: false, approvals: false, messages: [result.message.conversationId] })
    }
    return result
  }

  const loadOlder = async (conversationId: string, beforeSeq: number): Promise<number> => {
    const page = await loadMessages(conversationId, beforeSeq)
    dispatch({ type: "prepend", conversationId, messages: page })
    return page.length
  }

  const decideApproval = async (approvalId: string, decision: ApprovalDecision): Promise<ApprovalEntry> => {
    try {
      const { approval } = await postDecision(approvalId, decision)
      dispatch({ type: "notifDecided", approval })
      reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
      return approval
    } catch (error) {
      // 409/404：本地已决态不变；重拉通知/审批列表与服务端对齐（对账式恢复）。
      reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
      throw error
    }
  }

  const respondAsk = async (askId: string, answer: RespondAskInput): Promise<ApprovalEntry> => {
    try {
      const { ask } = await postRespondAsk(askId, answer)
      dispatch({ type: "notifDecided", approval: ask })
      reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
      return ask
    } catch (error) {
      reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
      throw error
    }
  }

  const markNotificationRead = async (id: string): Promise<void> => {
    try {
      const result = await postNotificationRead(id)
      if (result.read) dispatch({ type: "notifRead", id, at: Date.now() })
    } catch (error) {
      console.warn("mark notification read failed", error)
    }
  }

  return {
    openConversation,
    openAndRead,
    openDm,
    sendMessage,
    revokeMessage,
    shoutBroadcast,
    loadOlder,
    markConversationRead,
    decideApproval,
    respondAsk,
    markNotificationRead,
  }
}
