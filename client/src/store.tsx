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
  loadReload,
  markConversationRead as postConversationRead,
  sendMessage as postMessage,
  type ReloadPlan,
} from "./api"
import { initialState, planReload, reducer, type AppState } from "./reducers"
import { browserSocketFactory, currentWsUrl, WsClient, type ConnectionStatus } from "./ws"

/** UI 组件消费面：状态 + 少量动作（后续任务按需扩展）。 */
export interface StoreValue {
  readonly state: AppState
  openConversation(conversationId: string | null): void
  /** 点击会话行：打开 + 按需载入消息 + 推进已读位点（徽标经重拉清零）。 */
  openAndRead(conversationId: string): void
  reload(plan: ReloadPlan): void
  sendMessage(conversationId: string, body: string): Promise<void>
  markConversationRead(conversationId: string): Promise<void>
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
      await postMessage(conversationId, body)
    },
    [],
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

  const value = useMemo<StoreValue>(
    () => ({ state, openConversation, openAndRead, reload, sendMessage, markConversationRead }),
    [state, openConversation, openAndRead, reload, sendMessage, markConversationRead],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext)
  if (value === undefined) throw new Error("useStore must be used within StoreProvider")
  return value
}
