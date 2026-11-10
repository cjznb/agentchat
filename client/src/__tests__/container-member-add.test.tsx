// @vitest-environment jsdom
/**
 * P5 前端：错误码透出 + 拉人失败可自诊文案。
 * - `api.ts` 的 `request()` 必须从错误体读出稳定 `error` 码抛进 `ApiError`（改前只带状态码，
 *   UI 一律"添加失败，请重试"）。
 * - `MemberAddDialog` 按码给文案（容器 → 「这是分组容器，不能加入群聊。」）。
 * 无 React 测试库：`react-dom/client` + `react#act`（与既有 tsx 用例同法）；
 * `../store` 被 mock（免 WS/fetch），`fetch` 被 stub（真实 `../api` 逻辑参与）。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"

const storeState = vi.hoisted(() => ({ roster: [] as unknown[] }))

vi.mock("../store", () => ({
  useStore: () => ({ state: storeState }),
}))

import { addGroupMember } from "../api"
import { MemberAddDialog, memberAddErrorMessage } from "../components/MemberAddDialog"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function node(id: string, roleTag: string | null): Record<string, unknown> {
  return {
    id,
    name: id,
    kind: "runtime",
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status: "online",
    status_text: null,
    purpose: null,
    role_tag: roleTag,
    remark: null,
    skills: [],
    unread: 0,
    children: [],
  }
}

/** 最小 Response 替身：`api.ts` 只用到 `ok`/`status`/`json()`。 */
function stubFetch(status: number, body: unknown, jsonThrows = false): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (jsonThrows) throw new Error("not json")
        return body
      },
    })),
  )
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  window.localStorage.clear()
  storeState.roster = [node("n1", null), node("box-1", "container")]
})

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

describe("api.ts 错误码透出（P5）", () => {
  it("非 2xx 且错误体含 error 码 → ApiError 带 code（container_not_group_member）", async () => {
    stubFetch(409, { ok: false, error: "container_not_group_member" })

    await expect(addGroupMember("g1", "box-1")).rejects.toMatchObject({
      name: "ApiError",
      path: "/api/groups/g1/members",
      status: 409,
      code: "container_not_group_member",
    })
  })

  it("错误体非 JSON（代理 502 等）→ 仍有状态码、code 缺省（不抛二次错误）", async () => {
    stubFetch(502, undefined, true)

    await expect(addGroupMember("g1", "n1")).rejects.toMatchObject({ status: 502, code: undefined })
  })

  it("成功响应照常经 schema 解析（改动不外溢到 happy path）", async () => {
    stubFetch(200, { ok: true })

    await expect(addGroupMember("g1", "n1")).resolves.toMatchObject({ ok: true })
  })
})

describe("memberAddErrorMessage（P5 文案表）", () => {
  it("容器码给专属文案，未知/缺省码回落通用文案", () => {
    expect(memberAddErrorMessage("container_not_group_member")).toBe("这是分组容器，不能加入群聊。")
    expect(memberAddErrorMessage("agent_not_found")).toBe("该节点不存在或已被删除。")
    expect(memberAddErrorMessage("who_knows")).toBe("添加失败，请重试。")
    expect(memberAddErrorMessage(undefined)).toBe("添加失败，请重试。")
  })
})

describe("MemberAddDialog 容器被拒时的可自诊文案（P5）", () => {
  function find(container: ParentNode, testid: string): Element | null {
    return container.querySelector(`[data-testid="${testid}"]`)
  }

  function click(el: Element | null | undefined): void {
    expect(el).not.toBeNull()
    act(() => {
      ;(el as HTMLElement).click()
    })
  }

  it("确认收到 409 container_not_group_member → 弹窗显示「这是分组容器，不能加入群聊。」且不关闭", async () => {
    stubFetch(409, { ok: false, error: "container_not_group_member" })
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MemberAddDialog conversationId="g1" onClose={() => {}} onSuccess={() => {}} />,
      )
    })

    click(
      host.querySelector(
        '[data-testid="member-row"][data-node-id="n1"] [data-testid="member-check"]',
      ),
    )
    click(find(host, "member-add-confirm"))
    await act(async () => {})

    expect(find(host, "group-add-error")?.textContent).toBe("这是分组容器，不能加入群聊。")
    // 失败不关闭弹窗（用户可自诊后改选）。
    expect(find(host, "member-add-dialog")).not.toBeNull()
  })

  it("未知错误码 → 通用文案（行为不回归）", async () => {
    stubFetch(500, { ok: false, error: "internal_error" })
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MemberAddDialog conversationId="g1" onClose={() => {}} onSuccess={() => {}} />,
      )
    })

    click(
      host.querySelector(
        '[data-testid="member-row"][data-node-id="n1"] [data-testid="member-check"]',
      ),
    )
    click(find(host, "member-add-confirm"))
    await act(async () => {})

    expect(find(host, "group-add-error")?.textContent).toBe("添加失败，请重试。")
  })
})
