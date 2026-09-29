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
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { ApiError } from "../api"
import { Settings, type SettingsApi } from "../components/Settings"

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
        reset: async (confirm) => {
          calls.push(confirm)
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
