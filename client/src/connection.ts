/**
 * 连接状态接线（Plan 5 修复 3，缺陷 B）——WS 状态回调的纯工厂：
 * 先落状态；**连接成功且此前重拉失败**时补跑首屏全量重拉，避免「首屏失败后再也不恢复」。
 * 抽为工厂以便单测（store 只注入 dispatch / loadError 读取 / reload）。
 */
import { INITIAL_RELOAD_PLAN, type ReloadPlan } from "./api"
import type { ConnectionStatus } from "./ws"

export interface ConnectionHandlerDeps {
  readonly dispatch: (status: ConnectionStatus) => void
  /** 上一次重拉是否失败（store 的 `loadError`）。 */
  readonly isLoadingFailed: () => boolean
  readonly reload: (plan: ReloadPlan) => void
}

export function createConnectionHandler(
  deps: ConnectionHandlerDeps,
): (status: ConnectionStatus) => void {
  return (status) => {
    deps.dispatch(status)
    if (status === "connected" && deps.isLoadingFailed()) deps.reload(INITIAL_RELOAD_PLAN)
  }
}
