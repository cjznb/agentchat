/**
 * 三层 UI 视觉测试仪器 —— 层1 溢出断言 + 层2 区域截图（层3 AI 判读由控制器执行）。
 *
 * 首跑语义：层1 对**存量缺陷**（rail 8px、群资料改名行裁切等）预期失败 —— 
 * 这是发现信号，不算 V1 任务失败。所有截图与 offender 落盘先于断言产出，
 * 保证产图与清单不受红灯影响。绝对隔离：不 import server 代码、不含 Hub 端口。
 */
import { expect, test, type Page } from "@playwright/test"
import { expectNoOverflow, openApp, shot } from "./helper"
import { GROUP_CONV, GROUP_TITLE } from "./fixtures/api-fixtures"

/** 打开群会话（深链优先；消息未载入则回落点列表行）。 */
async function openGroupChat(page: Page): Promise<void> {
  await openApp(page, GROUP_CONV)
  await expect(page.getByTestId("chat-view")).toBeVisible()
  const messageList = page.getByTestId("message-list")
  try {
    await expect(messageList).toBeVisible({ timeout: 3000 })
  } catch {
    await page.getByTestId("conversation-item").filter({ hasText: GROUP_TITLE }).click()
    await expect(messageList).toBeVisible()
  }
}

test("场景a：聊天主视图+会话列表+rail", async ({ page }) => {
  await openGroupChat(page)
  await shot(page, "chat-main", "full")
  await shot(page, "chat-main", "rail", page.getByTestId("icon-rail"))
  await shot(page, "chat-main", "list", page.getByTestId("middle-list"))
  await shot(page, "chat-main", "view", page.getByTestId("right-view"))
  await expectNoOverflow(page, "chat-main")
})

test("场景b：群资料面板+改名编辑行激活", async ({ page }) => {
  await openGroupChat(page)
  await page.getByTestId("group-info-toggle").click()
  await expect(page.getByTestId("group-info")).toBeVisible()
  await page.getByTestId("member-rename").first().click()
  await expect(page.getByTestId("member-rename-form")).toBeVisible()
  await expect(page.getByTestId("member-rename-cancel")).toBeVisible()
  await shot(page, "group-rename", "full")
  await shot(page, "group-rename", "panel", page.getByTestId("group-info"))
  await shot(page, "group-rename", "rename-row", page.getByTestId("member-rename-form"))
  await expectNoOverflow(page, "group-rename")
})

test("场景c：新建群聊选人树两层", async ({ page }) => {
  await openApp(page)
  await page.getByTestId("create-group").click()
  await expect(page.getByTestId("group-create")).toBeVisible()
  await expect(page.getByTestId("member-picker")).toBeVisible()
  await page.getByTestId("group-name-input").fill("溢出回归群")
  // 选人树展开两层：点成员行展开开关（member-toggle，存在才点）。
  const toggles = page.getByTestId("member-toggle")
  const toggleCount = Math.min(await toggles.count(), 2)
  for (let index = 0; index < toggleCount; index += 1) {
    await toggles.nth(index).click()
  }
  await expect(page.getByTestId("member-row").first()).toBeVisible()
  // 先产图 + 层1 扫描（保证红灯不影响产图），再做选择交互断言。
  await shot(page, "group-create", "full")
  await shot(page, "group-create", "picker", page.getByTestId("member-picker"))
  await expectNoOverflow(page, "group-create")
  await page.getByTestId("member-check").nth(0).click()
  await page.getByTestId("member-check").nth(1).click()
  await expect(page.getByTestId("member-count")).toContainText("已选 2")
})

test("场景d1：通知页", async ({ page }) => {
  await openApp(page)
  await page.locator(".rail-button").filter({ hasText: "通知" }).click()
  await expect(page.getByTestId("notifications-view")).toBeVisible()
  await expect(page.getByTestId("notifications-list")).toBeVisible()
  await shot(page, "notifications", "full")
  await shot(page, "notifications", "view", page.getByTestId("notifications-view"))
  await shot(page, "notifications", "list", page.getByTestId("notifications-list"))
  await expectNoOverflow(page, "notifications")
})

test("场景d2：设置页", async ({ page }) => {
  await openApp(page)
  await page.locator(".rail-button").filter({ hasText: "设置" }).click()
  await expect(page.getByTestId("settings-panel")).toBeVisible()
  await shot(page, "settings", "full")
  await shot(page, "settings", "panel", page.getByTestId("settings-panel"))
  await expectNoOverflow(page, "settings")
})
