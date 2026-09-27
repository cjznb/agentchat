/**
 * Plan 3 T5 决议 3 —— 深链解析纯函数单测（`?conversation=&msg=`）。
 * 覆盖：完整/缺参/空值/编码/无前导 `?`/未知参数忽略。
 */
import { describe, expect, it } from "vitest"
import { parseDeepLink } from "../deeplink"

describe("parseDeepLink", () => {
  it("解析 conversation 与 msg", () => {
    expect(parseDeepLink("?conversation=c1&msg=m1")).toEqual({ conversationId: "c1", messageId: "m1" })
  })

  it("无查询串 / 仅一项 → 其余为 null", () => {
    expect(parseDeepLink("")).toEqual({ conversationId: null, messageId: null })
    expect(parseDeepLink("?conversation=c1")).toEqual({ conversationId: "c1", messageId: null })
    expect(parseDeepLink("?msg=m1")).toEqual({ conversationId: null, messageId: "m1" })
  })

  it("空串与纯空白视为缺失（静默不跳）", () => {
    expect(parseDeepLink("?conversation=&msg=")).toEqual({ conversationId: null, messageId: null })
    expect(parseDeepLink("?conversation=%20%20")).toEqual({ conversationId: null, messageId: null })
  })

  it("解码 URI 编码并忽略未知参数", () => {
    expect(parseDeepLink("?foo=bar&conversation=a%20b&msg=m%2F1")).toEqual({
      conversationId: "a b",
      messageId: "m/1",
    })
  })

  it("接受省略前导 `?` 的裸查询串", () => {
    expect(parseDeepLink("conversation=c1&msg=m1")).toEqual({ conversationId: "c1", messageId: "m1" })
  })
})
