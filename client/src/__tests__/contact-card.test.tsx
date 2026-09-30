// @vitest-environment jsdom
/**
 * 扁平通讯录评审 Important #2 —— 容器节点「不可 DM」的组件级回归锁（`ContactCard`）：
 * - 容器节点：不渲染 `contact-message`、渲染 `contact-container-note`、角色标签显示「未设置」
 *   （`roleTone("container") === "none"`，不再渲染裸英文 `container` 标签 —— 评审 Minor #1）
 * - 普通节点（对照组，防过度拦截）：`contact-message` 正常渲染
 * - 退役普通节点：按钮仍在但禁用（退役分支不被容器逻辑误伤）
 *
 * `App.tsx` 的 `openDm` 守卫是第二层防御：UI 已无入口触达该分支，由 E2E 断言 + 报告说明覆盖。
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（jsdom 环境）。
 *
 * Task 9（改名两入口）：私聊页 `ContactCard` 与群成员列表 `GroupInfo` 行内改名，
 * 两入口共用 `api.ts` 的 `renameAgent`（同一 `PATCH /api/agents/:id`，请求体 `{name}`）；
 * 成功策略为**本地乐观更新**（服务端既有 `agent` 事件随后回填 store）。
 */
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { RosterNode } from "../../../shared/contracts"
import { ContactCard } from "../components/ContactCard"
import { GroupInfo } from "../components/GroupInfo"

// React 19 依 globalThis 标志识别「测试 act 环境」；缺省会打印 act 警告。
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 群成员列表仅消费 `state.roster`（Task 9 不测 store 本身）——轻桩隔离。
vi.mock("../store", () => ({
  useStore: () => ({
    state: {
      roster: [makeNode("执行者"), { ...makeNode("执行者"), id: "n2", name: "成员乙" }],
    },
  }),
}))

function makeNode(roleTag: string | null, status: RosterNode["status"] = "online"): RosterNode {
  return {
    id: "n1",
    name: "测试节点",
    kind: "runtime",
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status,
    status_text: null,
    purpose: null,
    role_tag: roleTag,
    remark: null,
    skills: [],
    unread: 0,
    children: [],
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null

function renderCard(node: RosterNode): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <ContactCard
        node={node}
        onClose={() => {}}
        onMessage={() => {}}
        onOpenConversation={() => {}}
      />,
    )
  })
  return host
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

afterEach(() => {
  if (root !== null) {
    const current = root
    act(() => current.unmount())
  }
  host?.remove()
  root = null
  host = null
  vi.unstubAllGlobals()
})

describe("ContactCard 容器节点（不可 DM）", () => {
  it("容器节点：隐藏「发消息」、显示容器说明、角色标签为「未设置」", () => {
    const el = renderCard(makeNode("container"))
    expect(find(el, "contact-container-note")).not.toBeNull()
    expect(find(el, "contact-message")).toBeNull()
    expect(find(el, "contact-role")).toBeNull()
    expect(el.textContent).toContain("未设置")
    expect(el.textContent).toContain("不能发起对话")
  })

  it("普通节点（对照组）：「发消息」正常渲染且无容器说明", () => {
    const el = renderCard(makeNode("执行者"))
    expect(find(el, "contact-message")).not.toBeNull()
    expect(find(el, "contact-container-note")).toBeNull()
    expect(find(el, "contact-role")).not.toBeNull()
    expect(el.textContent).toContain("执行者")
  })

  it("退役普通节点：「发消息」仍在但禁用（退役分支不受容器逻辑误伤）", () => {
    const el = renderCard(makeNode(null, "retired"))
    expect(find(el, "contact-message")).not.toBeNull()
    expect(find(el, "contact-message")?.hasAttribute("disabled")).toBe(true)
    expect(find(el, "contact-container-note")).toBeNull()
  })
})

// ── Task 9：改名两入口（共用 `renameAgent` → `PATCH /api/agents/:id`） ────────

interface FetchCall {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** 全局 fetch 桩：记录 `{url, method, body}`，按调用序返回响应。 */
function stubFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      return respond()
    }),
  )
  return calls
}

