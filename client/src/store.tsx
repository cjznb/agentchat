/**
 * 极简 store（Plan 3 T3）——useReducer + context，无第三方状态库。
 *
 * - 状态机在 `reducers.ts`（纯函数）；本文件只做副作用接线（REST 重拉 + WS 生命周期）
 * - WS 帧到达：先 `dispatch` 纯状态迁移，再按 `planReload` 执行对账式重拉
 * - 挂载时跑 `INITIAL_RELOAD_PLAN` 首屏全量；卸载停 WS
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react"
import {
  INITIAL_RELOAD_PLAN,
  decideApproval as postDecision,
  ensureDm,
  loadMessages,
  loadReload,
  markConversationRead as postConversationRead,
  markNotificationRead as postNotificationRead,
  respondAsk as postRespondAsk,
  sendMessage as postMessage,
  shout as postShout,
  type ReloadPlan,
} from "./api"
import type {
  ApprovalDecision,
  ApprovalEntry,
  RespondAskInput,
  ShoutResult,
} from "../../shared/contracts"
import { initialState, planReload, reducer, type AppState } from "./reducers"
import { browserSocketFactory, currentWsUrl, WsClient, type ConnectionStatus } from "./ws"

/** UI 组件消费面：状态 + 少量动作（后续任务按需扩展）。 */
export interface StoreValue {
  readonly state: AppState
  openConversation(conversationId: string | null): void
  /** 点击会话行：打开 + 按需载入消息 + 推进已读位点（徽标经重拉清零）。 */
  openAndRead(conversationId: string): void
  /** 资料卡「发消息」：确保 human↔节点 DM（取或建，幂等）后打开。 */
  openDm(nodeId: string): Promise<void>
  reload(plan: ReloadPlan): void
  sendMessage(conversationId: string, body: string): Promise<void>
  /** 喊话频道发送（`POST /api/shout`，human 即时执行）；成功后消息入桶并重拉会话/回执。 */
  shoutBroadcast(body: string): Promise<ShoutResult>
  /** 上翻分页：拉取 `beforeSeq` 之前一页并入会话；返回本页条数（< 页大小 = 无更多）。 */
  loadOlder(conversationId: string, beforeSeq: number): Promise<number>
  markConversationRead(conversationId: string): Promise<void>
  /** 审批决议（卡内/通知页共用）：成功乐观置已决并重拉对账；失败重拉后抛出（不改本地已决态）。 */
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<ApprovalEntry>
  /** 批示答复（卡内/通知页共用）：首答生效；409/400 抛出且重拉对账。 */
  respondAsk(askId: string, answer: RespondAskInput): Promise<ApprovalEntry>
  /** 通知标记已读（幂等，乐观清未读点）：不阻塞跳转。 */
  markNotificationRead(id: string): Promise<void>
}

const StoreContext = createContext<StoreValue | undefined>(undefined)

function planNeedsFetch(plan: ReloadPlan): boolean {
  return (
    plan.roster ||
    plan.conversations ||
    plan.notifications ||
    plan.approvals ||
    plan.messages.length > 0
  )
}

