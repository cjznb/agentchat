// @vitest-environment jsdom
/**
 * 「设置」面板组件级回归锁（`Settings`）：
 * - 数据位置/日志路径来自 API 并渲染
 * - 确认词门槛：未输/输错时按钮禁用，逐字输入 RESET 才可点
 * - 成功后自动清 `agentchat:` localStorage（保留他人键）并提示重启 Hub
 * - 失败按错误码给中文提示
 * 无 React 测试库：`react-dom/client` + `react#act` 直接渲染（与既有 tsx 用例同法）。
 */
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { ApiError } from "../api"
import { Settings, type SettingsApi } from "../components/Settings"
import { STORAGE_KEY, subscribe } from "../mdScope"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
  localStorage.clear()
})

function fakeApi(overrides: Partial<SettingsApi> = {}): SettingsApi {
  return {
    loadInfo: async () => ({ home: "/tmp/home", logsDir: "/tmp/home/logs" }),
    reset: async () => ({ ok: true, restartRequired: true, snapshotPath: "/tmp/home.bak" }),
    prune: async () => ({ count: 0, names: [] }),
    ...overrides,
  }
}

async function renderPanel(api: SettingsApi): Promise<HTMLDivElement> {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Settings api={api} />)
  })
  return host
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function typeInto(input: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("Settings 数据位置", () => {
  it("渲染 API 返回的 home 与 logsDir", async () => {
    const container = await renderPanel(fakeApi())
    expect(find(container, "settings-home")?.textContent).toContain("/tmp/home")
    expect(find(container, "settings-logs")?.textContent).toContain("/tmp/home/logs")
  })
})

describe("Settings 确认词门槛", () => {
  it("未输/输错禁用，精确 RESET 才可提交", async () => {
    const container = await renderPanel(fakeApi())
    const button = find(container, "settings-reset-button")
    const input = find(container, "settings-reset-input")
    expect(button?.hasAttribute("disabled")).toBe(true)

    await act(async () => void typeInto(input as Element, "reset"))
    expect(button?.hasAttribute("disabled")).toBe(true)

    await act(async () => void typeInto(input as Element, "RESET"))
    expect(button?.hasAttribute("disabled")).toBe(false)
  })
})

describe("Settings 恢复出厂设置", () => {
  it("成功后清 agentchat: 键（保留他人键）并提示重启", async () => {
    const calls: string[] = []
    const container = await renderPanel(
      fakeApi({
        reset: async (request) => {
          calls.push(request.confirm)
          return { ok: true, restartRequired: true, snapshotPath: "/tmp/home.bak" }
        },
      }),
    )
    localStorage.setItem("agentchat:expandedRoots", "[]")
    localStorage.setItem("other", "keep")

    const input = find(container, "settings-reset-input") as Element
    await act(async () => void typeInto(input, "RESET"))
    await act(async () => {
      ;(find(container, "settings-reset-button") as HTMLElement).click()
    })

    expect(calls).toEqual(["RESET"])
    expect(localStorage.getItem("agentchat:expandedRoots")).toBeNull()
    expect(localStorage.getItem("other")).toBe("keep")
    expect(find(container, "settings-reset-notice")?.textContent).toContain("重启 Hub")
  })

  it("失败按错误码给中文提示", async () => {
    const container = await renderPanel(
      fakeApi({
        reset: async () => {
          throw new ApiError("/api/admin/reset", 400, "invalid_body")
        },
      }),
    )
    const input = find(container, "settings-reset-input") as Element
    await act(async () => void typeInto(input, "RESET"))
    await act(async () => {
      ;(find(container, "settings-reset-button") as HTMLElement).click()
    })

    expect(find(container, "settings-reset-error")?.textContent).toContain("RESET")
    expect(find(container, "settings-reset-notice")).toBeNull()
  })
})

describe("Settings 保留 backups/ 开关", () => {
  it("默认不勾 → payload 无 keepBackups；勾选 → keepBackups: true", async () => {
    const payloads: Array<{ confirm: string; keepBackups?: boolean }> = []
    const container = await renderPanel(
      fakeApi({
        reset: async (request) => {
          payloads.push(request)
          return { ok: true, restartRequired: true, snapshotPath: "/tmp/home.bak" }
        },
      }),
    )
    const checkbox = find(container, "settings-keep-backups") as HTMLInputElement
    const input = find(container, "settings-reset-input") as Element
    const button = find(container, "settings-reset-button") as HTMLElement

    expect(checkbox.checked).toBe(false)
    await act(async () => void typeInto(input, "RESET"))
    await act(async () => void button.click())

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual({ confirm: "RESET" })
    expect(payloads[0]).not.toHaveProperty("keepBackups")

    await act(async () => void checkbox.click())
    expect(checkbox.checked).toBe(true)
    await act(async () => void typeInto(input, "RESET"))
    await act(async () => void button.click())

    expect(payloads).toHaveLength(2)
    expect(payloads[1]).toEqual({ confirm: "RESET", keepBackups: true })
  })
})

describe("Settings 清理离线历史会话", () => {
  it("按钮存在 → 预览(false) → 弹层含 count 与前 8 名字 → 确认执行(true) → 成功文案", async () => {
    const calls: boolean[] = []
    const names = Array.from({ length: 10 }, (_, index) => `sess-${index}`)
    const container = await renderPanel(
      fakeApi({
        prune: async (execute) => {
          calls.push(execute)
          return execute ? { count: 10, names } : { count: 10, names }
        },
      }),
    )

    const button = find(container, "settings-prune") as HTMLElement
    expect(button).not.toBeNull()
    await act(async () => void button.click())

    expect(calls).toEqual([false])
    const confirm = find(container, "settings-prune-confirm")
    expect(confirm?.textContent).toContain("将退役 10 个历史会话节点")
    expect(confirm?.textContent).toContain("sess-0")
    expect(confirm?.textContent).toContain("sess-7")
    expect(confirm?.textContent).not.toContain("sess-8")
    expect(confirm?.textContent).toContain("重新打开时会注册为新节点")

    await act(async () => void (find(container, "settings-prune-confirm-btn") as HTMLElement).click())
    expect(calls).toEqual([false, true])
    expect(find(container, "settings-prune-confirm")).toBeNull()
    expect(find(container, "settings-local-notice")?.textContent).toContain("已退役 10 个历史会话节点")
  })

  it("预览 count=0 → 无弹层，直接提示无可清理", async () => {
    const container = await renderPanel(
      fakeApi({ prune: async () => ({ count: 0, names: [] }) }),
    )
    await act(async () => void (find(container, "settings-prune") as HTMLElement).click())

    expect(find(container, "settings-prune-confirm")).toBeNull()
    expect(find(container, "settings-local-notice")?.textContent).toContain("没有可清理")
  })

  it("预览失败 → settings-local-notice 无内容，prune 错误提示出现", async () => {
    const container = await renderPanel(
      fakeApi({
        prune: async () => {
          throw new ApiError("/api/admin/prune-sessions", 500, "prune_failed")
        },
      }),
    )
    await act(async () => void (find(container, "settings-prune") as HTMLElement).click())
    expect(find(container, "settings-prune-confirm")).toBeNull()
    expect(container.querySelector("[data-testid='settings-prune-error']")?.textContent).toContain("prune_failed")
  })
})

describe("Settings 消息渲染范围", () => {
  it("select 渲染三选项（全部/仅 AI 回复/关闭），change 落值 + notify", async () => {
    const container = await renderPanel(fakeApi())
    const select = find(container, "settings-md-scope") as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect(Array.from(select!.options).map((option) => option.value)).toEqual(["all", "agent", "off"])
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual(["全部", "仅 AI 回复", "关闭"])
    expect(select!.value).toBe("all")

    const listener = vi.fn()
    const unsubscribe = subscribe(listener)

    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    await act(async () => {
      setter?.call(select!, "agent")
      select!.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(localStorage.getItem(STORAGE_KEY)).toBe("agent")
    expect(listener).toHaveBeenCalledWith("agent")
    unsubscribe()
  })
})
