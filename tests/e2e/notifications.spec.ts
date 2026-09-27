/**
 * Plan 3 T8 —— 审批卡 + 批示卡 + 通知页 E2E（真 Hub + 进程内种子）：
 * - 审批卡：同意/拒绝 → 已决态、按钮消失、二次决议 409、通知页状态同步
 * - 批示卡：选项 / 自定义答复 / `allowCustom=false` 隐藏输入 / 首答后禁用 / 二次答复 409
 * - ask id 打审批端点：服务端 404 且 UI 不产生该请求、卡不被破坏
 * - 通知页：两 tab、未读点、点击已读 + 深链跳转高亮、图标栏徽标 = actionable 未读数
 * - WS 一致性：外部答复 ask → `approval` 事件 → 通知页即时刷新
 *
 * 前置：Playwright webServer 自举 `npm run build && npm start`（`start` 从 `client/dist` 托管静态页）。
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ask } from "../../server/core/ask"
import { respondAsk } from "../../server/core/respond"
import { start } from "../../server/index"
import { resetWsHub } from "../../server/ws"
import { cardRef, seedApproval, seedBase, type Base } from "./seed"

function openNotifications(page: Page): Promise<void> {
  return page.getByRole("button", { name: "通知" }).click()
}

async function teardown(page: Page, base: Base, running: { close(): Promise<void> }): Promise<void> {
  await page.close()
  resetWsHub()
  await running.close()
  base.db.close()
  rmSync(base.home, { recursive: true, force: true })
}

test("approves an action card, syncs the notification entry, and marks read on jump", async ({ page }) => {
  resetWsHub()
  const base = seedBase("agentchat-notif-approve-")
  const approval = seedApproval(base, "审批：全员播报")
  const running = await start({ port: 0, db: base.db, home: base.home, hubTokenPath: join(base.home, "hub_token") })
  try {
    await page.goto(`${running.url}/?conversation=${approval.card.conversationId}&msg=${approval.card.messageId}`)
    const target = page.locator(`[data-message-id="${approval.card.messageId}"]`)
    await expect(target).toHaveAttribute("data-highlight", "true")

    const card = target.getByTestId("chat-card")
    await expect(card).toHaveAttribute("data-kind", "approval")
    await expect(card).toContainText("全员喊话")
    await card.getByTestId("card-approve").click()

    // 已决态：结果文案出现、按钮消失。
    await expect(card.getByTestId("card-verdict")).toContainText("已同意")
    await expect(card.getByTestId("card-approve")).toHaveCount(0)

    // 二次决议被服务端拒绝（409），卡保持已决。
    const again = await page.request.post(`${running.url}/api/approvals/${approval.id}`, {
      data: { decision: "reject" },
    })
    expect(again.status()).toBe(409)

    // 通知页：actionable 已清空；全部 tab 显示已通过。
    await openNotifications(page)
    await expect(page.getByTestId("notifications-view")).toBeVisible()
    await expect(page.getByTestId("notifications-empty")).toBeVisible()
    await page.getByTestId("notif-tab-all").click()
    const item = page.getByTestId("notification-item").filter({ hasText: "全员喊话" })
    await expect(item).toHaveAttribute("data-status", "approved")
    await expect(item.getByTestId("notification-result")).toContainText("已同意")

    // 点击条目 → 已读 + 深链跳转回卡并高亮。
    await item.getByTestId("notification-open").click()
    await expect(page.getByTestId("chat-view")).toBeVisible()
    await expect(target).toHaveAttribute("data-highlight", "true")
    expect(page.url()).toContain(`msg=${approval.card.messageId}`)
    await expect(page.getByTestId("notification-badge")).toHaveCount(0)
  } finally {
    await teardown(page, base, running)
  }
})

test("rejects a card and never routes an ask id to the approval endpoint", async ({ page }) => {
  resetWsHub()
  const base = seedBase("agentchat-notif-reject-")
  const approval = seedApproval(base, "审批：清空数据")
  const pendingAsk = ask(base.db, base.rootId, {
    to: "human",
    question: "部署到哪个环境？",
    options: ["staging", "prod"],
  }).ask
  const askCard = cardRef(base.db, pendingAsk.id)
  const approvalHits: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/approvals/")) approvalHits.push(request.url())
  })
  const running = await start({ port: 0, db: base.db, home: base.home, hubTokenPath: join(base.home, "hub_token") })
  try {
    await page.goto(`${running.url}/?conversation=${approval.card.conversationId}&msg=${approval.card.messageId}`)
    await page.locator(`[data-message-id="${approval.card.messageId}"]`).getByTestId("card-reject").click()
    await expect(page.getByTestId("card-verdict")).toContainText("已拒绝")

    // 批示卡：无同意/拒绝按钮（UI 不把 ask id 分流到审批端点）。
    await page.goto(`${running.url}/?conversation=${askCard.conversationId}&msg=${askCard.messageId}`)
    const node = page.locator(`[data-message-id="${askCard.messageId}"]`)
    await expect(node).toBeVisible()
    await expect(node.getByTestId("chat-card")).toHaveAttribute("data-kind", "ask")
    await expect(node.getByTestId("card-approve")).toHaveCount(0)
    await expect(node.getByTestId("card-reject")).toHaveCount(0)

    // 服务端：ask id 打审批端点 → 404 `ask_not_found`，卡不变（仍可作答）。
    const wrong = await page.request.post(`${running.url}/api/approvals/${pendingAsk.id}`, {
      data: { decision: "approve" },
    })
    expect(wrong.status()).toBe(404)
    await expect(node.getByTestId("card-verdict")).toHaveCount(0)
    await expect(node.getByTestId("card-choice").first()).toBeEnabled()

    // UI 从未发起针对该 ask id 的审批请求。
    expect(approvalHits.some((url) => url.includes(pendingAsk.id))).toBe(false)
  } finally {
    await teardown(page, base, running)
  }
})

test("answers ask cards by option and custom text and hides custom input when disallowed", async ({ page }) => {
  resetWsHub()
  const base = seedBase("agentchat-notif-ask-")
  const askA = ask(base.db, base.rootId, {
    to: "human",
    question: "部署到哪？",
    options: ["staging", "prod"],
    allowCustom: true,
  }).ask
  const askB = ask(base.db, base.rootId, {
    to: "human",
    question: "确认发布？",
    options: ["ok"],
    allowCustom: false,
  }).ask
  const askC = ask(base.db, base.rootId, {
    to: "human",
    question: "补充说明？",
    options: [],
    allowCustom: true,
  }).ask
  const cardA = cardRef(base.db, askA.id)
  const cardB = cardRef(base.db, askB.id)
  const cardC = cardRef(base.db, askC.id)
  const running = await start({ port: 0, db: base.db, home: base.home, hubTokenPath: join(base.home, "hub_token") })
  try {
    await page.goto(`${running.url}/?conversation=${cardA.conversationId}&msg=${cardA.messageId}`)
    const nodeA = page.locator(`[data-message-id="${cardA.messageId}"]`)
    await expect(nodeA.getByTestId("card-choice")).toHaveCount(2)
    await expect(nodeA.getByTestId("card-custom-input")).toBeVisible()

    // 选项作答：所选高亮、输入框消失、按钮禁用、二次答复 409。
    await nodeA.getByTestId("card-choice").filter({ hasText: "staging" }).click()
    await expect(nodeA.getByTestId("card-verdict")).toContainText("已选择「staging」")
    await expect(nodeA.locator('[data-testid="card-choice"][data-selected="true"]')).toHaveCount(1)
    await expect(nodeA.getByTestId("card-custom-input")).toHaveCount(0)
    await expect(nodeA.getByTestId("card-choice").first()).toBeDisabled()
    const second = await page.request.post(`${running.url}/api/asks/${askA.id}/respond`, {
      data: { choice: "prod" },
    })
    expect(second.status()).toBe(409)
    await expect(nodeA.getByTestId("card-verdict")).toContainText("已选择「staging」")

    // allowCustom=false：仅选项、无自定义输入。
    const nodeB = page.locator(`[data-message-id="${cardB.messageId}"]`)
    await expect(nodeB.getByTestId("card-choice")).toHaveCount(1)
    await expect(nodeB.getByTestId("card-custom-input")).toHaveCount(0)

    // 自定义答复：展示文本。
    const nodeC = page.locator(`[data-message-id="${cardC.messageId}"]`)
    await expect(nodeC.getByTestId("card-choice")).toHaveCount(0)
    await nodeC.getByTestId("card-custom-input").fill("稍等十分钟")
    await nodeC.getByTestId("card-custom-send").click()
    await expect(nodeC.getByTestId("card-verdict")).toContainText("已答复：稍等十分钟")
    await expect(nodeC.getByTestId("card-custom-input")).toHaveCount(0)
  } finally {
    await teardown(page, base, running)
  }
})

test("notification center: tabs, unread dots, badge, jump highlight, and WS consistency", async ({ page }) => {
  resetWsHub()
  const base = seedBase("agentchat-notif-center-")
  const ask1 = ask(base.db, base.rootId, { to: "human", question: "第一件", options: ["是", "否"] }).ask
  const ask2 = ask(base.db, base.rootId, { to: "human", question: "第二件", options: ["是", "否"] }).ask
  const card2 = cardRef(base.db, ask2.id)
  const running = await start({ port: 0, db: base.db, home: base.home, hubTokenPath: join(base.home, "hub_token") })
  try {
    await page.goto(`${running.url}/`)
    await expect(page.getByTestId("notification-badge")).toHaveText("2")

    // actionable tab：两条待处理，皆未读。
    await openNotifications(page)
    await expect(page.getByTestId("notification-item")).toHaveCount(2)
    await expect(page.locator('[data-testid="notification-unread"][data-unread="true"]')).toHaveCount(2)
    await page.getByTestId("notif-tab-all").click()
    await expect(page.getByTestId("notification-item")).toHaveCount(2)
    await page.getByTestId("notif-tab-actionable").click()

    // 点击 ask2 条目 → 已读 + 跳转卡并高亮；徽标 2 → 1。
    // 不假设「后创建者必在首条」（同 created_at 并列时旧实现次序随机）：按可见主题文本定位，
    // 再读取该条目自身的 `data-card-message-id`/`data-notification-id` 作为断言锚点。
    const secondItem = page.getByTestId("notification-item").filter({ hasText: "第二件" })
    const clickedMessageId = await secondItem.getAttribute("data-card-message-id")
    const clickedNotificationId = await secondItem.getAttribute("data-notification-id")
    // 条目深链锚点即服务端 cardRef 的卡消息（而非靠列表位置推断）。
    expect(clickedMessageId).toBe(card2.messageId)
    expect(clickedNotificationId).toBe(ask2.id)

    await secondItem.getByTestId("notification-open").click()
    await expect(page.getByTestId("chat-view")).toBeVisible()
    await expect(page.locator(`[data-message-id="${clickedMessageId}"]`)).toHaveAttribute("data-highlight", "true")
    expect(page.url()).toContain(`msg=${clickedMessageId}`)
    await expect(page.getByTestId("notification-badge")).toHaveText("1")

    // WS 一致性：外部答复 ask2 → `approval` 事件 → 通知页刷新（actionable 仅剩 ask1）。
    respondAsk(base.db, ask2.id, base.humanId, { choice: "是" })
    await openNotifications(page)
    await expect(page.getByTestId("notification-item")).toHaveCount(1)
    const remaining = page.getByTestId("notification-item").filter({ hasText: "第一件" })
    await expect(remaining).toHaveAttribute("data-status", "pending")
    await expect(page.getByTestId("notification-badge")).toHaveText("1")

    // 点击余下条目 → 已读 → 徽标隐藏、未读归零。
    await remaining.getByTestId("notification-open").click()
    await expect(page.getByTestId("notification-badge")).toHaveCount(0)
    await openNotifications(page)
    await expect(page.locator('[data-testid="notification-unread"][data-unread="true"]')).toHaveCount(0)
    await expect(page.getByTestId("notification-unread-total")).toContainText("0 未读")

    // 全部 tab：已答复的 ask2 携带结果文案。
    await page.getByTestId("notif-tab-all").click()
    const answered = page.getByTestId("notification-item").filter({ hasText: "第二件" })
    await expect(answered).toHaveAttribute("data-status", "answered")
    await expect(answered.getByTestId("notification-result")).toContainText("已选择「是」")
    expect(ask1.id).not.toBe(ask2.id)
  } finally {
    await teardown(page, base, running)
  }
})

test("replies to a pending item inline from the notification list and syncs the tab", async ({ page }) => {
  resetWsHub()
  const base = seedBase("agentchat-notif-inline-")
  ask(base.db, base.rootId, {
    to: "human",
    question: "内联答复确认？",
    options: ["可以", "不行"],
    allowCustom: true,
  })
  const running = await start({ port: 0, db: base.db, home: base.home, hubTokenPath: join(base.home, "hub_token") })
  try {
    await page.goto(`${running.url}/`)
    await openNotifications(page)
    const item = page.getByTestId("notification-item").first()
    // 通知条目内**内联**渲染卡回复控件（与聊天卡共用 `CardActions`，spec §11.5）。
    await expect(item.getByTestId("card-choice")).toHaveCount(2)
    await item.getByTestId("card-choice").filter({ hasText: "可以" }).click()

    // 作答后该条目移出 actionable → 空态；全部 tab 显示已答复与结果文案。
    await expect(page.getByTestId("notifications-empty")).toBeVisible()
    await page.getByTestId("notif-tab-all").click()
    const answered = page.getByTestId("notification-item").filter({ hasText: "内联答复确认？" })
    await expect(answered).toHaveAttribute("data-status", "answered")
    await expect(answered.getByTestId("notification-result")).toContainText("已选择「可以」")
  } finally {
    await teardown(page, base, running)
  }
})
