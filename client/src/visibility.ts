/**
 * 外部触发重连（Plan 5 修复 3，缺陷 B）——页面重新可见、网络恢复在线时立即尝试重连，
 * 避免浏览器后台节流/长时间断网后只能等下一次退避定时器。结构类型便于用假对象单测。
 */

/** 最小事件目标（`document`/`window` 的公共子集）。 */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** `document` 的最小结构（仅用 `visibilityState` 与事件订阅）。 */
export interface DocumentLike extends EventTargetLike {
  readonly visibilityState: string
}

export interface ReconnectTriggerTarget {
  readonly document?: DocumentLike
  readonly window?: EventTargetLike
}

/**
 * 安装可见性/在线触发器；返回解绑函数（组件卸载时调用）。
 * 缺省取全局 `document`/`window`（浏览器）；两者皆缺（如 SSR/单测）时仅返回空解绑函数。
 */
export function installReconnectTriggers(
  trigger: () => void,
  target: ReconnectTriggerTarget = {},
): () => void {
  const doc = target.document ?? (typeof document === "undefined" ? undefined : document)
  const win = target.window ?? (typeof window === "undefined" ? undefined : window)
  const onVisibility = (): void => {
    if (doc === undefined || doc.visibilityState === "visible") trigger()
  }
  const onOnline = (): void => trigger()
  doc?.addEventListener("visibilitychange", onVisibility)
  win?.addEventListener("online", onOnline)
  return () => {
    doc?.removeEventListener("visibilitychange", onVisibility)
    win?.removeEventListener("online", onOnline)
  }
}
