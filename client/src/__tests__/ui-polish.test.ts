// @vitest-environment jsdom
/**
 * UI-1（feat/ui-polish）CSS/组件门禁：每个阶段只断言**该阶段新增的可辨识性规则**，
 * 与 `p2-style.test.ts` / `styles-controls.test.ts` 同为"规则存在性锁"，不解析渲染。
 *
 * ① 可辨识与反馈：容器行压暗 + 横杠勾选框 + 行尾 hint；状态图例；禁用主按钮灰底描边。
 */
import { describe, expect, it } from "vitest"
import css from "../styles.css?raw"
import controls from "../styles-controls.css?raw"

/** 取以 `prefix` 开头、到下一个 `}` 的块（prefix 末尾带逗号即可锁定**分组规则**）。 */
function tailBlock(text: string, prefix: string): string {
  const start = text.indexOf(prefix)
  expect(start, `规则 ${prefix} 应存在`).toBeGreaterThanOrEqual(0)
  const brace = text.indexOf("{", start)
  const end = text.indexOf("}", brace)
  return text.slice(brace, end + 1)
}

/**
 * 收集某**单个**选择器的全部规则块（同一选择器可能有多条：基础态/禁用态/压暗组等），
 * 用正则要求选择器后紧跟 `{`，避免命中外层分组规则的某一行。
 */
function allBlocks(text: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = [...text.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
  expect(matches.length, `选择器 ${selector} 的规则块应存在`).toBeGreaterThan(0)
  return matches.map((match) => match[1] ?? "").join(" ")
}

describe("UI-1 ①-1 容器行禁用态（压暗 45% + 横杠勾选框 + 行尾 hint）", () => {
  it("容器行以 data-container 选择器压暗（45%）", () => {
    // `.picker-name` 只出现在分组规则里（其后是逗号），用 tailBlock 取整条分组规则。
    const block = tailBlock(css, '.picker-row[data-container="true"] > .picker-head .picker-name')
    expect(block).toContain("opacity: 0.45")
    // 容器行 cursor 明示不可选
    expect(allBlocks(css, '.picker-row[data-container="true"] > .picker-head .picker-label')).toContain(
      "cursor: not-allowed",
    )
  })

  it("压暗限定在本行自身（`> .picker-head`），不波及容器子树里的会话子节点", () => {
    // 容器 `<li>` 里嵌套着子行 `<ul class="picker-children">`；后代选择器会把子行一起压暗。
    expect(css).toContain('.picker-row[data-container="true"] > .picker-head .picker-name')
    expect(css).not.toContain('.picker-row[data-container="true"] .picker-name')
    expect(css).not.toContain('.picker-row[data-container="true"] .picker-check')
  })

  it("容器勾选框换成 token 横杠图形（appearance:none，无裸 hex/伪元素）", () => {
    const block = allBlocks(css, '.picker-row[data-container="true"] > .picker-head .picker-check')
    expect(block).toContain("appearance: none")
    expect(block).toContain("background-image: linear-gradient(var(--color-muted)")
    expect(block).toContain("cursor: not-allowed")
    expect(block).not.toContain("::before")
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  it("行尾 hint 为可见胶囊（不能只靠 title）", () => {
    const block = allBlocks(css, ".picker-hint")
    expect(block).toContain("color: var(--color-muted)")
    expect(block).toContain("white-space: nowrap")
  })

  it("hint 撑宽时 meta 允许换行（层1 零 X 溢出的前提）", () => {
    expect(allBlocks(css, ".picker-meta")).toContain("flex-wrap: wrap")
  })
})

describe("UI-1 ①-2 状态图例", () => {
  it("legend 为可换行的行内图例（四项点 + 文案）", () => {
    const block = allBlocks(css, ".picker-legend")
    expect(block).toContain("display: flex")
    expect(block).toContain("flex-wrap: wrap")
    expect(allBlocks(css, ".picker-legend-item")).toContain("display: inline-flex")
  })
})

describe("UI-1 ①-4 禁用主按钮统一（描边 + 灰底，取代 jade 填充 + 透明度）", () => {
  const disabledBlock = tailBlock(css, ".member-add-confirm:disabled,")
  const selectors = [
    ".member-add-confirm:disabled",
    ".group-submit:disabled",
    ".composer-send:disabled",
    ".card-button:disabled",
    ".card-custom-send:disabled",
    ".settings-action:disabled",
    ".settings-danger:disabled",
    ".contact-action:disabled",
    ".group-add-button:disabled",
  ]

  it("共用一条规则：灰底 color-mix + hairline 描边 + 不透明 + not-allowed", () => {
    expect(disabledBlock).toContain(
      "background: color-mix(in srgb, var(--color-muted) 12%, var(--color-raised))",
    )
    expect(disabledBlock).toContain("border: var(--line-thin) solid var(--color-hairline)")
    expect(disabledBlock).toContain("color: var(--color-muted)")
    expect(disabledBlock).toContain("opacity: 1")
    expect(disabledBlock).toContain("cursor: not-allowed")
    expect(disabledBlock).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  it("覆盖各入口禁用选择器（含 styles-controls 的改名提交）", () => {
    for (const selector of selectors) expect(css).toContain(selector)
    expect(controls).toContain(".member-rename-submit:disabled")
    // styles-controls.css 后引入：同特异性的 opacity 必须在此收口为 1（否则灰底再叠 0.45）。
    const tail = controls.slice(controls.lastIndexOf(".contact-rename-submit:disabled"))
    expect(tail).toContain("opacity: 1")
  })

  it("card-choice 有意排除在灰底规则外（选中态需保持可辨识）", () => {
    expect(disabledBlock).not.toContain(".card-choice")
    expect(allBlocks(css, ".card-choice:disabled")).toContain("cursor: not-allowed")
  })
})
