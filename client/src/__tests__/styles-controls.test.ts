// @vitest-environment jsdom
/**
 * Task S1（样式轮）回归锁：`styles-controls.css` 表单控件 baseline。
 * 断言新 CSS 片段被加载、关键控件选择器存在、并含 :focus-visible 与 :hover 态，
 * 防止回退到浏览器原生默认样式。
 */
import { describe, expect, it } from "vitest"
import css from "../styles-controls.css?raw"

describe("styles-controls.css 表单控件 baseline", () => {
  it("文件非空", () => {
    expect(css.length).toBeGreaterThan(0)
  })

  it("覆盖全部 10 个原生控件类", () => {
    const selectors = [
      ".contact-rename-form",
      ".contact-rename",
      ".contact-rename-input",
      ".contact-rename-submit",
      ".contact-rename-cancel",
      ".member-rename-form",
      ".member-rename",
      ".member-rename-input",
      ".member-rename-submit",
      ".member-rename-cancel",
    ]
    for (const sel of selectors) {
      expect(css).toContain(sel)
    }
  })

  it("含 :focus-visible — 可见焦点环（无障碍）", () => {
    expect(css).toContain(":focus-visible")
  })

  it("含 :hover 态", () => {
    expect(css).toContain(":hover")
  })

  it("含 :active 与 :disabled 态", () => {
    expect(css).toContain(":active")
    expect(css).toContain(":disabled")
  })

  it("输入框使用 border-radius + var(--color-raised) 背景", () => {
    expect(css).toContain("border-radius: var(--radius-medium)")
    expect(css).toContain("background: var(--color-raised)")
  })

  it("提交按钮使用 jade 背景", () => {
    expect(css).toContain("background: var(--color-jade)")
  })

  it("表单容器为 flex 布局", () => {
    expect(css).toContain("display: flex")
  })

  it("仅使用既有 token — 无硬编码 hex 颜色", () => {
    // styles-controls.css 不应引入新的 hex 颜色值（排除注释中的十六进制引用）
    const body = css.replace(/\/\*[^*]*\*\//g, "")
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
  })
})
