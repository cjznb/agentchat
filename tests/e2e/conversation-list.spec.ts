/**
 * Plan 3 T4 —— 会话列表折叠 E2E（真 Hub + 进程内种子）：
 * 喊话置顶 / 群与逻辑顶层 / human 不出现 / 默认折叠 + 摘要 /
 * 手风琴展开 / 退役子行灰显不可点 / 打开会话后子行徽标清零（其他不受影响）。
 *
 * 前置：Playwright webServer 自举 `npm run build && npm start`（`start` 从 `client/dist` 托管静态页）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { openDb } from "../../server/db"
import { start } from "../../server/index"
import { resetWsHub } from "../../server/ws"
import { seedList } from "./seed"

test("folds conversations: shout pinned, human hidden, accordion, badge clears on open", async ({ page }) => {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), "agentchat-list-e2e-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  try {
    seedList(db, home)
    // C1 默认收起：断言「cl-group 顶层可见」需预置分组展开态（Playwright 惯例 addInitScript，导航前生效）。
    await page.addInitScript("localStorage.setItem('agentchat:groupSectionExpanded', 'true')")
    await page.goto(`${running.url}/`)

    // 喊话置顶：列表首项即喊话频道（`data-kind="shout"`）。
    const first = page.getByTestId("conversation-item").first()
    await expect(first).toHaveAttribute("data-kind", "shout")
    await expect(first).toContainText("全员喊话")

    // 群聊与逻辑节点私聊为顶层行。
    await expect(page.getByTestId("conversation-item").filter({ hasText: "cl-group" })).toBeVisible()
    await expect(page.getByTestId("conversation-item").filter({ hasText: "cl-logical" })).toBeVisible()

    // human 节点 / human 会话不出现在任何列表。
    await expect(page.locator('[data-testid="conversation-item"]', { hasText: "用户" })).toHaveCount(0)
    await expect(page.locator('[data-testid="root-row"]', { hasText: "用户" })).toHaveCount(0)

    // 默认折叠：根行在、子行不在；摘要显示子会话数。
    const root1 = page.locator('[data-testid="root-row"]', { hasText: "cl-root1" })
    const root2 = page.locator('[data-testid="root-row"]', { hasText: "cl-root2" })
    await expect(root1).toBeVisible()
    await expect(page.getByTestId("conversation-item").filter({ hasText: "cl-child1" })).toHaveCount(0)
    await expect(root1.getByTestId("fold-summary")).toHaveText("2 子")
    await expect(root2.getByTestId("fold-summary")).toHaveText("1 子")

    // 展开 root1 → 子行可见；退役子行灰显且不可开聊。
    const child1 = page.getByTestId("conversation-item").filter({ hasText: "cl-child1" })
    const child2 = page.getByTestId("conversation-item").filter({ hasText: "cl-child2" })
    await root1.getByTestId("fold-toggle").click()
    await expect(child1).toBeVisible()
    await expect(child2).toHaveAttribute("data-retired", "true")
    await expect(child2).toBeDisabled()

    // 手风琴：展开 root2 会收起 root1。
    await root2.getByTestId("fold-toggle").click()
    await expect(page.getByTestId("conversation-item").filter({ hasText: "cl-child3" })).toBeVisible()
    await expect(child1).toHaveCount(0)

    // 打开会话 → 该子行徽标清零；其他会话不受影响。
    await root1.getByTestId("fold-toggle").click()
    await expect(child1.getByTestId("unread-badge")).toHaveText("1")
    await expect(child2.getByTestId("unread-badge")).toHaveText("1")
    await child1.click()
    await expect(child1.getByTestId("unread-badge")).toHaveCount(0)
    await expect(child2.getByTestId("unread-badge")).toHaveText("1")

    // 展开态持久化：刷新后 root1 仍展开，且子行徽标已清零。
    await page.reload()
    await expect(page.locator('[data-testid="root-row"]', { hasText: "cl-root1" }).getByTestId("fold-toggle")).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByTestId("conversation-item").filter({ hasText: "cl-child1" }).getByTestId("unread-badge")).toHaveCount(0)
  } finally {
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("root badge aggregates the subtree human unread and drops when a child is opened", async ({ page }) => {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), "agentchat-list-badge-e2e-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  try {
    seedList(db, home)
    await page.goto(`${running.url}/`)
    const root1 = page.locator('[data-testid="root-row"]', { hasText: "cl-root1" })

    // F1：根徽标 = 全子树 human 侧未读（child1 1 + child2 1 = 2；根自身 DM 为 human 自发 0）。
    await expect(root1.getByTestId("unread-badge").first()).toHaveText("2")

    // 展开前后一致（聚合纯函数无隐藏状态）。
    await root1.getByTestId("fold-toggle").click()
    await expect(root1.getByTestId("unread-badge").first()).toHaveText("2")

    // 打开 child1（human 阅读）→ 子行徽标清零、根徽标同步下降为 1（child2 仍 1）。
    const child1 = page.getByTestId("conversation-item").filter({ hasText: "cl-child1" })
    await expect(child1.getByTestId("unread-badge")).toHaveText("1")
    await child1.click()
    await expect(child1.getByTestId("unread-badge")).toHaveCount(0)
    await expect(root1.getByTestId("unread-badge").first()).toHaveText("1")
  } finally {
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
