/**
 * Plan 3 T9（评审 C）—— 错误态**真实可达** E2E：
 * 拦截首屏 `/api/conversations` GET 返回 500 → store 置 `loadError` → 空态面板渲染错误态（带重试）；
 * 放开拦截后点击重试 → 重拉成功清除错误位，错误态消失。
 *
 * 使用 webServer 自举的隔离 hub（`AGENTCHAT_HOME` 临时目录）；仅本页的 `page.route` 生效。
 */
import { expect, test } from "@playwright/test"

test("surfaces a reachable error state when the initial load fails, then recovers on retry", async ({
  page,
}) => {
  let failConversations = true
  await page.route("**/api/conversations", (route) => {
    // 仅拦截首屏 GET；放行 `POST /api/conversations`（ensureDm）等其它方法。
    if (failConversations && route.request().method() === "GET") {
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    }
    return route.continue()
  })

  await page.goto("/")

  // 首屏重拉失败 → 错误态可见且带重试按钮。
  await expect(page.getByTestId("state-panel-error")).toBeVisible()
  await expect(page.getByTestId("state-retry")).toBeVisible()
  await expect(page.getByTestId("state-panel-error")).toContainText("暂时无法连接")

  // 放开拦截 → 点击重试 → 重拉成功 → 错误态消失。
  failConversations = false
  await page.getByTestId("state-retry").click()
  await expect(page.getByTestId("state-panel-error")).toHaveCount(0)
})
