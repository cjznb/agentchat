/**
 * 通讯录组织树 E2E（真 Hub + 进程内种子）——**分组 + 默认折叠（手风琴）**：
 * - 顶层只列主 agent（roster 根节点；human 过滤），默认无子行
 * - 点折叠把手展开某根 → 子行出现、嵌套 `org-children`、缩进一档；**手风琴一次只开一个**
 * - 在线优先稳定排序（顶层：离线 `logical` 排到在线根之后；子层：离线子级排到 busy 之后、退役之前）
 * - 行内**无** `↳` 来源标注（`org-source` 已移除；归属由缩进表达）
 * - 折叠父行摘要 `N子·M忙` + 全子树聚合未读徽标；容器徽标 + 容器卡不可 DM（保留）
 * - 退役可点开卡（发消息禁用）、busy 状态文字、角色色调、实时状态/新子挂载、资料卡字段
 * - 中间栏可滚动：内容超出视口时末行可滚到可见（三个 tab 的列表容器 `overflow-y:auto`）
 *
 * 前置：Playwright webServer 自举 `npm run build && npm start`（临时 `AGENTCHAT_HOME`，
 * 隔离于用户真实 Hub）；本 spec 内 `start({ port: 0 })` 另起独立临时 Hub。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { registerChild } from "../../server/core/agents"
import { openDb } from "../../server/db"
import { start } from "../../server/index"
import { applyAgentState } from "../../server/routes/internal"
import { resetWsHub } from "../../server/ws"
import { seedOrg } from "./seed"

function rowOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="org-row"][data-node-id="${id}"]`)
}
function nodeOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="org-node"][data-node-id="${id}"]`)
}
function toggleOf(page: Page, id: string): Locator {
  return rowOf(page, id).getByTestId("org-toggle")
}

/** 指定深度的行按渲染顺序的 `data-node-id` 序列（判定分组顺序用）。 */
async function orderAtDepth(page: Page, depth: number): Promise<readonly string[]> {
  const rows = page.locator(`[data-testid="org-row"][data-depth="${depth}"]`)
  const count = await rows.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await rows.nth(i).getAttribute("data-node-id")
    if (id === null) throw new Error(`org-row[depth=${depth}][${i}] 缺少 data-node-id`)
    ids.push(id)
  }
  return ids
}

