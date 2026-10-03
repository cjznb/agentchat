// @vitest-environment jsdom
/**
 * Task S1（样式轮）回归锁：`styles-controls.css` 表单控件 baseline。
 * 断言新 CSS 片段被加载、关键控件选择器存在、并含 :focus-visible 与 :hover 态，
 * 防止回退到浏览器原生默认样式。
 */
import { describe, expect, it } from "vitest"
// 预存在缺陷修复：`../styles-controls.css?raw` 在本仓 vitest 下解析为空串（HEAD 上基线
// 10 断言即 9 红）。改为 node:fs 直读原文 —— 断言内容零删除、语义不变。
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// vitest 下 import.meta.url 非 file scheme，改用 cwd 双候选（repo root / client）解析。
const cssPath = [resolve(process.cwd(), "src/styles-controls.css"), resolve(process.cwd(), "client/src/styles-controls.css")].find(existsSync)
if (!cssPath) throw new Error("styles-controls.css not found from " + process.cwd())
const css = readFileSync(cssPath, "utf8")

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

  it("Finding 1 回归锁：group-add-select 去原生箭头 + 本体背景层自绘箭头 + 可辨禁用态", () => {
    // 去除 OS 原生下拉箭头
    expect(css).toContain("appearance")
    // select 本体两层渐变三角合成实心 ▾（替换型控件无伪元素 → 禁用 ::after 回退）
    expect(css).toContain("background-image")
    expect(css).toContain("linear-gradient(45deg")
    expect(css).toContain("linear-gradient(135deg")
    expect(css).toContain("background-position")
    expect(css).toContain("background-size")
    expect(css).toContain("background-repeat: no-repeat")
    // 轮 3：正方形盒（45/135 绝对角 = 盒对角线）+ 两盒相邻 0.95 = 0.5 + 0.45 + 让位 1.55em
    expect(css).toContain("background-size: 0.45em 0.45em, 0.45em 0.45em")
    expect(css).toContain("background-position: right 0.95em center, right 0.5em center")
    expect(css).toContain("padding-right: 1.55em")
    expect(css).not.toContain(".group-add-select::after")
    // 禁用态独立规则 —— 与启用态肉眼可辨
    expect(css).toContain(".group-add-select:disabled")
    // 为自绘箭头留位
    expect(css).toContain("padding-right")
  })

  it("仅使用既有 token — 无硬编码 hex 颜色", () => {
    // styles-controls.css 不应引入新的 hex 颜色值（排除注释中的十六进制引用）
    const body = css.replace(/\/\*[^*]*\*\//g, "")
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
  })
})

// —— P2-fix 轮：成员行换行根因 + 聊天栏边界/选中态（styles.css） ——
import styles from "../styles.css?raw"

/** 提取某选择器规则块 {...} 的内容（不含花括号）；未命中返回 ""。 */
function ruleBlock(cssText: string, selectorSource: string): string {
  const re = new RegExp(`${selectorSource}\\s*\\{([^}]*)\\}`)
  const m = cssText.match(re)
  return m?.[1] ?? ""
}

describe("P2-fix 成员行换行根因（flex 基准 0 + shrink 0）", () => {
  it("member-name 使用 flex: 1 1 0（长名不再触发换行判定）", () => {
    const block = ruleBlock(styles, "\\.member-name")
    expect(block).toMatch(/flex:\s*1\s*1\s*0(?![0-9.])/)
  })

  it("尾部按钮/图标 flex-shrink: 0（不被压缩挤出行）", () => {
    for (const sel of ["\\.member-icon", "\\.node-dot", "\\.member-rename", "\\.member-remove"]) {
      const block = ruleBlock(styles, sel)
      expect(block, `${sel} 应含 flex-shrink: 0`).toContain("flex-shrink: 0")
    }
  })

  it("编辑态 member-rename-form 保持整行换行（flex: 1 0 100%）", () => {
    const block = ruleBlock(styles, "\\.member-rename-form")
    expect(block).toMatch(/flex:\s*1\s*0\s*100%/)
  })
})

describe("P2-fix 聊天栏边界 strong token 与选中态 jade accent", () => {
  it(":root 定义 --color-hairline-strong（color-mix 基于 ink）", () => {
    expect(styles).toContain("--color-hairline-strong:")
    expect(styles).toMatch(
      /--color-hairline-strong:\s*color-mix\(in srgb,\s*var\(--color-ink\)\s+\d+%/,
    )
  })

  it("bubble-body 边框引用 hairline-strong", () => {
    const block = ruleBlock(styles, "\\.bubble-body")
    expect(block).toContain("var(--color-hairline-strong)")
  })

  it("会话选中态为 jade tint 背景 + inset 左缘 accent", () => {
    const block = ruleBlock(styles, String.raw`\.conversation-item\[data-active="true"\]`)
    expect(block).toContain("color-mix(in srgb, var(--color-jade) 9%")
    expect(block).toContain("box-shadow: inset var(--line-signal) 0 0 0 var(--color-jade)")
  })
})
