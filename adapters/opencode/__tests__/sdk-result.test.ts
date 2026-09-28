/**
 * `sdk-result.ts` / `flush.describe` 单测：锁定 `@opencode-ai/sdk@1.18.32` 的**真实键集**。
 *
 * 实测：成功包装 `{data,request,response}`（**无 `error`**，`data` 为数组）；失败包装
 * `{error,request,response}`（**无 `data`**，`error` 为普通对象且**不抛错**）。旧判定以 `data`
 * 存在为包装前提，失败包装被误判为「裸值成功」——本文件与 `plugin.test.ts` 共同锁死该回归。
 */
import { describe as describeError } from "../flush"
import { HubToolError } from "../mcp"
import { unwrapResult } from "../sdk-result"
import { HubError } from "../transport"
import { describe, expect, it } from "vitest"

describe("unwrapResult：真实包装键集", () => {
  it("成功包装 {data,request,response}（无 error）→ ok + data", () => {
    const rows = [{ id: "a" }, { id: "b" }]
    const result = unwrapResult<readonly { id: string }[]>({ data: rows, request: {}, response: {} })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(rows)
    expect(result.error).toBeUndefined()
  })

  it("失败包装 {error,request,response}（无 data）→ ok:false + error，绝不误判为裸值", () => {
    const body = { error: "not found" }
    const result = unwrapResult<unknown>({ error: body, request: {}, response: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toEqual(body)
    expect(result.data).toBeUndefined()
  })

  it("空包装 {data:undefined,error:undefined} → ok:true 且无 data（调用方降级）", () => {
    const result = unwrapResult<unknown>({ data: undefined, error: undefined, request: {}, response: {} })
    expect(result.ok).toBe(true)
    expect(result.data).toBeUndefined()
  })

  it("包装 error 为显式 null/undefined → 仍视为成功", () => {
    expect(unwrapResult<number>({ error: null, data: 7, request: {}, response: {} }).ok).toBe(true)
    expect(unwrapResult<number>({ error: null, data: 7, request: {}, response: {} }).data).toBe(7)
  })

  it("仅 request/response 的变体包装 → ok:true 且无 data", () => {
    const result = unwrapResult<unknown>({ request: {}, response: {} })
    expect(result.ok).toBe(true)
    expect(result.data).toBeUndefined()
  })
})

describe("unwrapResult：裸值与边界", () => {
  it("裸 Session 对象（无包装键）→ ok + 原值", () => {
    const session = { id: "s1", parentID: "p1" }
    const result = unwrapResult<typeof session>(session)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(session)
  })

  it("裸数组未被误判为包装 → ok + 数组", () => {
    const rows = [{ id: "s1" }]
    const result = unwrapResult<typeof rows>(rows)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(rows)
  })

  it("null/undefined → ok:false", () => {
    expect(unwrapResult(null).ok).toBe(false)
    expect(unwrapResult(undefined).ok).toBe(false)
  })
})

describe("describe：普通对象错误体不再 [object Object]", () => {
  it("普通对象 → JSON 字符串", () => {
    expect(describeError({ error: "not found" })).toBe('{"error":"not found"}')
  })

  it("超长对象 → 截断到 ≤200 字符", () => {
    const long = describeError({ msg: "x".repeat(500) })
    expect(long.length).toBeLessThanOrEqual(200)
  })

  it("循环引用 → 不抛错，回退 String", () => {
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    expect(() => describeError(circular)).not.toThrow()
    expect(describeError(circular)).toBe("[object Object]")
  })

  it("字符串原样返回、Error 取 message、我方错误带 kind/code", () => {
    expect(describeError("boom")).toBe("boom")
    expect(describeError(new Error("kaboom"))).toBe("kaboom")
    expect(describeError(new HubError("network", undefined, "down"))).toBe("network: down")
    expect(describeError(new HubToolError("bad_args", "nope"))).toBe("bad_args: nope")
    expect(describeError(undefined)).toBe("undefined")
  })
})
