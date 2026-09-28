/**
 * 极简 store（Plan 3 T3；终审 F7 拆分）——useReducer + context，无第三方状态库。
 *
 * - 状态机在 `reducers/`（纯函数）；动作组在 `actions.ts`；本文件只做副作用接线
 *   （REST 重拉 + WS 生命周期）与 context 出口
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
import { INITIAL_RELOAD_PLAN, loadReload, type ReloadPlan } from "./api"
import { createActions, type StoreActions } from "./actions"
import { createConnectionHandler } from "./connection"
import { initialState, planReload, reducer, type AppState } from "./reducers"
import { installReconnectTriggers } from "./visibility"
import { browserSocketFactory, currentWsUrl, WsClient } from "./ws"

/** UI 组件消费面：状态 + 动作（动作定义在 `actions.ts`）。 */
export interface StoreValue extends StoreActions {
  readonly state: AppState
  reload(plan: ReloadPlan): void
  /** 错误态重试：重跑全量重拉并（若 WS 已终态）重启连接；成功后自动清除错误位。 */
  retry(): void
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
  // ref 更新移入 effect（F6）：render 期不得写 ref（并发/StrictMode 下 render 可被丢弃/重放）。
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const wsRef = useRef<WsClient | undefined>(undefined)

  const reload = useCallback((plan: ReloadPlan): void => {
    if (!planNeedsFetch(plan)) return
    void loadReload(plan)
      .then((patch) => dispatch({ type: "hydrate", patch }))
      .catch((error: unknown) => {
        // 真实错误信号：失败置错误位（成功 hydrate 清除），驱动可达的错误态 + 重试。
        dispatch({ type: "loadFailed" })
        console.warn("reload failed; keeping local state", error)
      })
  }, [dispatch])

  /** 错误态重试：全量重拉；未连接时立即重连（已连接则 no-op）。 */
  const retry = useCallback((): void => {
    if (stateRef.current.connection !== "connected") wsRef.current?.reconnectNow()
    reload(INITIAL_RELOAD_PLAN)
  }, [reload])

  // 首屏只拉一次：StrictMode 开发期会「setup→cleanup→setup」，ref（同实例保留）挡住第二次。
  const didInitialReload = useRef(false)
  useEffect(() => {
    if (didInitialReload.current) return
    didInitialReload.current = true
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
      // 连接成功且此前首屏加载失败 → 补跑全量重拉（缺陷 B：首屏失败后不再恢复）。
      onStatus: createConnectionHandler({
        dispatch: (status) => dispatch({ type: "connection", status }),
        isLoadingFailed: () => stateRef.current.loadError,
        reload,
      }),
    })
    wsRef.current = client
    client.start()
    // 页面转可见 / 网络恢复在线 → 立即重连（后台节流/长断网后的自愈）。
    const disposeTriggers = installReconnectTriggers(() => client.reconnectNow())
    return () => {
      disposeTriggers()
      client.stop()
      wsRef.current = undefined
    }
  }, [dispatch, reload])

  // 动作组：只依赖稳定引用（dispatch/reload）；stateRef 为 ref（读写其 .current）。
  const actions = useMemo(
    () => createActions({ dispatch, reload, stateRef }),
    [dispatch, reload],
  )

  const value = useMemo<StoreValue>(
    () => ({ state, reload, retry, ...actions }),
    [state, reload, retry, actions],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext)
  if (value === undefined) throw new Error("useStore must be used within StoreProvider")
  return value
}
