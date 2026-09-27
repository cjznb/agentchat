/**
 * Plan 3 T7 —— 群组 + 喊话 E2E（真 Hub + 进程内种子）：
 * 组织树多选建群（human 不可选）→ 列表出现且可直接开聊；
 * 群资料 → 加成员 → 成员树即时更新；
 * 喊话频道发送 `POST /api/shout` → 逐节点投递汇总与真实回执一致，且随 `receipt` 事件刷新。
 *
 * 前置：`npm run build`（`start` 从 `client/dist` 托管静态页；Playwright webServer 只跑 `npm start`）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { registerChild, registerLogical, registerRoot } from "../../server/core/agents"
import { ack, ensureHuman } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { start } from "../../server/index"
import { getConversationByKey, SHOUT_KEY } from "../../server/store/conversations"
import { latestInConversation } from "../../server/store/messages"
import { resetWsHub } from "../../server/ws"

interface GroupsSeed {
  readonly humanId: string
  readonly root1: string
  readonly root2: string
  readonly child1: string
  readonly child2: string
  readonly logical: string
}

/** human + 两棵树（子/逻辑混合）+ root1 两名子节点；用于多选建群与喊话收件方。 */
function seedGroups(db: Db, home: string): GroupsSeed {
  const human = ensureHuman(db)
  const root1 = registerRoot(db, home, { name: "gs-root1", vendor: "opencode" }).agent
  const root2 = registerRoot(db, home, { name: "gs-root2", vendor: "claude-code" }).agent
  const child1 = registerChild(db, { name: "gs-child1", parentId: root1.id, taskRef: "gs-t1" })
  const child2 = registerChild(db, { name: "gs-child2", parentId: root1.id, taskRef: "gs-t2" })
  const logical = registerLogical(db, { name: "gs-board" })
  return {
    humanId: human.id,
    root1: root1.id,
    root2: root2.id,
    child1: child1.id,
    child2: child2.id,
    logical: logical.id,
  }
}

function memberRow(page: Page, id: string): Locator {
  return page.locator(`[data-testid="member-row"][data-node-id="${id}"]`)
}
function groupMember(page: Page, id: string): Locator {
  return page.locator(`[data-testid="group-member"][data-node-id="${id}"]`)
}

test("builds a group from a multi-select tree, adds members, and summarizes a shout", async ({ page }) => {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), "agentchat-groups-e2e-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  try {
    const seed = seedGroups(db, home)
    await page.goto(`${running.url}/`)

    // ── 建群：从组织树多选（含子 agent 与逻辑节点）──────────────────
    await page.getByTestId("create-group").click()
    await expect(page.getByTestId("group-create")).toBeVisible()
    await expect(page.getByTestId("member-picker")).toBeVisible()

    // human 不可选：选择器内不出现「用户」节点行。
    await expect(page.locator('[data-testid="member-row"]', { hasText: "用户" })).toHaveCount(0)

    await page.getByTestId("group-name-input").fill("gs-group")
    await memberRow(page, seed.root1).getByTestId("member-toggle").click()
    await memberRow(page, seed.child1).getByTestId("member-check").check()
    await memberRow(page, seed.logical).getByTestId("member-check").check()
    await expect(page.getByTestId("member-count")).toHaveText("已选 2 名")
    await page.getByTestId("group-create-submit").click()

    // 新群出现在列表顶部区并可直接开聊（human 提交即时生效，零审批）。
    await expect(page.getByTestId("chat-view")).toBeVisible()
    await expect(page.getByTestId("chat-view").locator("h1")).toContainText("gs-group", {
      timeout: 3000,
    })
    await expect(
      page.getByTestId("conversation-item").filter({ hasText: "gs-group" }),
    ).toBeVisible()

    // ── 群资料：成员树状归属（含所属根）+ 加成员即时更新 ──────────────
    await page.getByTestId("group-info-toggle").click()
    await expect(page.getByTestId("group-info")).toBeVisible()
    await expect(page.getByTestId("group-member-count")).toHaveText("成员 2")
    // 成员按所属根分组：child1 归 gs-root1，逻辑节点自成一「根」。
    await expect(
      page.getByTestId("member-group").filter({ hasText: "gs-root1" }).getByTestId("group-member"),
    ).toHaveCount(1)
    await expect(groupMember(page, seed.child1)).toBeVisible()
    await expect(groupMember(page, seed.logical)).toBeVisible()
    // human 不出现在成员树；下拉亦不含 human。
    await expect(groupMember(page, seed.humanId)).toHaveCount(0)
    await expect(page.getByTestId("group-add-select").locator("option", { hasText: "用户" })).toHaveCount(0)

    await page.getByTestId("group-add-select").selectOption({ label: "gs-child2" })
    await page.getByTestId("group-add-submit").click()
    await expect(groupMember(page, seed.child2)).toBeVisible()
    await expect(page.getByTestId("group-member-count")).toHaveText("成员 3")

    // ── 喊话频道：发送 + 逐节点投递汇总 ──────────────────────────────
    await page.getByRole("button", { name: "喊话" }).click()
    await expect(page.getByTestId("shout-view")).toBeVisible()
    await expect(page.getByRole("heading", { name: "全员喊话", level: 1 })).toBeVisible()

    await page.getByTestId("shout-input").fill("全员注意")
    await page.getByTestId("shout-send").click()

    // 收件方 = 全部 agent 去掉 human = root1/root2/child1/child2/logical = 5；无适配器 → 全排队。
    await expect(page.getByTestId("shout-queued")).toHaveText("5")
    await expect(page.getByTestId("shout-online")).toHaveText("0")
    await expect(page.getByTestId("shout-left")).toHaveText("0")

    // 真实回执演进：root1 ack → `receipt` 事件 → 汇总刷新为 在线 1 / 排队 4。
    const shoutId = getConversationByKey(db, SHOUT_KEY)?.id
    if (shoutId === undefined) throw new Error("shout conversation missing after send")
    const shoutMessage = latestInConversation(db, shoutId)
    if (shoutMessage === undefined) throw new Error("shout message missing after send")
    expect(ack(db, seed.root1, [shoutMessage.id])).toBe(1)
    await expect(page.getByTestId("shout-online")).toHaveText("1", { timeout: 3000 })
    await expect(page.getByTestId("shout-queued")).toHaveText("4")
  } finally {
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
