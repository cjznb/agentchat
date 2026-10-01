import { describe, expect, it } from "vitest"
import { formatInjection } from "../util"

describe("formatInjection（反寒暄规则注入，spec §15.5 落点 ①）", () => {
  const text = formatInjection({
    id: "m1",
    fromAgentId: "agent-a",
    conversationId: "c1",
    body: "正文内容",
  })

  it("每条注入都携带沟通规则行", () => {
    expect(text).toContain("沟通规则：消息须有信息增量")
    expect(text).toContain("禁纯回执/寒暄与复读循环")
    expect(text).toContain("确认请并入下一步")
  })

  it("规则行位于既有头部行之后、正文之前", () => {
    const lines = text.split("\n")
    expect(lines[0]).toContain("[AgentChat] 来自 agent-a 的消息")
    expect(lines[1]).toContain("沟通规则")
    expect(lines[2]).toContain("没有观众")
    expect(lines[3]).toContain("复述")
    expect(lines[4]).toBe("正文内容")
  })

  it("新增 R1/R2 行存在、顺序与关键短语（防空串）", () => {
    const lines = text.split("\n")
    const r1 = lines.findIndex((line) => line.includes("没有观众"))
    const r2 = lines.findIndex((line) => line.includes("复述"))
    expect(r1).toBeGreaterThan(1)
    expect(r2).toBeGreaterThan(r1)
    expect(lines[r1]).toContain("reply")
    expect((lines[r1] ?? "").trim()).not.toBe("")
    expect((lines[r2] ?? "").trim()).not.toBe("")
  })
})
