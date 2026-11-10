// @vitest-environment jsdom
/**
 * UI-1 ⑥「版本与更新」卡片组件级回归锁（API 注入，不触网）：
 * - 当前 Hub 版本 / 适配器 内置 vs 上报 / outdated 红态 / version=null → 「未上报」
 * - 「检查更新」：请求中 disabled + 加载文案；成功后结果区（最新版本 / 是否可更新 / compareUrl /
 *   adaptersOutdated / 缓存标记 / 手动步骤）；**不提供一键升级**
 * - 业务失败（HTTP 200 + ok:false）按 error 文案展示，绝不 toast 成"服务器错误"
 */
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { VersionCard, type VersionApi } from "../components/VersionCard"
import {
  adapterStateLabel,
  adapterStateOf,
  adapterVersionText,
  updateErrorMessage,
  type CheckOutcome,
  type VersionInfo,
} from "../version"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

const INFO: VersionInfo = {
  ok: true,
  hub: { name: "agentchat", version: "0.2.0", compareUrl: "https://example.test/agentchat" },
  adapters: [
    {
      vendor: "opencode",
      version: "0.1.0",
      bundledVersion: "0.2.0",
      outdated: true,
      reportedAt: 1,
    },
    { vendor: "dsh", version: null, bundledVersion: "0.1.0", outdated: null, reportedAt: null },
  ],
  checkedAt: null,
}

const CHECK_OK: CheckOutcome = {
  ok: true,
  value: {
    ok: true,
    current: "0.2.0",
    latest: "0.3.0",
    updateAvailable: true,
    adaptersOutdated: [
      { vendor: "opencode", version: "0.1.0", bundledVersion: "0.2.0", outdated: true, reportedAt: 1 },
    ],
    tagsChecked: 12,
    source: "https://example.test/tags",
    checkedAt: 1_750_000_000_000,
    cached: false,
    compareUrl: "https://example.test/compare/v0.2.0...v0.3.0",
  },
}

function fakeApi(overrides: Partial<VersionApi> = {}): VersionApi {
  return {
    load: async () => INFO,
    check: async () => CHECK_OK,
    ...overrides,
  }
}

async function renderCard(api: VersionApi): Promise<HTMLDivElement> {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<VersionCard api={api} />)
  })
  return host
}

