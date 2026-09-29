/**
 * 两阶段调度回归锁（`dispatchDue` 认领先行修复）：
 * - 阶段一（认领，同步）：同轮把**全部**到期 job 分流并推进 `sending`（回执「唤醒中」）；
 * - 阶段二（注入，顺序不变）：按 id 升序逐条 `await adapter.inject` + 结果落库/回执发布。
 *
 * 回归场景与 `tests/e2e/receipts.spec.ts` 的根因同构：低 id job 的 `inject` 永挂起时，
 * 高 id job 也必须**已被认领**——否则它永远停在 `pending`，回执恒 `queued`（修复前必红）。
 * 时间全部用注入时钟（`dispatcher.tick(now)`），无 sleep。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearAdapters,
  registerAdapter,
  type AdapterInjectResult,
  type AdapterState,
  type VendorAdapter,
} from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { Dispatcher } from "../../server/core/dispatcher"
import { receiptState, sendMessage } from "../../server/core/messaging"
import { insertAgent, type Agent } from "../../server/store/agents"
import type { Message } from "../../server/store/messages"
import { getWakeJob, type WakeJob } from "../../server/store/wake"

let home = ""
let db: Db
let adapter: GatedAdapter
let dispatcher: Dispatcher

/** 可挂起假适配器：放行前 `inject` 挂起；放行后（含其后的调用）立即 resolve。 */
class GatedAdapter implements VendorAdapter {
  readonly id = "opencode"
  readonly injectedBodies: string[] = []
  private resolvers: ((result: AdapterInjectResult) => void)[] = []
  private released: AdapterInjectResult | undefined

  start(): void {}
  reportState(_nodeId: string, _state: AdapterState): void {}
  inject(_nodeId: string, msgs: readonly Message[]): Promise<AdapterInjectResult> {
    for (const message of msgs) this.injectedBodies.push(message.body)
    if (this.released !== undefined) return Promise.resolve(this.released)
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  /** 放行：解锁已排队的注入，并让其后的注入立即完成。 */
  release(result: AdapterInjectResult): void {
    this.released = result
    for (const resolve of this.resolvers.splice(0)) resolve(result)
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-two-phase-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  adapter = new GatedAdapter()
  registerAdapter(adapter)
  dispatcher = new Dispatcher({ db, home })
})

afterEach(() => {
  dispatcher.stop()
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

function expectJob(messageSeq: number, agentId: string): WakeJob {
  const job = getWakeJob(db, messageSeq, agentId)
  if (job === undefined) throw new Error(`wake job missing for message ${messageSeq}`)
  return job
}

describe("two-phase dispatch (claim first, then inject)", () => {
  it("claims every due job to sending before awaiting any inject, even when the first inject hangs", async () => {
    const sender = makeAgent("phase-sender")
    const node = makeAgent("phase-node")
    const first = sendMessage(db, { from: sender.id, to: node.id, body: "first" }).message
    const second = sendMessage(db, { from: sender.id, to: node.id, body: "second" }).message

    // 调用即同步跑到首个 await（阶段一全程同步 → 阶段二首个 inject 挂起）。
    const tick = dispatcher.tick(Date.now() + 1000)
    try {
      // 阶段边界证据：第一条注入已被调用（已进入阶段二）。
      expect(adapter.injectedBodies).toEqual(["first"])
      // 关键断言：后到的 job 也已在同一 tick 内被认领（修复前：pending → 回执恒 queued）。
      expect(expectJob(first.seq, node.id)).toMatchObject({ state: "sending", attempts: 1 })
      expect(expectJob(second.seq, node.id)).toMatchObject({ state: "sending", attempts: 1 })
      expect(receiptState(db, second, node.id)).toBe("sending")
    } finally {
      adapter.release("delivered")
      await tick
    }
    // 放行后两条都完成注入（id 升序与旧版一致）→ 均落 accepted。
    expect(adapter.injectedBodies).toEqual(["first", "second"])
    expect(expectJob(first.seq, node.id).state).toBe("accepted")
    expect(expectJob(second.seq, node.id).state).toBe("accepted")
  })
})
