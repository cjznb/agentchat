/**
 * Plan 3 T6 —— 通讯录组织树（**扁平单层**）+ 资料卡 E2E（真 Hub + 进程内种子）：
 * 恒渲染（无折叠/无层级属性/无缩进）、DFS 父前子随 + `↳` 来源标注、human 过滤、
 * 摘要 `N子·M忙` + 聚合徽标、退役灰显可点、busy 状态与角色色调、
 * 容器徽标 + 容器卡不可 DM、状态变化与实时挂载 <2s、资料卡字段与两按钮。
 *
 * 扁平化重写（评审 Critical #1）：
 * - 删除：toggle/折叠/手风琴断言与 `ensureExpanded` helper（`org-toggle` testid 已随
 *   `OrgTree.tsx` 扁平化删除，旧断言在第一条即中止、后续覆盖全部失效）。
 * - 新增：扁平恒渲染（9 行默认可见）、扁平 DOM（无嵌套/无层级属性/无缩进实测）、
 *   DFS 父前子随、`↳` 来源标注、容器行/容器卡（含「无 contact-message」）。
 * - 保留：human 过滤、逻辑图标、摘要与徽标、退役灰化可点、busy 与角色色调、
 *   实时状态变化、实时挂载、资料卡字段完整性、会话过滤视图、发消息开 DM。
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

/** 扁平列表当前渲染顺序（自上而下的 `data-node-id` 序列；DFS 断言用）。 */
async function rowOrder(page: Page): Promise<readonly string[]> {
  const nodes = page.getByTestId("org-node")
  const count = await nodes.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await nodes.nth(i).getAttribute("data-node-id")
    if (id === null) throw new Error(`org-node[${i}] 缺少 data-node-id`)
    ids.push(id)
  }
  return ids
}

/** 节点在扁平顺序中的下标（缺失即失败，避免静默 -1 误判）。 */
function at(order: readonly string[], id: string): number {
  const index = order.indexOf(id)
  if (index < 0) throw new Error(`节点 ${id} 不在扁平列表：${order.join(", ")}`)
  return index
}