/** 排干微任务（fetch → json → setState 链）。 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

function clickAt(el: Element | null): void {
  if (el === null) throw new Error("click target not found")
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function setInputValue(container: HTMLElement, testid: string, value: string): void {
  const input = find(container, testid)
  if (input === null) throw new Error(`input not found: ${testid}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function submitForm(container: HTMLElement, testid: string): void {
  const form = find(container, testid)
  if (form === null) throw new Error(`form not found: ${testid}`)
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

describe("改名入口（私聊页 ContactCard）", () => {
  it("✎ 入口 → 行内表单 → 提交调 PATCH（请求体 {name}）→ 成功后展示名乐观更新", async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, name: "新展示名" }))
    const el = renderCard(makeNode("执行者"))
    expect(find(el, "contact-rename")).not.toBeNull()
    expect(find(el, "contact-rename-form")).toBeNull()

    clickAt(find(el, "contact-rename"))
    expect(find(el, "contact-rename-form")).not.toBeNull()
    const submit = find(el, "contact-rename-submit")
    expect(submit).not.toBeNull()
    expect(submit?.hasAttribute("disabled")).toBe(false)

    setInputValue(el, "contact-rename-input", "新展示名")
    submitForm(el, "contact-rename-form")
    await flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/api/agents/n1")
    expect(calls[0]?.method).toBe("PATCH")
    expect(calls[0]?.body).toEqual({ name: "新展示名" })
    expect(find(el, "contact-name")?.textContent).toBe("新展示名")
    expect(find(el, "contact-rename-form")).toBeNull()
  })

  it("409 name_taken → 展示撞名错误文案，展示名不变（表单保留可改）", async () => {
    const calls = stubFetch(() => jsonResponse(409, { ok: false, error: "name_taken" }))
    const el = renderCard(makeNode("执行者"))

    clickAt(find(el, "contact-rename"))
    setInputValue(el, "contact-rename-input", "被占的名字")
    submitForm(el, "contact-rename-form")
    await flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ name: "被占的名字" })
    const err = find(el, "contact-rename-error")
    expect(err).not.toBeNull()
    expect(err?.textContent).toContain("已被占用")
    expect(find(el, "contact-name")?.textContent).toBe("测试节点")
    expect(find(el, "contact-rename-form")).not.toBeNull()
  })

  it("404 agent_not_found → 可辨识错误提示", async () => {
    stubFetch(() => jsonResponse(404, { ok: false, error: "agent_not_found" }))
    const el = renderCard(makeNode("执行者"))
    clickAt(find(el, "contact-rename"))
    setInputValue(el, "contact-rename-input", "改名")
    submitForm(el, "contact-rename-form")
    await flush()
    expect(find(el, "contact-rename-error")?.textContent).toContain("不存在")
  })
})

describe("改名入口（群聊页 GroupInfo 成员行）", () => {
  function makeGroup(): { id: string; kind: "group"; key: string; name: string; createdBy: string; createdAt: number; members: string[] } {
    return {
      id: "g1",
      kind: "group",
      key: "k",
      name: "测试群",
      createdBy: "u1",
      createdAt: 0,
      members: ["n1", "n2"],
    }
  }

  async function renderGroup(): Promise<HTMLDivElement> {
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(<GroupInfo conversationId="g1" onClose={() => {}} />)
    })
    await flush()
    return host
  }

  it("每行有 ✎ 改名入口 → 提交调同一 PATCH（请求体 {name}）→ 展示名乐观更新", async () => {
    // 路由桩：GET /api/groups 拉成员，PATCH 走改名成功响应。
    const routed: FetchCall[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        routed.push({
          url: typeof input === "string" ? input : String(input),
          method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        })
        if (method === "PATCH") return jsonResponse(200, { ok: true, name: "群内新名" })
        return jsonResponse(200, { groups: [makeGroup()] })
      }),
    )

    const el = await renderGroup()
    const entries = el.querySelectorAll('[data-testid="member-rename"]')
    expect(entries.length).toBe(2)

    clickAt(entries.item(0))
    setInputValue(el, "member-rename-input", "群内新名")
    submitForm(el, "member-rename-form")
    await flush()

    const patches = routed.filter((call) => call.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0]?.url).toBe("/api/agents/n1")
    expect(patches[0]?.body).toEqual({ name: "群内新名" })
    expect(find(el, "member-rename-form")).toBeNull()
    expect(el.querySelector('[data-testid="group-member"] .member-name')?.textContent).toBe(
      "群内新名",
    )
  })

  it("409 name_taken → 行内展示撞名错误文案，行展示名不变", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        if (method === "PATCH") return jsonResponse(409, { ok: false, error: "name_taken" })
        void input
        return jsonResponse(200, { groups: [makeGroup()] })
      }),
    )

    const el = await renderGroup()
    clickAt(el.querySelector('[data-testid="member-rename"]'))
    setInputValue(el, "member-rename-input", "重名")
    submitForm(el, "member-rename-form")
    await flush()

    const err = find(el, "member-rename-error")
    expect(err).not.toBeNull()
    expect(err?.textContent).toContain("已被占用")
    expect(el.querySelector('[data-testid="group-member"] .member-name')?.textContent).toBe(
      "测试节点",
    )
  })
})
