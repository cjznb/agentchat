/**
 * Plan 3 T6 —— 通讯录组织树 + 资料卡 E2E（真 Hub + 进程内种子）：
 * 默认折叠第一层 / human 不出现 / 摘要 `N子·M忙` + 聚合徽标 / 手风琴 /
 * 退役灰显不可点 / 状态变化与实时挂载 <2s / 资料卡字段与两按钮。
 *
 * 前置：`npm run build`（`start` 从 `client/dist` 托管静态页；Playwright webServer 只跑 `npm start`）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { registerChild, registerLogical, registerRoot, retire } from "../../server/core/agents"
import { ensureHuman, sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { start } from "../../server/index"
import { applyAgentState } from "../../server/routes/internal"
import { setStatusText, touchAgent } from "../../server/store/agents"
import { resetWsHub } from "../../server/ws"

interface OrgSeed {
  readonly root1: string
  readonly root2: string
  readonly child1: string
  readonly child2: string
  readonly child3: string
  readonly child4: string
  readonly logical: string
}

/** human + 两棵根树（含 busy/退役/逻辑/多层）+ 未读；返回 id 以便精确断言。 */
function seedOrg(db: Db, home: string): OrgSeed {
  const human = ensureHuman(db)
  const root1 = registerRoot(db, home, {
    name: "org-root1",
    vendor: "opencode",
    model: "m1",
    purpose: "总控协调",
    roleTag: "组织者",
    remark: "主根",
  }).agent
  const root2 = registerRoot(db, home, { name: "org-root2", vendor: "claude-code" }).agent
  const child1 = registerChild(db, {
    name: "org-child1",
    parentId: root1.id,
    taskRef: "org-t1",
    vendor: "claude-code",
    model: "sonnet",
    purpose: "前端实现",
    roleTag: "执行者",
    skills: ["react", "css"],
  })
  const child2 = registerChild(db, {
    name: "org-child2",
    parentId: root1.id,
    taskRef: "org-t2",
    vendor: "opencode",
    roleTag: "监管者",
  })
  const child3 = registerChild(db, { name: "org-child3", parentId: root1.id, taskRef: "org-t3" })
  const child4 = registerChild(db, { name: "org-child4", parentId: root2.id, taskRef: "org-t4" })
  const logical = registerLogical(db, { name: "org-board" })
  touchAgent(db, child2.id, "busy")
  setStatusText(db, child2.id, "编译中")
  sendMessage(db, { from: child1.id, to: root1.id, body: "root1-ping" }) // root1 聚合未读 = 1
  sendMessage(db, { from: child1.id, to: human.id, body: "child1-ping" }) // child1 参与 human DM
  retire(db, child3.id)
  return {
    root1: root1.id,
    root2: root2.id,
    child1: child1.id,
    child2: child2.id,
    child3: child3.id,
    child4: child4.id,
    logical: logical.id,
  }
}

function rowOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="org-row"][data-node-id="${id}"]`)
}
function nodeOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="org-node"][data-node-id="${id}"]`)
}
/** 确保某根行处于展开态（`.first()` 取本行自身的 toggle，避免命中嵌套子行）。 */
async function ensureExpanded(page: Page, id: string): Promise<void> {
  const toggle = rowOf(page, id).getByTestId("org-toggle").first()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
}

test("org tree: collapsed default, summary+badge, accordion, retired grey, live mount, contact card", async ({
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

    // 默认折叠：第一层仅根主 agent + 逻辑节点；子级不渲染。
    await expect(rowOf(page, seed.root1)).toBeVisible()
    await expect(rowOf(page, seed.root2)).toBeVisible()
    await expect(rowOf(page, seed.logical)).toBeVisible()
    await expect(nodeOf(page, seed.child1)).toHaveCount(0)

    // human 不出现在树。
    await expect(page.locator('[data-testid="org-node"]', { hasText: "用户" })).toHaveCount(0)

    // 逻辑节点特殊图标。
    await expect(nodeOf(page, seed.logical).locator(".node-icon")).toHaveText("◆")

    // 摘要 `N子·M忙` + 聚合未读徽标（root1=1，root2=0 无徽标）。
    await expect(rowOf(page, seed.root1).getByTestId("org-summary").first()).toHaveText("3子·1忙")
    await expect(rowOf(page, seed.root2).getByTestId("org-summary").first()).toHaveText("1子·0忙")
    await expect(rowOf(page, seed.root1).getByTestId("unread-badge").first()).toHaveText("1")
    await expect(rowOf(page, seed.root2).getByTestId("unread-badge")).toHaveCount(0)

    // 展开 root1：子行可见；退役子行灰显、留原位、不可点。
    await rowOf(page, seed.root1).getByTestId("org-toggle").first().click()
    await expect(nodeOf(page, seed.child1)).toBeVisible()
    await expect(nodeOf(page, seed.child3)).toHaveAttribute("data-retired", "true")
    await expect(nodeOf(page, seed.child3)).toBeDisabled()

    // busy 状态点 + 状态文字；role 彩色标签。
    await expect(nodeOf(page, seed.child2).locator(".node-dot")).toHaveText("🟠")
    await expect(nodeOf(page, seed.child2).getByTestId("status-text")).toHaveText("编译中")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveText("执行者")
    await expect(nodeOf(page, seed.child1).getByTestId("role-tag")).toHaveAttribute(
      "data-tone",
      "executor",
    )

    // 手风琴：展开 root2 收起 root1。
    await rowOf(page, seed.root2).getByTestId("org-toggle").first().click()
    await expect(nodeOf(page, seed.child4)).toBeVisible()
    await expect(nodeOf(page, seed.child1)).toHaveCount(0)

    // 实时：状态变化（/internal/state 同路径）→ 摘要 <2s 刷新。
    applyAgentState(db, { agentId: seed.child4, state: "busy" })
    await expect(rowOf(page, seed.root2).getByTestId("org-summary").first()).toHaveText("1子·1忙", {
      timeout: 2000,
    })

    // 实时：新子节点注册 → 2s 内挂载到父下。
    await ensureExpanded(page, seed.root1)
    const live = registerChild(db, { name: "org-live", parentId: seed.root1, taskRef: "org-live" })
    await expect(nodeOf(page, live.id)).toBeVisible({ timeout: 2000 })

    // 资料卡：点节点 → 字段齐全 + 两按钮。
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
    await ensureExpanded(page, seed.root1)
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