test("org tree（扁平）：恒渲染 + DFS/↳ + 退役/忙碌/容器 + 实时挂载 + 资料卡", async ({
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
    const tree = page.getByTestId("org-tree")
    await expect(tree).toBeVisible()

    // ── 扁平恒渲染：9 行默认全部可见（无折叠），human 不出现 ─────────────
    await expect(page.getByTestId("org-row")).toHaveCount(9)
    for (const id of [
      seed.root1,
      seed.root2,
      seed.logical,
      seed.child1,
      seed.child2,
      seed.child3,
      seed.child4,
      seed.instance,
      seed.session,
    ]) {
      await expect(nodeOf(page, id)).toBeVisible()
    }
    await expect(page.locator('[data-testid="org-node"]', { hasText: "用户" })).toHaveCount(0)

    // 逻辑节点特殊图标（原覆盖保留）。
    await expect(nodeOf(page, seed.logical).locator(".node-icon")).toHaveText("◆")

    // ── 扁平 DOM：无嵌套行 / 无 toggle / 无层级属性 / 无行级内联缩进 ──────
    await expect(tree.locator("ul")).toHaveCount(0)
    await expect(tree.locator("li li")).toHaveCount(0)
    await expect(tree.locator(":scope > li")).toHaveCount(9)
    await expect(
      tree.locator(
        '[data-testid="org-toggle"], .org-toggle, .org-children, .org-head, [aria-expanded], [role="tree"], [role="treeitem"], [role="group"]',
      ),
    ).toHaveCount(0)
    await expect(tree.locator(".org-node[style]")).toHaveCount(0)

    // 无层级缩进（实测）：所有行计算样式的左内边距一致。
    const paddings = await tree.locator(".org-node").evaluateAll((els) =>
      els.map((el) => el.ownerDocument?.defaultView?.getComputedStyle(el).paddingLeft ?? ""),
    )
    expect(new Set(paddings).size).toBe(1)
    expect(paddings[0]).not.toBe("")

    // ── DFS 顺序：父在前、子紧随（子行紧跟其父，不跨层跳散） ─────────────
    const order = await rowOrder(page)
    expect(at(order, seed.child1)).toBe(at(order, seed.root1) + 1)
    expect(at(order, seed.child2)).toBe(at(order, seed.root1) + 2)
    expect(at(order, seed.child3)).toBe(at(order, seed.root1) + 3)
    expect(at(order, seed.child4)).toBe(at(order, seed.root2) + 1)
    expect(at(order, seed.session)).toBe(at(order, seed.instance) + 1)
    expect(at(order, seed.root1)).toBeLessThan(at(order, seed.root2))

    // ── `↳` 来源标注：子行标父名；根行（含容器）无标注 ───────────────────
    await expect(rowOf(page, seed.root1).getByTestId("org-source")).toHaveCount(0)
    await expect(rowOf(page, seed.child1).getByTestId("org-source")).toHaveText("↳ org-root1")
    await expect(rowOf(page, seed.child4).getByTestId("org-source")).toHaveText("↳ org-root2")
    await expect(rowOf(page, seed.session).getByTestId("org-source")).toHaveText("↳ org-instance")

    // ── 摘要 `N子·M忙` + 聚合未读徽标（root1=2，root2 无徽标） ────────────
    await expect(rowOf(page, seed.root1).getByTestId("org-summary")).toHaveText("3子·1忙")
    await expect(rowOf(page, seed.root2).getByTestId("org-summary")).toHaveText("1子·0忙")
    await expect(rowOf(page, seed.instance).getByTestId("org-summary")).toHaveText("1子·0忙")
    await expect(rowOf(page, seed.root1).getByTestId("unread-badge")).toHaveText("2")
    await expect(rowOf(page, seed.root2).getByTestId("unread-badge")).toHaveCount(0)

    // ── 退役节点：灰显、留原位、仍可点开资料卡（仅「发消息」禁用） ─────────
    await expect(nodeOf(page, seed.child3)).toHaveAttribute("data-retired", "true")
    await expect(nodeOf(page, seed.child3)).toBeEnabled()
    await nodeOf(page, seed.child3).click()
    await expect(page.getByTestId("contact-card")).toBeVisible()
    await expect(page.getByTestId("contact-message")).toBeDisabled()
    await page.getByTestId("contact-close").click()

    // ── busy 状态点 + 状态文字；role 彩色标签 ─────────────────────────────
    await expect(nodeOf(page, seed.child2).locator(".node-dot")).toHaveText("🟠")
    await expect(nodeOf(page, seed.child2).getByTestId("status-text")).toHaveText("编译中")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveText("执行者")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveAttribute(
      "data-tone",
      "executor",
    )

    // ── 容器行：徽标 + data-container；不渲染裸英文 `container` 角色标签 ───
    await expect(rowOf(page, seed.instance).getByTestId("container-badge")).toHaveText("容器")
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

    // ── 实时：状态变化（/internal/state 同路径）→ 摘要 <2s 刷新 ───────────
    applyAgentState(db, { agentId: seed.child4, state: "busy" })
    await expect(rowOf(page, seed.root2).getByTestId("org-summary")).toHaveText("1子·1忙", {
      timeout: 2000,
    })

    // ── 实时：新子节点注册 → 2s 内挂载（扁平：无需任何展开操作） ──────────
    const live = registerChild(db, { name: "org-live", parentId: seed.root1, taskRef: "org-live" })
    await expect(nodeOf(page, live.id)).toBeVisible({ timeout: 2000 })
    await expect(page.getByTestId("org-row")).toHaveCount(10)
    await expect(rowOf(page, live.id).getByTestId("org-source")).toHaveText("↳ org-root1")

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
  } finally {
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
