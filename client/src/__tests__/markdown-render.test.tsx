// @vitest-environment jsdom
/**
 * `MDMessage` 渲染器回归锁（轮 1）：GFM、行内/围栏 code、mention 注入与豁免、
 * raw HTML 不成元素、javascript: 链接被剥、a 带 rel、memo 跳过重复解析。
 * 渲染惯例同 settings-panel：react-dom/client + react#act；react-markdown 用 vi.fn 包真身做解析 spy。
 */
import { act } from "react"
import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { MentionTarget } from "../../../shared/mentions"
import { MDMessage } from "../markdown"

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>()
  return { ...actual, default: vi.fn(actual.default) }
})
import ReactMarkdown from "react-markdown"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

async function renderMd(
  source: string,
  participants: readonly MentionTarget[] = [],
): Promise<HTMLDivElement> {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<MDMessage source={source} participants={participants} />)
  })
  return host
}

const PARTICIPANTS: readonly MentionTarget[] = [{ id: "n-0001", name: "张三" }]

describe("MDMessage GFM", () => {
  it("标题 / 列表 / 表格渲染为对应元素", async () => {
    const c = await renderMd(
      "## 标题二\n\n- 甲\n- 乙\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |",
    )
    expect(c.querySelector("h2")?.textContent).toBe("标题二")
    expect(c.querySelectorAll("li")).toHaveLength(2)
    expect(c.querySelector("table")).not.toBeNull()
    expect(c.querySelectorAll("th")).toHaveLength(2)
    expect(c.querySelectorAll("td")).toHaveLength(2)
  })
})

describe("MDMessage code", () => {
  it("行内 code → code.md-inline；围栏 → pre + language class（highlight 产出）", async () => {
    const c = await renderMd("行内 `x = 1` 段\n\n```js\nconst y = 2\n```")
    const inline = c.querySelector("code.md-inline")
    expect(inline).not.toBeNull()
    expect(inline?.closest("pre")).toBeNull()
    const fenced = c.querySelector("pre code")
    expect(fenced).not.toBeNull()
    expect(fenced?.className).toContain("language-js")
  })
})

describe("MDMessage mention", () => {
  it("段落内 @张三 命中为 mark.mention-hit", async () => {
    const c = await renderMd("你好 @张三 请查收", PARTICIPANTS)
    const hit = c.querySelector("mark.mention-hit")
    expect(hit).not.toBeNull()
    expect(hit?.textContent).toBe("@张三")
  })

  it("code 内提及不产生 mark", async () => {
    const c = await renderMd("```text\n@张三\n```", PARTICIPANTS)
    expect(c.querySelector("mark.mention-hit")).toBeNull()
    expect(c.querySelector("pre")?.textContent).toContain("@张三")
  })
})

describe("MDMessage 安全", () => {
  it("raw HTML 不产生元素", async () => {
    const c = await renderMd("hello <script>alert(1)</script> world 与 <b>粗</b>")
    expect(c.querySelector("script")).toBeNull()
    expect(c.querySelector("b")).toBeNull()
    expect(c.textContent).toContain("hello")
  })

  it("javascript: 链接 href 被剥", async () => {
    const c = await renderMd("[点我](javascript:alert(1))")
    const a = c.querySelector("a")
    expect(a).not.toBeNull()
    expect(a?.getAttribute("href") ?? "").not.toContain("javascript:")
  })

  it("外链 a 带 target 与 rel", async () => {
    const c = await renderMd("[站](https://example.com)")
    const a = c.querySelector("a")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer")
  })
})

describe("MDMessage memo", () => {
  it("同 source+participants 二次 render 不重新解析；换 source 才解析", async () => {
    const spy = ReactMarkdown as unknown as Mock
    spy.mockClear()
    const participants: MentionTarget[] = [{ id: "n-0001", name: "张三" }]

    await renderMd("同一段落", participants)
    await act(async () => {
      root?.render(<MDMessage source="同一段落" participants={participants} />)
    })
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      root?.render(<MDMessage source="换了内容" participants={participants} />)
    })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
