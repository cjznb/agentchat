/**
 * 四级回执的界面映射（spec §6.3；Plan 3 T5 决议 2）——纯函数，组件只消费。
 *
 * `queued（🕐）→ sending（✓）→ delivered（✓✓）→ read（蓝色 ✓✓）`；
 * `read` 是唯一以品牌绿强调的终态。阶段枚举单源在 `shared/contracts`，此处不新增。
 */
import type { ReceiptStage } from "../../shared/contracts"

/** 单个阶段的展示三元组。 */
export interface ReceiptGlyph {
  readonly glyph: string
  readonly label: string
  /** 语义色调，供 CSS `[data-tone]` 着色（`read` = 品牌绿）。 */
  readonly tone: "pending" | "progress" | "delivered" | "read"
}

const RECEIPT_GLYPHS = {
  queued: { glyph: "🕐", label: "排队中", tone: "pending" },
  sending: { glyph: "✓", label: "唤醒中", tone: "progress" },
  delivered: { glyph: "✓✓", label: "已送达", tone: "delivered" },
  read: { glyph: "✓✓", label: "已读", tone: "read" },
} as const satisfies Record<ReceiptStage, ReceiptGlyph>

/** 四级回执 → 图标 / 文案 / 色调（穷尽锁定阶段枚举）。 */
export function receiptGlyph(stage: ReceiptStage): ReceiptGlyph {
  return RECEIPT_GLYPHS[stage]
}
