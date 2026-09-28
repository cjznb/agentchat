/**
 * 缺陷 B（UI 断线韧性）store 侧接线单测：
 * - `createConnectionHandler`：状态透传 + 「此前首屏加载失败，连接成功后补跑首屏全量重拉」
 * - `installReconnectTriggers`：页面转可见 / 网络恢复在线时立即触发重连，卸载后解绑
 */
import { describe, expect, it } from "vitest"
import { INITIAL_RELOAD_PLAN } from "../api"
import { createConnectionHandler } from "../connection"
import type { ConnectionStatus } from "../ws"
import { installReconnectTriggers, type DocumentLike, type EventTargetLike } from "../visibility"

describe("createConnectionHandler", () => {
  it("forwards every status and reloads the initial plan only after a failed load", () => {
    const statuses: ConnectionStatus[] = []
    const plans: unknown[] = []
    let failed = true
    const handler = createConnectionHandler({
      dispatch: (status) => statuses.push(status),
      isLoadingFailed: () => failed,
      reload: (plan) => plans.push(plan),
    })

    handler("connecting")
    handler("connected")
    expect(plans).toEqual([INITIAL_RELOAD_PLAN]) // 首屏失败 → 连接成功后补拉

    plans.length = 0
    failed = false
    handler("connected")
    handler("retrying")
    expect(plans).toEqual([]) // 未失败 / 非 connected 不补拉
    expect(statuses).toEqual(["connecting", "connected", "connected", "retrying"])
  })
})

class FakeTarget implements EventTargetLike {
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? new Set()
    bucket.add(listener)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

class FakeDocument extends FakeTarget implements DocumentLike {
  visibilityState = "hidden"
}

describe("installReconnectTriggers", () => {
  it("triggers on becoming visible and on online, and unbinds on dispose", () => {
    let calls = 0
    const document = new FakeDocument()
    const window = new FakeTarget()
    const dispose = installReconnectTriggers(() => (calls += 1), { document, window })

    document.visibilityState = "hidden"
    document.emit("visibilitychange")
    expect(calls).toBe(0)

    document.visibilityState = "visible"
    document.emit("visibilitychange")
    expect(calls).toBe(1)

    window.emit("online")
    expect(calls).toBe(2)

    dispose()
    document.emit("visibilitychange")
    window.emit("online")
    expect(calls).toBe(2)
  })
})
