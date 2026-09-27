/**
 * Plan 3 T5 —— 四级回执 stage→图标映射单测（spec §6.3）。
 * 断言逐阶段映射、与锁定枚举零漂移、`read` 唯品牌绿终态。
 */
import { describe, expect, it } from "vitest"
import { RECEIPT_STAGES } from "../../../shared/contracts"
import { receiptGlyph } from "../receipts"

describe("receiptGlyph（stage→图标映射）", () => {
  it("逐阶段映射图标、文案与色调", () => {
    expect(receiptGlyph("queued")).toEqual({ glyph: "🕐", label: "排队中", tone: "pending" })
    expect(receiptGlyph("sending")).toEqual({ glyph: "✓", label: "唤醒中", tone: "progress" })
    expect(receiptGlyph("delivered")).toEqual({ glyph: "✓✓", label: "已送达", tone: "delivered" })
    expect(receiptGlyph("read")).toEqual({ glyph: "✓✓", label: "已读", tone: "read" })
  })

  it("覆盖每个锁定阶段（RECEIPT_STAGES 增变体必暴露）", () => {
    expect(RECEIPT_STAGES).toHaveLength(4)
    for (const stage of RECEIPT_STAGES) {
      expect(receiptGlyph(stage).label).not.toBe("")
      expect(receiptGlyph(stage).glyph).not.toBe("")
    }
  })

  it("read 是唯一品牌绿终态；delivered 与其同 glyph 但色调不同", () => {
    const readTones = RECEIPT_STAGES.filter((stage) => receiptGlyph(stage).tone === "read")
    expect(readTones).toEqual(["read"])
    expect(receiptGlyph("delivered").glyph).toBe(receiptGlyph("read").glyph)
    expect(receiptGlyph("delivered").tone).not.toBe(receiptGlyph("read").tone)
  })
})
