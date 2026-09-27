/**
 * Plan 3 T9 —— 视觉 / 可用性收口 E2E（visual-qa 流程的代码化核查）：
 * - 三视图（聊天 / 组织树 / 通知）在 375 / 768 / 1280 宽度下**无横向溢出**、CJK 标题不裁切；
 * - 空态（会话 / 组织树 / 通知）在**真实空数据**路径可达（替代 T2 不可达骨架）；
 * - 可访问性最低线：按钮有可读名、键盘焦点可见。
 *
 * 截图落到 `test-results/visual/`（gitignore）供人工/视觉模型复核。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { start, type RunningServer } from "../../server/index"
import { resetWsHub } from "../../server/ws"
import { seedExperience } from "./seed"

const WIDTHS = [375, 768, 1280] as const
const SHOT_DIR = join(process.cwd(), "test-results", "visual")

interface Harness {
  readonly db: Db
  readonly home: string
  readonly running: RunningServer
}

async function bootExperience(prefix: string, withData: boolean): Promise<Harness> {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), prefix))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  if (withData) seedExperience(db, home)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  return { db, home, running }
}

async function teardown(page: Page, harness: Harness): Promise<void> {
  await page.close()
  resetWsHub()
  await harness.running.close()
  harness.db.close()
  rmSync(harness.home, { recursive: true, force: true })
}

/** 文档无横向溢出（≤1px 舍入容差）。 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.locator("html").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1)
}

/** 元素文字不横向裁切、不越出视口（CJK 不截断/不漏字形）。 */
async function expectTextNotClipped(locator: Locator): Promise<void> {
  const result = await locator.evaluate((el) => {
    const view = el.ownerDocument.defaultView
    const width = view?.innerWidth ?? 0
    const rect = el.getBoundingClientRect()
    return {
      horizontal: el.scrollWidth > el.clientWidth + 1,
      outOfViewport: rect.right > width + 1 || rect.left < -1,
    }
  })
  expect(result).toEqual({ horizontal: false, outOfViewport: false })
}

test("empty states are reachable on a genuinely empty hub", async ({ page }) => {
  const harness = await bootExperience("agentchat-visual-empty-", false)
  try {
    await page.goto(`${harness.running.url}/`)
    await expect(page.getByTestId("conversation-empty")).toBeVisible()

    await page.getByRole("button", { name: "通讯录" }).click()
    await expect(page.getByTestId("org-tree-empty")).toBeVisible()

    await page.getByRole("button", { name: "通知" }).click()
    await expect(page.getByTestId("notifications-empty")).toBeVisible()
  } finally {
    await teardown(page, harness)
  }
})

test("chat, tree and notifications stay overflow-free with intact CJK at 375/768/1280", async ({ page }) => {
  const harness = await bootExperience("agentchat-visual-resp-", true)
  mkdirSync(SHOT_DIR, { recursive: true })
  try {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`${harness.running.url}/`)

      // ── 聊天视图（打开「发布协调群」；含系统消息 / 群成员）──
      await page.getByTestId("conversation-item").filter({ hasText: "发布协调群" }).click()
      await expect(page.getByTestId("chat-view")).toBeVisible()
      await expectTextNotClipped(page.getByTestId("chat-view").locator("h1"))
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: join(SHOT_DIR, `chat-${width}.png`) })

      // ── 组织树 ──
      await page.getByRole("button", { name: "通讯录" }).click()
      await expect(page.getByTestId("org-tree")).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: join(SHOT_DIR, `tree-${width}.png`) })

      // ── 通知页（有待处理条目）──
      await page.getByRole("button", { name: "通知" }).click()
      await expect(page.getByTestId("notifications-view")).toBeVisible()
      await expectTextNotClipped(page.getByTestId("notifications-view").locator("h1"))
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: join(SHOT_DIR, `notifications-${width}.png`) })
    }
  } finally {
    await teardown(page, harness)
  }
})

test("every button exposes an accessible name and keyboard focus is visible", async ({ page }) => {
  const harness = await bootExperience("agentchat-visual-a11y-", true)
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${harness.running.url}/`)

    const unnamed = await page.getByRole("button").evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const label = node.getAttribute("aria-label") ?? node.getAttribute("title") ?? node.textContent ?? ""
          return label.trim() === ""
        })
        .map((node) => node.outerHTML.slice(0, 80)),
    )
    expect(unnamed).toEqual([])

    // 键盘 Tab → 焦点可见（outline 非 none）。
    await page.keyboard.press("Tab")
    const focusOutline = await page.locator("html").evaluate((root) => {
      const view = root.ownerDocument.defaultView
      const el = root.ownerDocument.activeElement
      if (el === null || el === root.ownerDocument.body || view === null) {
        return { focused: false, outline: "none 0px" }
      }
      const style = view.getComputedStyle(el)
      return { focused: true, outline: `${style.outlineStyle} ${style.outlineWidth}` }
    })
    expect(focusOutline.focused).toBe(true)
    expect(focusOutline.outline).not.toBe("none 0px")
  } finally {
    await teardown(page, harness)
  }
})