export function StoreProvider({ children }: { readonly children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const reload = useCallback((plan: ReloadPlan): void => {
    if (!planNeedsFetch(plan)) return
    void loadReload(plan)
      .then((patch) => dispatch({ type: "hydrate", patch }))
      .catch((error: unknown) => {
        console.warn("reload failed; keeping local state", error)
      })
  }, [dispatch])

  useEffect(() => {
    reload(INITIAL_RELOAD_PLAN)
  }, [reload])

  useEffect(() => {
    const client = new WsClient({
      url: currentWsUrl(),
      socketFactory: browserSocketFactory,
      onFrame: (frame) => {
        const plan = planReload(stateRef.current, frame)
        dispatch({ type: "frame", frame })
        reload(plan)
      },
      onStatus: (status: ConnectionStatus) => dispatch({ type: "connection", status }),
    })
    client.start()
    return () => client.stop()
  }, [dispatch, reload])

  const openConversation = useCallback(
    (conversationId: string | null): void => {
      dispatch({ type: "open", conversationId })
      if (conversationId !== null && !stateRef.current.messages.has(conversationId)) {
        reload({
          roster: false,
          conversations: false,
          notifications: false,
          approvals: false,
          messages: [conversationId],
        })
      }
    },
    [dispatch, reload],
  )

  const sendMessage = useCallback(
    async (conversationId: string, body: string): Promise<void> => {
      const result = await postMessage(conversationId, body)
      // 乐观 reconcile：入库返回的消息按 id 入桶（WS `message` 帧稍后到达时去重）。
      dispatch({ type: "message", chat: result.message })
    },
    [dispatch],
  )

  const shoutBroadcast = useCallback(
    async (body: string): Promise<ShoutResult> => {
      const result = await postShout(body)
      if ("message" in result) {
        // 乐观入桶 + 重拉回执：投递汇总由最新己方消息的逐收件方回执派生。
        dispatch({ type: "message", chat: result.message })
        reload({
          roster: false,
          conversations: true,
          notifications: false,
          approvals: false,
          messages: [result.message.conversationId],
        })
      }
      return result
    },
    [dispatch, reload],
  )

  const loadOlder = useCallback(
    async (conversationId: string, beforeSeq: number): Promise<number> => {
      const page = await loadMessages(conversationId, beforeSeq)
      dispatch({ type: "prepend", conversationId, messages: page })
      return page.length
    },
    [dispatch],
  )

  const markConversationRead = useCallback(
    async (conversationId: string): Promise<void> => {
      await postConversationRead(conversationId)
      reload({
        roster: false,
        conversations: true,
        notifications: false,
        approvals: false,
        messages: [],
      })
    },
    [reload],
  )

  const openAndRead = useCallback(
    (conversationId: string): void => {
      dispatch({ type: "open", conversationId })
      if (!stateRef.current.messages.has(conversationId)) {
        reload({
          roster: false,
          conversations: false,
          notifications: false,
          approvals: false,
          messages: [conversationId],
        })
      }
      // 打开即标已读；重拉 conversations 后该会话/容器聚合徽标随之更新。
      void markConversationRead(conversationId)
    },
    [dispatch, reload, markConversationRead],
  )

  const decideApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision): Promise<ApprovalEntry> => {
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
    },
    [dispatch, reload],
  )

  const respondAsk = useCallback(
    async (askId: string, answer: RespondAskInput): Promise<ApprovalEntry> => {
      try {
        const { ask } = await postRespondAsk(askId, answer)
        dispatch({ type: "notifDecided", approval: ask })
        reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
        return ask
      } catch (error) {
        reload({ roster: false, conversations: false, notifications: true, approvals: true, messages: [] })
        throw error
      }
    },
    [dispatch, reload],
  )

  const markNotificationRead = useCallback(
    async (id: string): Promise<void> => {
      try {
        const result = await postNotificationRead(id)
        if (result.read) dispatch({ type: "notifRead", id, at: Date.now() })
      } catch (error) {
        console.warn("mark notification read failed", error)
      }
    },
    [dispatch],
  )

  const openDm = useCallback(
    async (nodeId: string): Promise<void> => {
      try {
        const { conversation } = await ensureDm(nodeId)
        // 先重拉会话列表使新 DM 可见，再打开并按需载入消息 + 标已读。
        reload({
          roster: false,
          conversations: true,
          notifications: false,
          approvals: false,
          messages: [],
        })
        openAndRead(conversation.id)
      } catch (error) {
        console.warn("open dm failed", error)
      }
    },
    [openAndRead, reload],
  )

  const value = useMemo<StoreValue>(
    () => ({
      state,
      openConversation,
      openAndRead,
      openDm,
      reload,
      sendMessage,
      shoutBroadcast,
      loadOlder,
      markConversationRead,
      decideApproval,
      respondAsk,
      markNotificationRead,
    }),
    [
      state,
      openConversation,
      openAndRead,
      openDm,
      reload,
      sendMessage,
      shoutBroadcast,
      loadOlder,
      markConversationRead,
      decideApproval,
      respondAsk,
      markNotificationRead,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext)
  if (value === undefined) throw new Error("useStore must be used within StoreProvider")
  return value
}