function find(container: HTMLElement, testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

describe("VersionCard 只读展示（①）", () => {
  it("显示当前 Hub 版本 + 更新源链接 + 两个适配器（落后标红 / 未上报）", async () => {
    const el = await renderCard(fakeApi())
    expect(find(el, "version-hub")?.textContent).toBe("v0.2.0")
    expect(find(el, "version-compare-link")?.getAttribute("href")).toBe(INFO.hub.compareUrl)

    const rows = Array.from(el.querySelectorAll('[data-testid="version-adapter"]'))
    expect(rows).toHaveLength(2)
    const opencode = rows.find((row) => row.getAttribute("data-vendor") === "opencode")
    const dsh = rows.find((row) => row.getAttribute("data-vendor") === "dsh")
    expect(opencode?.getAttribute("data-state")).toBe("outdated")
    expect(opencode?.querySelector('[data-testid="version-adapter-state"]')?.textContent).toBe("有更新")
    expect(opencode?.textContent).toContain("内置 v0.2.0 · 上报 v0.1.0")
    expect(dsh?.getAttribute("data-state")).toBe("unknown")
    expect(dsh?.querySelector('[data-testid="version-adapter-state"]')?.textContent).toBe("未上报")
    expect(dsh?.textContent).toContain("未上报")
  })

  it("读取失败 → 明示无法读取（不假装版本已知）", async () => {
    const el = await renderCard(
      fakeApi({
        load: async () => {
          throw new Error("boom")
        },
      }),
    )
    expect(find(el, "version-load-error")).not.toBeNull()
    expect(find(el, "version-hub")).toBeNull()
  })
})

describe("VersionCard 检查更新（②③④）", () => {
  it("请求中按钮 disabled + 加载文案；成功后结果区齐全且**没有一键升级**", async () => {
    let release: ((outcome: CheckOutcome) => void) | null = null
    const el = await renderCard(
      fakeApi({
        check: () =>
          new Promise<CheckOutcome>((resolve) => {
            release = resolve
          }),
      }),
    )
    const button = find(el, "version-check") as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await act(async () => {
      button.click()
    })
    expect((find(el, "version-check") as HTMLButtonElement).disabled).toBe(true)
    expect(find(el, "version-check")?.textContent).toBe("检查中…")

    await act(async () => {
      release?.(CHECK_OK)
      await Promise.resolve()
    })

    const result = find(el, "version-result")
    expect(result).not.toBeNull()
    expect(find(el, "version-latest")?.textContent).toBe("v0.3.0")
    expect(find(el, "version-update-available")?.textContent).toBe("有可用更新")
    expect(find(el, "version-result-compare")?.getAttribute("href")).toBe(CHECK_OK.ok ? CHECK_OK.value.compareUrl : "")
    expect(find(el, "version-outdated")?.textContent).toContain("opencode")
    expect(find(el, "version-checked-at")?.textContent).toContain("检查时间")
    // ③ 不做一键升级：只有手动步骤，没有"升级"动作按钮。
    expect(find(el, "version-manual")?.textContent).toContain("没有一键升级")
    const labels = Array.from(el.querySelectorAll("button")).map((node) => node.textContent ?? "")
    expect(labels.filter((text) => text.includes("升级"))).toEqual([])
  })

  it("业务失败（ok:false）按 error 文案展示，不当成服务器错误", async () => {
    const el = await renderCard(fakeApi({ check: async () => ({ ok: false, code: "no_tags" }) }))
    await act(async () => {
      ;(find(el, "version-check") as HTMLElement).click()
    })
    await act(async () => {})
    const error = find(el, "version-check-error")?.textContent ?? ""
    expect(error).toContain("还没有发布任何 tag")
    expect(error).toContain("no_tags") // 原始码一并露出，便于自诊
    expect(find(el, "version-result")).toBeNull()
  })

  it("传输层失败（fetch 抛出）→ 明确「无法连接 Hub」文案", async () => {
    const el = await renderCard(
      fakeApi({
        check: async () => {
          throw new Error("offline")
        },
      }),
    )
    await act(async () => {
      ;(find(el, "version-check") as HTMLElement).click()
    })
    await act(async () => {})
    expect(find(el, "version-check-error")?.textContent).toContain("无法连接 Hub")
  })

  it("缓存结果如实标注（cached:true）", async () => {
    const el = await renderCard(
      fakeApi({
        check: async () => ({
          ok: true,
          value: {
            ...CHECK_OK.value,
            cached: true,
            updateAvailable: false,
            latest: "0.2.0",
            adaptersOutdated: [],
          },
        }),
      }),
    )
    await act(async () => {
      ;(find(el, "version-check") as HTMLElement).click()
    })
    await act(async () => {})
    expect(find(el, "version-result")?.getAttribute("data-cached")).toBe("true")
    expect(find(el, "version-update-available")?.textContent).toBe("已是最新")
    expect(find(el, "version-outdated-empty")).not.toBeNull()
  })
})

describe("version.ts 纯函数", () => {
  it("错误码文案覆盖契约全部 6 码 + 未知回落", () => {
    expect(updateErrorMessage("no_tags")).toContain("tag")
    expect(updateErrorMessage("network")).toContain("网络不可用")
    expect(updateErrorMessage("timeout")).toContain("超时")
    expect(updateErrorMessage("invalid_url")).toContain("https")
    expect(updateErrorMessage("http_error")).toContain("错误状态")
    expect(updateErrorMessage("too_large")).toContain("过大")
    expect(updateErrorMessage("who_knows")).toContain("检查更新失败")
    expect(updateErrorMessage(undefined)).toContain("检查更新失败")
  })

  it("适配器状态/文案派生：outdated > unknown > current", () => {
    const base = { vendor: "x", bundledVersion: "1.0.0", reportedAt: null }
    expect(adapterStateOf({ ...base, version: null, outdated: null })).toBe("unknown")
    expect(adapterStateOf({ ...base, version: "0.9.0", outdated: true })).toBe("outdated")
    expect(adapterStateOf({ ...base, version: "1.0.0", outdated: false })).toBe("current")
    expect(adapterStateLabel("outdated")).toBe("有更新")
    expect(adapterStateLabel("unknown")).toBe("未上报")
    expect(adapterVersionText({ ...base, version: null, outdated: null })).toBe("内置 v1.0.0 · 上报 未上报")
    expect(adapterVersionText({ ...base, version: "0.9.0", outdated: true })).toBe("内置 v1.0.0 · 上报 v0.9.0")
  })
})
