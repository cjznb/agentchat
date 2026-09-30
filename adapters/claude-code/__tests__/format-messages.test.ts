import { describe, expect, it } from "vitest"
// 直接 import 生产 `.mjs`（与 hook 同源；vitest/Vite 原生支持 ESM，见 read-retry.test.ts 同款）
import { formatMessages } from "../common.mjs"

describe("formatMessages（反寒暄规则注入，spec §15.5 Claude 落点）", () => {
  const text = formatMessages([{ id: "m1", fromAgentId: "agent-a", body: "正文内容" }])

  it("输出包含 §15 规则行（与 OpenCode 侧 util.ts 同文案）", () => {
    expect(text).toContain("沟通规则：消息须有信息增量")
    expect(text).toContain("禁纯回执/寒暄与复读循环")
    expect(text).toContain("确认请并入下一步")
  })

  it("规则行位于头行之后、消息行之前（逐行顺序 + 关键词防空串）", () => {
    const lines = text.split("\n")
    expect(lines[0]).toContain("你收到了以下来自其他 agent 的消息")
    expect(lines[1]).toMatch(/信息增量|寒暄|复读/)
    expect(lines[1]).toContain("沟通规则")
    expect(lines[2]).toBe("- [m1] 来自 agent-a：正文内容")
  })
})
