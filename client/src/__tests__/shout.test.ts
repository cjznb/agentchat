/**
 * Plan 3 T7 —— `summarizeShout` 投递汇总矩阵单测：
 * 全在线 / 混合 / 全离场 / 空 / 未知阶段（含契约外新阶段不丢收件方）。
 */
import { describe, expect, it } from "vitest"
import { summarizeShout, type ShoutDelivery } from "../shout"

/** 便捷构造：`["a:read", "b:queued"]` → 回执数组（`stage` 可越出契约枚举以测未知）。 */
function deliveries(...pairs: readonly string[]): readonly ShoutDelivery[] {
  return pairs.map((pair) => {
    const [agentId, stage] = pair.split(":")
    return { agentId: agentId ?? "", stage: stage ?? "" }
  })
}

describe("summarizeShout", () => {
  it("全在线：delivered|read 均计入在线", () => {
    const summary = summarizeShout(deliveries("a:delivered", "b:read", "c:delivered"))
    expect(summary).toEqual({ online: 3, queued: 0, left: 0, unknown: 0, total: 3 })
  })

  it("混合：各桶独立计数且合计等于总数", () => {
    const summary = summarizeShout(
      deliveries("a:read", "b:sending", "c:queued", "d:delivered", "e:refused"),
    )
    expect(summary).toEqual({ online: 2, queued: 2, left: 1, unknown: 0, total: 5 })
    expect(summary.online + summary.queued + summary.left + summary.unknown).toBe(summary.total)
  })

  it("全离场：failed|refused|expired|cancelled 均计入离场", () => {
    const summary = summarizeShout(
      deliveries("a:failed", "b:refused", "c:expired", "d:cancelled"),
    )
    expect(summary).toEqual({ online: 0, queued: 0, left: 4, unknown: 0, total: 4 })
  })

  it("空：无收件方 → 全零", () => {
    expect(summarizeShout([])).toEqual({ online: 0, queued: 0, left: 0, unknown: 0, total: 0 })
  })

  it("未知阶段：契约外阶段计入 unknown，仍保留在 total（不静默丢弃）", () => {
    const summary = summarizeShout(deliveries("a:read", "b:teleported", "c:queued", "d:ghost"))
    expect(summary).toEqual({ online: 1, queued: 1, left: 0, unknown: 2, total: 4 })
    expect(summary.online + summary.queued + summary.left + summary.unknown).toBe(summary.total)
  })

  it("纯函数：不修改入参", () => {
    const input = deliveries("a:read", "b:queued")
    const snapshot = input.map((delivery) => ({ ...delivery }))
    summarizeShout(input)
    expect(input).toEqual(snapshot)
  })
})
