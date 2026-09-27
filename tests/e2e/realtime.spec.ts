/**
 * Plan 3 T3 —— 真 WS 实时 E2E：
 * 进程内起 Hub（`start({port:0})` + 临时 `AGENTCHAT_HOME`）→ 打开页面（已 build 的客户端）→
 * 经 REST 在既有会话发一条新消息 → `expect.poll` 断言 UI 在 2s 内经真 WS 出现变化。
 *
 * 前置：Playwright webServer 自举 `npm run build && npm start`（`createApp` 从 `client/dist` 托管静态页）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { loadConfig } from "../../server/config"
import { openDb } from "../../server/db"
import { start } from "../../server/index"
import { resetWsHub } from "../../server/ws"
import { seed } from "./seed"

test("pushes a REST-created message into the UI within 2s over the real WebSocket", async ({ page }) => {
  resetWsHub()
  const home = mkdtempSync(join(tmpdir(), "agentchat-e2e-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const running = await start({ port: 0, db, home, hubTokenPath: join(home, "hub_token") })
  try {
    const { conversationId } = seed(db, home)

    await page.goto(`${running.url}/`)
    const item = page.getByTestId("conversation-item").first()
    await expect(item).toBeVisible()
    await expect(item).toContainText("seed")
    // 打开会话触发 GET /api/conversations/:id/messages（本任务补的路由）经 REST 载入历史。
    await item.click()

    const response = await page.request.post(
      `${running.url}/api/conversations/${conversationId}/messages`,
      { data: { body: "live-update" } },
    )
    expect(response.ok()).toBe(true)

    await expect.poll(async () => item.innerText(), { timeout: 2000 }).toContain("live-update")
  } finally {
    // 先关页面（停 WS 客户端）并清空 hub 在线连接，否则 `server.close()` 会等待未关闭的 WS 挂起。
    await page.close()
    resetWsHub()
    await running.close()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
