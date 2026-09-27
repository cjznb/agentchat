/**
 * Plan 3 T5 —— 聊天视图 E2E（真 Hub + 进程内种子）：
 * 气泡左右 / 系统消息居中 / 回车发送 / 滚顶分页 / 深链定位高亮 / 四级回执（core ack → read）。
 *
 * 前置：Playwright webServer 自举 `npm run build && npm start`（`start` 从 `client/dist` 托管静态页）。
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { registerChild } from "../../server/core/agents"
import { ack, sendMessage } from "../../server/core/messaging"
import { start } from "../../server/index"
import { send as storeSend } from "../../server/store/messages"
import { resetWsHub } from "../../server/ws"
import { seedBase, type Seeded } from "./seed"

async function teardown(page: Page, seeded: Seeded, running: { close(): Promise<void> }): Promise<void> {
  await page.close()
  resetWsHub()
  await running.close()
  seeded.db.close()
  rmSync(seeded.home, { recursive: true, force: true })
}

test("renders own/peer bubbles, a centered system message, and progresses a receipt to read", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-e2e-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    sendMessage(seeded.db, { from: seeded.rootId, to: seeded.humanId, body: "pong" })
    storeSend(seeded.db, {
      conversationId: seeded.dmId,
      fromAgentId: seeded.rootId,
      body: "chat-root 加入群聊",
      kind: "system",
    })

    await page.goto(`${running.url}/`)
    const item = page.getByTestId("conversation-item").first()
    await expect(item).toBeVisible()
    await item.click()

    const own = page.locator('[data-testid="message-row"][data-own="true"]')
    const peer = page.locator('[data-testid="message-row"][data-own="false"]')
    await expect(own.filter({ hasText: "seed" })).toBeVisible()
    await expect(peer.filter({ hasText: "pong" })).toBeVisible()

    // 系统消息居中灰字。
    const system = page.getByTestId("message-system")
    await expect(system).toContainText("加入群聊")
    const justify = await system.evaluate(
      (node) => node.ownerDocument.defaultView?.getComputedStyle(node).justifyContent ?? "",
    )
    expect(justify).toBe("center")

    // 己方四级回执：初始 queued，core ack 后经 WS 对账 → read。
    const receipt = own.filter({ hasText: "seed" }).getByTestId("receipt")
    await expect(receipt).toHaveAttribute("data-stage", "queued")
    await expect(receipt).toContainText("排队中")
    expect(ack(seeded.db, seeded.rootId, [seeded.seedMessageId])).toBe(1)
    await expect.poll(async () => receipt.getAttribute("data-stage"), { timeout: 3000 }).toBe("read")
    await expect(receipt).toContainText("已读")
  } finally {
    await teardown(page, seeded, running)
  }
})

test("sends with Enter and clears the composer", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-send-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    await page.goto(`${running.url}/`)
    await page.getByTestId("conversation-item").first().click()

    const input = page.getByTestId("composer-input")
    const send = page.getByTestId("composer-send")
    await expect(send).toBeDisabled()
    await input.fill("   ")
    await expect(send).toBeDisabled()

    await input.fill("hello-from-ui")
    await expect(send).toBeEnabled()
    await input.press("Enter")

    await expect(
      page.locator('[data-testid="message-row"][data-own="true"]', { hasText: "hello-from-ui" }),
    ).toBeVisible()
    await expect(input).toHaveValue("")
  } finally {
    await teardown(page, seeded, running)
  }
})

test("pages older history when scrolled to the top without duplicates", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-page-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    // 首屏仅最新 50（服务端默认页大小）；再补 59 条（含种子共 60）供上翻。
    for (let index = 0; index < 59; index += 1) {
      sendMessage(seeded.db, { from: seeded.humanId, to: seeded.rootId, body: `msg-${index}` })
    }

    await page.goto(`${running.url}/`)
    await page.getByTestId("conversation-item").first().click()

    const scroll = page.getByTestId("chat-scroll")
    const rows = page.locator('[data-testid="message-row"], [data-testid="message-system"]')
    await expect(rows).toHaveCount(50)
    await expect(page.getByTestId("message-count")).toHaveText("50")

    await scroll.evaluate((node) => {
      node.scrollTop = 0
      node.dispatchEvent(new Event("scroll"))
    })
    await expect.poll(async () => rows.count(), { timeout: 3000 }).toBe(60)

    // 零重复：id 集合大小 = 行数。
    const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")))
    expect(new Set(ids).size).toBe(ids.length)

    // 上滚加载更多后制造事件（新消息 WS → refetch）：已加载旧页不得被整桶替换丢弃（复审 I2）。
    sendMessage(seeded.db, { from: seeded.humanId, to: seeded.rootId, body: "after-page" })
    await expect.poll(async () => rows.count(), { timeout: 3000 }).toBe(61)
    await expect(page.locator('[data-testid="message-row"]', { hasText: "msg-0" })).toHaveCount(1)
  } finally {
    await teardown(page, seeded, running)
  }
})

test("deep link opens the conversation, scrolls to the message, highlights then clears", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-deeplink-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    // 深链指向次条消息（初始贴底时在视口外）。
    const targetId = sendMessage(seeded.db, {
      from: seeded.humanId,
      to: seeded.rootId,
      body: "deep-link-target",
    }).message.id
    for (let index = 0; index < 18; index += 1) {
      sendMessage(seeded.db, { from: seeded.humanId, to: seeded.rootId, body: `dl-${index}` })
    }

    await page.goto(`${running.url}/?conversation=${seeded.dmId}&msg=${targetId}`)
    const target = page.locator(`[data-message-id="${targetId}"]`)
    await expect(target).toHaveClass(/is-highlighted/)
    await expect(target).toBeInViewport()

    // 高亮窗口内触发该会话 refetch（receipt WS → 整页对账）：ack 目标消息 → 其回执转 read，
    // 即证对账已在窗口内完成；高亮仍须清除，不得被 refetch 取消 / 残留（复审 I1）。
    const receipt = target.getByTestId("receipt")
    await expect(receipt).toHaveAttribute("data-stage", "queued")
    expect(ack(seeded.db, seeded.rootId, [targetId])).toBe(1)
    await expect(receipt).toHaveAttribute("data-stage", "read")
    // 有界轮询：捕获「永不清理」的回归；窗口放宽以容忍 CI 负载下的计时器调度延迟。
    await expect.poll(async () => target.getAttribute("data-highlight"), { timeout: 6000 }).toBeNull()
  } finally {
    await teardown(page, seeded, running)
  }
})

test("deep link pages back beyond the first page; a malformed msg shows a notice without crashing", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-deeplink2-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    // 目标落在第 2 页（首屏仅最新 50；目标 seq≈2）。
    const targetId = sendMessage(seeded.db, {
      from: seeded.humanId,
      to: seeded.rootId,
      body: "page2-target",
    }).message.id
    for (let index = 0; index < 60; index += 1) {
      sendMessage(seeded.db, { from: seeded.humanId, to: seeded.rootId, body: `old-${index}` })
    }

    await page.goto(`${running.url}/?conversation=${seeded.dmId}&msg=${targetId}`)
    const target = page.locator(`[data-message-id="${targetId}"]`)
    await expect(target).toHaveClass(/is-highlighted/, { timeout: 6000 })
    await expect(target).toBeInViewport()

    // F2③：非法 msg（含引号，曾是 `querySelector` 注入面）→ 不崩，显式「消息不可定位」。
    await page.goto(`${running.url}/?conversation=${seeded.dmId}&msg=${encodeURIComponent('"')}`)
    await expect(page.getByTestId("focus-missing")).toBeVisible({ timeout: 6000 })
  } finally {
    await teardown(page, seeded, running)
  }
})

test("submits once on a rapid double submit and rolls back the optimistic bubble on failure", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-lock-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    let posts = 0
    let failPosts = false
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue()
        return
      }
      posts += 1
      if (failPosts) {
        await route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        return
      }
      await route.continue()
    })
    await page.goto(`${running.url}/`)
    await page.getByTestId("conversation-item").first().click()

    const input = page.getByTestId("composer-input")
    const own = page.locator('[data-testid="message-row"][data-own="true"]')
    await input.fill("once-only")
    // 同帧连续两次 submit：同步 ref 锁须令第二次短路（只发一条）。
    await page.getByTestId("composer").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    await expect(own.filter({ hasText: "once-only" })).toHaveCount(1)
    await expect.poll(() => posts).toBe(1)

    // F4③：失败 → 乐观气泡回滚、草稿保留、错误提示可见。
    failPosts = true
    await input.fill("will-fail")
    await input.press("Enter")
    await expect(page.getByTestId("composer-error")).toBeVisible()
    await expect(input).toHaveValue("will-fail")
    await expect(own.filter({ hasText: "will-fail" })).toHaveCount(0)
  } finally {
    await teardown(page, seeded, running)
  }
})

test("shows the [子·根名] badge for a child sender in a direct message", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-chat-badge-")
  const running = await start({ port: 0, db: seeded.db, home: seeded.home, hubTokenPath: join(seeded.home, "hub_token") })
  try {
    const child = registerChild(seeded.db, {
      name: "chat-child",
      parentId: seeded.rootId,
      taskRef: "chat-child",
      vendor: "opencode",
    })
    sendMessage(seeded.db, { from: child.id, to: seeded.humanId, body: "child-hello" })

    await page.goto(`${running.url}/`)
    const rootRow = page.locator('[data-testid="root-row"]', { hasText: "chat-root" })
    await rootRow.getByTestId("fold-toggle").click()
    await page.getByTestId("conversation-item").filter({ hasText: "chat-child" }).click()
    // 私聊（非群）也显示子徽标（spec §11.4 未限定群聊）。
    await expect(
      page.locator('[data-testid="message-row"][data-own="false"]').getByTestId("child-badge"),
    ).toHaveText("[子·chat-root]")
  } finally {
    await teardown(page, seeded, running)
  }
})
