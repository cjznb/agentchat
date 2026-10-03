/**
 * P2 美观六项 · CSS 规则存在性门禁（TDD 红先行）。
 * 只断言 token 化规则文本，不解析渲染；styles.css 变更须保持全绿。
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")

/** 取出某段花括号块（from 匹配起点起的首个平衡块）。 */
function blockAfter(pattern: RegExp): string {
  const start = styles.search(pattern)
  if (start < 0) return ""
  const open = styles.indexOf("{", start)
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < styles.length; i += 1) {
    if (styles[i] === "{") depth += 1
    else if (styles[i] === "}") {
      depth -= 1
      if (depth === 0) return styles.slice(start, i + 1)
    }
  }
  return ""
}

describe("P2-1 群资料面板密度", () => {
  test(".group-info padding 收紧至 space-4", () => {
    const block = blockAfter(/^\.group-info\s*\{/m)
    expect(block).toMatch(/padding:\s*var\(--space-4\)/)
    expect(block).not.toMatch(/padding:\s*var\(--space-5\)/)
  })
})

describe("P2-2 气泡 max-width（用户拍板 36rem/80%）", () => {
  test(".bubble-col max-width = min(36rem, 80%)", () => {
    const block = blockAfter(/^\.bubble-col\s*\{/m)
    expect(block).toMatch(/max-width:\s*min\(\s*36rem\s*,\s*80%\s*\)/)
  })
})

describe("P2-3 窄视口 rail 指示条负 inset 收敛", () => {
  test("45rem 媒体块内 .rail-button::after bottom 收敛为 0", () => {
    const media = blockAfter(/@media\s*\(max-width:\s*45rem\)/)
    expect(media).not.toBe("")
    const idx = media.search(/\.rail-button::after\s*\{/)
    expect(idx).toBeGreaterThanOrEqual(0)
    const inset = (media.slice(idx).match(/inset:\s*[^;]+;/) ?? [""])[0]
    expect(inset).toMatch(/^inset:\s*auto\s+var\(--space-3\)\s+0\s*;$/)
  })
})

describe("P2-4 细窄滚动条", () => {
  test(".member-name 滚动条 thin + hairline/transparent 配色", () => {
    const block = blockAfter(/^\.member-name\s*\{/m)
    expect(block).toMatch(/scrollbar-width:\s*thin/)
    expect(block).toMatch(/scrollbar-color:\s*var\(--color-hairline\)\s+transparent/)
  })
  test(".member-name WebKit 滚动条 3px 定制（track 透明 + thumb hairline）", () => {
    const base = blockAfter(/^\.member-name::-webkit-scrollbar\s*\{/m)
    expect(base).toMatch(/width:\s*3px/)
    expect(base).toMatch(/background:\s*transparent/)
    const thumb = blockAfter(/^\.member-name::-webkit-scrollbar-thumb\s*\{/m)
    expect(thumb).toMatch(/background:\s*var\(--color-hairline\)/)
    expect(thumb).toMatch(/border-radius:\s*var\(--radius-small\)/)
  })
})

describe("P2-5 rail 指示条贴 rail 右缘（方案A 负 right）", () => {
  test("默认（桌面）.rail-button::after right 为负值延伸至 rail 边缘", () => {
    const block = blockAfter(/^\.rail-button::after\s*\{/m)
    expect(block).toMatch(/right:\s*(-|calc\()/)
    expect(block).not.toMatch(/right:\s*0\s*;/)
  })
})

describe("P2-6 改名输入描边照 .group-add-select token 模式", () => {
  test(".member-rename-input 具备 hairline 描边 + radius-medium", () => {
    const block = blockAfter(/^\.member-rename-input\s*\{/m)
    expect(block).toMatch(/border:\s*var\(--line-thin\)\s+solid\s+var\(--color-hairline\)/)
    expect(block).toMatch(/border-radius:\s*var\(--radius-medium\)/)
    expect(block).toMatch(/padding:\s*0\s+var\(--space-2\)/)
  })
  test(".member-rename-input focus-visible 焦点环存在", () => {
    const block = blockAfter(/^\.member-rename-input:focus-visible\s*\{/m)
    expect(block).toMatch(/outline/)
  })
})