test("org tree（分组手风琴）：默认折叠 + 缩进子行 + 手风琴 + 在线优先 + 容器 + 滚动", async ({
  page,
}) => {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), "agentchat-org-e2e-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  try {
    const seed = seedOrg(db, home)
    await page.goto(`${running.url}/`)
    await page.getByRole("button", { name: "通讯录" }).click()
    await expect(page.getByTestId("org-tree")).toBeVisible()

    // ── 默认折叠：仅顶层 4 个根可见（root1/root2/instance/logical），无子行 ─────
    await expect(page.getByTestId("org-row")).toHaveCount(4)
    await expect(page.getByTestId("org-children")).toHaveCount(0)
    await expect(page.getByTestId("org-source")).toHaveCount(0) // ↳ 已移除
    await expect(page.locator('[data-testid="org-node"]', { hasText: "用户" })).toHaveCount(0)

    // 在线优先稳定排序：离线 logical(org-board) 注册在 instance 之前，却排到最后。
    expect(await orderAtDepth(page, 0)).toEqual([seed.root1, seed.root2, seed.instance, seed.logical])

    // 逻辑节点特殊图标（原覆盖保留）。
    await expect(nodeOf(page, seed.logical).locator(".node-icon")).toHaveText("◆")
    // 折叠态父行摘要 + 全子树聚合未读徽标（root1 = 2；root2 无徽标）。
    await expect(nodeOf(page, seed.root1).getByTestId("org-summary")).toHaveText("4子·1忙")
    await expect(nodeOf(page, seed.root2).getByTestId("org-summary")).toHaveText("1子·0忙")
    await expect(nodeOf(page, seed.root1).getByTestId("unread-badge")).toHaveText("2")
    await expect(nodeOf(page, seed.root2).getByTestId("unread-badge")).toHaveCount(0)

    // ── 展开 root1：子行出现、缩进、子层在线优先稳定 ─────────────────────
    const root1Toggle = toggleOf(page, seed.root1)
    await expect(root1Toggle).toHaveAttribute("aria-expanded", "false")
    await root1Toggle.click()
    await expect(root1Toggle).toHaveAttribute("aria-expanded", "true")
    await expect(rowOf(page, seed.root1).getByTestId("org-children")).toBeVisible()
    await expect(page.getByTestId("org-row")).toHaveCount(8)
    // 子层顺序：online(child1) → busy(child2) → offline(offlineChild) → retired(child3)
    expect(await orderAtDepth(page, 1)).toEqual([
      seed.child1,
      seed.child2,
      seed.offlineChild,
      seed.child3,
    ])
    for (const id of [seed.child1, seed.child2, seed.child3, seed.offlineChild]) {
      await expect(nodeOf(page, id)).toBeVisible()
    }
    // 缩进一档：子行左缘在父行右（层级由缩进表达，无 ↳）。
    const parentBox = await nodeOf(page, seed.root1).boundingBox()
    const childBox = await nodeOf(page, seed.child1).boundingBox()
    expect(parentBox).not.toBeNull()
    expect(childBox).not.toBeNull()
    expect(childBox!.x).toBeGreaterThan(parentBox!.x)
    // 展开后子行各显自身徽标（child1 = 2）。
    await expect(nodeOf(page, seed.child1).getByTestId("unread-badge")).toHaveText("2")

    // busy 状态点 + 状态文字；role 彩色标签。
    await expect(nodeOf(page, seed.child2).locator(".node-dot")).toHaveText("🟠")
    await expect(nodeOf(page, seed.child2).getByTestId("status-text")).toHaveText("编译中")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveText("执行者")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveAttribute(
      "data-tone",
      "executor",
    )

    // ── 手风琴：开 root2 → root1 自动收起 ───────────────────────────────
    await toggleOf(page, seed.root2).click()
    await expect(toggleOf(page, seed.root2)).toHaveAttribute("aria-expanded", "true")
    await expect(toggleOf(page, seed.root1)).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByTestId("org-row")).toHaveCount(5)
    await expect(nodeOf(page, seed.child1)).toHaveCount(0)
    await expect(nodeOf(page, seed.child4)).toBeVisible()

    // ── 容器行：徽标 + data-container；不渲染裸英文 `container` 角色标签 ───
    await toggleOf(page, seed.instance).click()
    await expect(toggleOf(page, seed.root2)).toHaveAttribute("aria-expanded", "false")
    await expect(rowOf(page, seed.instance).getByTestId("org-children")).toBeVisible()
    await expect(nodeOf(page, seed.session)).toBeVisible()
    await expect(nodeOf(page, seed.instance).getByTestId("container-badge")).toHaveText("容器")
    await expect(nodeOf(page, seed.instance)).toHaveAttribute("data-container", "true")
    await expect(nodeOf(page, seed.instance).getByTestId("role-tag")).toHaveCount(0)

    // ── 容器资料卡：容器说明可见、无「发消息」按钮、角色标签「未设置」 ─────
    await nodeOf(page, seed.instance).click()
    await expect(page.getByTestId("contact-card")).toBeVisible()
    await expect(page.getByTestId("contact-container-note")).toBeVisible()
    await expect(page.getByTestId("contact-message")).toHaveCount(0)
    await expect(page.getByTestId("contact-role")).toHaveCount(0)
    await expect(page.getByTestId("contact-card")).toContainText("未设置")
    await expect(page.getByTestId("contact-conversations")).toBeVisible()
    await page.getByTestId("contact-close").click()

    // ── 实时：状态变化（/internal/state 同路径）→ 折叠父行摘要 <2s 刷新 ────
    applyAgentState(db, { agentId: seed.child4, state: "busy" })
    await expect(nodeOf(page, seed.root2).getByTestId("org-summary")).toHaveText("1子·1忙", {
      timeout: 2000,
    })

    // ── 实时：新子节点注册 → 展开 root1 后 2s 内挂载 ─────────────────────
    const root1Toggle2 = toggleOf(page, seed.root1)
    if ((await root1Toggle2.getAttribute("aria-expanded")) === "false") await root1Toggle2.click()
    const live = registerChild(db, { name: "org-live", parentId: seed.root1, taskRef: "org-live" })
    await expect(nodeOf(page, live.id)).toBeVisible({ timeout: 2000 })
    await expect(nodeOf(page, seed.root1).getByTestId("org-summary")).toHaveText("5子·1忙")
    expect(await orderAtDepth(page, 1)).toEqual([
      seed.child1,
      seed.child2,
      live.id,
      seed.offlineChild,
      seed.child3,
    ])

    // ── 退役节点：灰显、仍可点开资料卡（仅「发消息」禁用） ────────────────
    await expect(nodeOf(page, seed.child3)).toHaveAttribute("data-retired", "true")
    await expect(nodeOf(page, seed.child3)).toBeEnabled()
    await nodeOf(page, seed.child3).click()
    await expect(page.getByTestId("contact-card")).toBeVisible()
    await expect(page.getByTestId("contact-message")).toBeDisabled()
    await page.getByTestId("contact-close").click()

    // ── 资料卡：点节点 → 字段齐全 + 两按钮（普通节点按钮在，对照容器） ─────
    await nodeOf(page, seed.child1).click()
    await expect(page.getByTestId("contact-card")).toBeVisible()
    await expect(page.getByTestId("contact-name")).toHaveText("org-child1")
    await expect(page.getByTestId("contact-vendor")).toHaveText("claude-code")
    await expect(page.getByTestId("contact-model")).toHaveText("sonnet")
    await expect(page.getByTestId("contact-role")).toHaveText("执行者")
    await expect(page.getByTestId("contact-skills")).toContainText("react")
    await expect(page.getByTestId("contact-skills")).toContainText("css")
    await expect(page.getByTestId("contact-message")).toBeVisible()
    await expect(page.getByTestId("contact-conversations")).toBeVisible()

    // 查看它的会话：过滤视图列出该节点参与会话（child1 有两条 DM）。
    await page.getByTestId("contact-conversations").click()
    await expect(page.getByTestId("contact-conversation-list")).toBeVisible()
    await expect(page.getByTestId("contact-conversation")).toHaveCount(2)
    await page.getByTestId("contact-conversation").first().click()
    await expect(page.getByTestId("chat-view")).toBeVisible()

    // 发消息（child2 无既有 DM）→ 创建 DM 并打开（标题为节点名）。
    await page.getByRole("button", { name: "通讯录" }).click()
    await nodeOf(page, seed.child2).click()
    await page.getByTestId("contact-message").click()
    await expect(page.getByTestId("chat-view")).toBeVisible()
    await expect(page.getByTestId("chat-view").locator("h1")).toContainText("org-child2", {
      timeout: 3000,
    })

    // ── 中间栏滚动：内容超出视口时末行可滚到可见 ────────────────────────
    await page.setViewportSize({ width: 1280, height: 360 })
    await page.getByRole("button", { name: "通讯录" }).click()
    const tree = page.getByTestId("org-tree")
    await expect(tree).toBeVisible()
    const scrollable = await tree.evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(scrollable).toBe(true)
    const lastRow = page.getByTestId("org-row").last()
    await lastRow.scrollIntoViewIfNeeded()
    await expect(lastRow).toBeVisible()
    const lastBox = await lastRow.boundingBox()
    expect(lastBox).not.toBeNull()
    expect(lastBox!.y).toBeGreaterThanOrEqual(0)
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(361)
    await page.setViewportSize({ width: 1280, height: 720 })

    // ── 三个 tab 的中间栏列表均可滚动（overflow-y: auto 已落到容器） ─────
    await page.getByRole("button", { name: "通讯录" }).click()
    expect(
      await page.getByTestId("org-tree").evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).overflowY),
    ).toBe("auto")
    await page.getByRole("button", { name: "聊天" }).click()
    expect(
      await page
        .getByTestId("conversation-list")
        .evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).overflowY),
    ).toBe("auto")
    await page.getByRole("button", { name: "通知" }).click()
    expect(
      await page
        .getByTestId("notification-aside")
        .evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).overflowY),
    ).toBe("auto")
  } finally {
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
