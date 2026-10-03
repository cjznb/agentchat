// @vitest-environment jsdom
/**
 * P2-fix 轮回归锁（先红后绿）：
 * ① 成员行换行根因 —— .member-name flex basis 0 + 尾部控件 flex-shrink:0
 * ② 聊天栏边界 strong token（color-mix，禁裸 hex）+ 选中态 jade accent
 */
import { describe, expect, it } from "vitest"
import css from "../styles.css?raw"

/** 从 CSS 文本中截取某选择器的声明块（粗粒度：到下一个 `}`） */
function ruleBody(selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `选择器 ${selector} 应存在`).toBeGreaterThanOrEqual(0)
  const brace = css.indexOf("{", start)
  const end = css.indexOf("}", brace)
  return css.slice(brace, end + 1)
}

describe("P2-fix ① 成员行换行根因（flex basis0 + shrink0）", () => {
  it(".member-name 使用 flex: 1 1 0（基准0，长名不参与换行判定）", () => {
    const body = ruleBody(".member-name {")
    expect(body).toContain("flex: 1 1 0")
    expect(body).not.toContain("flex: 1 1 auto")
  })

  it.each([".member-icon", ".node-dot", ".member-rename", ".member-remove"])(
    "%s 含 flex-shrink: 0（尾部按钮不被挤出行）",
    (sel) => {
      expect(ruleBody(sel)).toContain("flex-shrink: 0")
    },
  )

  it(".member-rename-form 保留 flex: 1 0 100%（编辑态整行换行不变）", () => {
    expect(ruleBody(".member-rename-form")).toContain("flex: 1 0 100%")
  })
})

describe("P2-fix ② 聊天栏边界 strong token + 选中态 jade accent", () => {
  it("入root 定义 --color-hairline-strong（color-mix，紧邻 --color-hairline）", () => {
    expect(css).toContain("--color-hairline-strong: color-mix(")
    expect(css).toContain("var(--color-hairline-strong)")
    // 紧邻性：strong 定义出现在 --color-hairline 定义之后 200 字符内
    const hair = css.indexOf("--color-hairline:")
    const strong = css.indexOf("--color-hairline-strong:")
    expect(hair).toBeGreaterThanOrEqual(0)
    expect(strong).toBeGreaterThan(hair)
    expect(strong - hair).toBeLessThan(200)
  })

  it(".bubble-body 边框引用 strong token", () => {
    expect(ruleBody(".bubble-body")).toContain("var(--color-hairline-strong)")
  })

  it(".conversation-item[data-active=\"true\"] jade tint + inset box-shadow", () => {
    const body = ruleBody('.conversation-item[data-active="true"]')
    expect(body).toContain("color-mix(in srgb, var(--color-jade) 9%, var(--color-raised))")
    expect(body).toContain("box-shadow: inset var(--line-signal) 0 0 0 var(--color-jade)")
    expect(body).not.toMatch(/background:\s*var\(--color-raised\)\s*;/)
  })

  it("无新增裸 hex 颜色（全 token 化：hex 仅允许出现在 :root 定义区）", () => {
    // 修正原断言缺陷：整文件扫描会把 :root 既有 token 定义（#17181d 等）判为裸 hex，永红。
    // 语义收紧为「规则区零裸 hex」—— :root 之外出现任何 hex 即失败（本轮验证 HEX_OUTSIDE=0）。
    const body = css.replace(/\/\*[^*]*\*\//g, "")
    const rs = body.indexOf(":root {")
    const re = body.indexOf("}", rs)
    const outside = rs >= 0 ? body.slice(0, rs) + body.slice(re + 1) : body
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
  })
})
