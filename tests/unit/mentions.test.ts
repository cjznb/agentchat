import { describe, expect, it } from "vitest"
import { type MentionTarget, type MentionsEcho, resolveMentions } from "../../shared/mentions"

const participants: MentionTarget[] = [
  { id: "71b336d7-aaaa-4bbb-8ccc-000000000001", name: "用户" },
  { id: "a1b2c3d4-1111-4222-8333-444455556666", name: "张三" },
  { id: "b2c3d4e5-1111-4222-8333-444455556666", name: "李四" },
  { id: "c3d4e5f6-1111-4222-8333-444455556666", name: "STM32H750 智能家居终端 OTA 阶段C接手" },
  { id: "d4e5f6a7-1111-4222-8333-444455556666", name: "标题 · abcd" },
]

function resolve(body: string, mentions?: string[]): MentionsEcho {
  return resolveMentions({ body, mentions, participants })
}

const allNames = participants.map((p) => p.name)

describe("resolveMentions — 正文 @ 解析", () => {
  it("命中普通 @名字 并回显 matched（名字全局唯一 → 精确比对）", () => {
    const echo = resolve("@张三 在吗")
    expect(echo.matched).toEqual([{ id: "a1b2c3d4-1111-4222-8333-444455556666", name: "张三" }])
    expect(echo.unmatched).toEqual([])
    expect(echo.scope).toBe("explicit")
  })

  it("名字含空格时按最长前缀整段命中", () => {
    const echo = resolve("@STM32H750 智能家居终端 OTA 阶段C接手 收到请回复")
    expect(echo.matched.map((t) => t.name)).toEqual(["STM32H750 智能家居终端 OTA 阶段C接手"])
    expect(echo.unmatched).toEqual([])
  })

  it("剔除末尾中英文标点：@张三， 与 @李四. 均命中且不留标点", () => {
    expect(resolve("@张三，走").matched.map((t) => t.name)).toEqual(["张三"])
    expect(resolve("@李四. 收到").matched.map((t) => t.name)).toEqual(["李四"])
    expect(resolve("@张三，").unmatched).toEqual([])
  })

  it("别名名 标题 · abcd 可命中（含空格与间隔点）", () => {
    const echo = resolve("@标题 · abcd 请评估")
    expect(echo.matched.map((t) => t.name)).toEqual(["标题 · abcd"])
    expect(echo.scope).toBe("explicit")
  })

  it("多个 @ 混排时全部命中", () => {
    const echo = resolve("@张三 @李四 大家好")
    expect(echo.matched.map((t) => t.name)).toEqual(["张三", "李四"])
  })

  it("@ 左邻 ASCII 字母数字（邮箱）时不视为提及", () => {
    const echo = resolve("联系 support@agentchat.dev 即可")
    expect(echo.matched).toEqual([])
    expect(echo.unmatched).toEqual([])
    expect(echo.scope).toBe("none")
  })
})

describe("resolveMentions — 全体关键字", () => {
  it("@所有人 → scope all 且 matched = 全体参与者", () => {
    const echo = resolve("@所有人 快看")
    expect(echo.scope).toBe("all")
    expect(echo.matched.map((t) => t.name)).toEqual(allNames)
  })

  it("@all（要求词边界）→ scope all", () => {
    expect(resolve("@all 请回答").scope).toBe("all")
    expect(resolve("@all，收到请回复").scope).toBe("all")
  })

  it('正文恰为 * 或结构化 "*" → scope all', () => {
    expect(resolve("*").scope).toBe("all")
    expect(resolve("收到", ["*"]).scope).toBe("all")
  })

  it("@allison 不是 @all：落入未命中且 scope 仍为 explicit", () => {
    const echo = resolve("@allison 在吗")
    expect(echo.scope).toBe("explicit")
    expect(echo.matched).toEqual([])
    expect(echo.unmatched).toEqual(["allison"])
  })

  it("全体关键字优先：与未命中并存时 scope=all 且错字仍回显", () => {
    const echo = resolve("@所有人 @错字")
    expect(echo.scope).toBe("all")
    expect(echo.unmatched).toEqual(["错字"])
    expect(echo.matched).toHaveLength(participants.length)
  })
})

describe("resolveMentions — id 兜底", () => {
  it("@<id 前 8 位> 命中", () => {
    const echo = resolve("@a1b2c3d4 说话")
    expect(echo.matched.map((t) => t.name)).toEqual(["张三"])
  })

  it("完整 id（正文，UUID 连字符为标点边界）命中", () => {
    const echo = resolve("@b2c3d4e5-1111-4222-8333-444455556666 请查收")
    expect(echo.matched.map((t) => t.name)).toEqual(["李四"])
  })

  it("结构化 mentions 支持完整 id 与前 8 位", () => {
    const byFullId = resolve("在吗", ["c3d4e5f6-1111-4222-8333-444455556666"])
    expect(byFullId.matched.map((t) => t.name)).toEqual(["STM32H750 智能家居终端 OTA 阶段C接手"])
    const byPrefix = resolve("在吗", ["a1b2c3d4"])
    expect(byPrefix.matched.map((t) => t.name)).toEqual(["张三"])
  })
})

describe("resolveMentions — 未命中与空提及", () => {
  it("未命中进 unmatched 且 scope 仍为 explicit", () => {
    const echo = resolve("@错字 你在吗")
    expect(echo.matched).toEqual([])
    expect(echo.unmatched).toEqual(["错字"])
    expect(echo.scope).toBe("explicit")
  })

  it("命中与未命中并存时两者都回显", () => {
    const echo = resolve("@张三 @错字")
    expect(echo.matched.map((t) => t.name)).toEqual(["张三"])
    expect(echo.unmatched).toEqual(["错字"])
    expect(echo.scope).toBe("explicit")
  })

  it("无任何提及 → scope none", () => {
    expect(resolve("大家好，今天进展如何")).toEqual({ matched: [], unmatched: [], scope: "none" })
    expect(resolve("")).toEqual({ matched: [], unmatched: [], scope: "none" })
    expect(resolve("你好", [])).toEqual({ matched: [], unmatched: [], scope: "none" })
  })

  it("结构化未命中进 unmatched 且 scope explicit", () => {
    const echo = resolve("在吗", ["不存在的名字"])
    expect(echo.unmatched).toEqual(["不存在的名字"])
    expect(echo.scope).toBe("explicit")
  })
})

describe("resolveMentions — 结构化与正文并集", () => {
  it("结构化 mentions 与正文解析取并集（同 id 去重）", () => {
    const echo = resolve("@张三 一起看", ["李四", "张三"])
    expect(echo.matched).toHaveLength(2)
    expect(echo.matched.map((t) => t.name).sort()).toEqual(["张三", "李四"].sort())
    expect(echo.unmatched).toEqual([])
    expect(echo.scope).toBe("explicit")
  })

  it("结构化用 id、正文用名字也并入同一结果", () => {
    const echo = resolve("@标题 · abcd 看", ["b2c3d4e5-1111-4222-8333-444455556666"])
    expect(echo.matched).toHaveLength(2)
    expect(echo.matched.map((t) => t.name).sort()).toEqual(["李四", "标题 · abcd"].sort())
  })
})
