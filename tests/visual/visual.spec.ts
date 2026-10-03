/**
 * 三层 UI 视觉测试仪器 —— 层1 溢出断言 + 层2 区域截图（层3 AI 判读由控制器执行）。
 *
 * 首跑语义：层1 对**存量缺陷**（rail 8px、群资料改名行裁切等）预期失败 —— 
 * 这是发现信号，不算 V1 任务失败。所有截图与 offender 落盘先于断言产出，
 * 保证产图与清单不受红灯影响。绝对隔离：不 import server 代码、不含 Hub 端口。
 */
import { expect, test, type Page } from "@playwright/test"
import { expectNoOverflow, openApp, scanOverflow, shot } from "./helper"
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

test("场景e：窄视口45rem 主视图+rail 指示条不越界（P2-3）", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 860 })
  await openGroupChat(page)
  await shot(page, "narrow-45rem", "full")
  await shot(page, "narrow-45rem", "rail", page.getByTestId("icon-rail"))
  await expectNoOverflow(page, "narrow-45rem")
    const after = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: { querySelector(selector: string): unknown }
      getComputedStyle(element: unknown, pseudoElement?: string): { bottom: string }
    }
    const btn =
      scope.document.querySelector('.rail-button[data-active="true"]') ??
      scope.document.querySelector(".rail-button")
    if (btn === null || btn === undefined) return null
    return { bottom: scope.getComputedStyle(btn, "::after").bottom }
  })
  if (after === null) throw new Error("rail-button 缺失")
  expect(after.bottom).toBe("0px")
})

test("场景f：桌面 rail 指示条贴 rail 右缘（P2-5 方案A）", async ({ page }) => {
  await openGroupChat(page)
    const geom = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: { querySelector(selector: string): unknown }
      getComputedStyle(element: unknown, pseudoElement?: string): { right: string }
    }
    const rail = scope.document.querySelector(".mode-rail")
    const btn =
      scope.document.querySelector('.rail-button[data-active="true"]') ??
      scope.document.querySelector(".rail-button")
    if (rail === null || rail === undefined || btn === null || btn === undefined) return null
    const right = parseFloat(scope.getComputedStyle(btn, "::after").right)
    const railBox = (rail as { getBoundingClientRect(): { right: number } }).getBoundingClientRect()
    const btnBox = (btn as { getBoundingClientRect(): { right: number } }).getBoundingClientRect()
    return { indicatorRight: btnBox.right - right, railRight: railBox.right }
  })
  if (geom === null) throw new Error("rail 几何缺失")
  expect(Math.abs(geom.indicatorRight - geom.railRight)).toBeLessThanOrEqual(1)
  await shot(page, "rail-edge", "rail", page.getByTestId("icon-rail"))
  await expectNoOverflow(page, "rail-edge")
})

test("V1.1：ellipsis 截断豁免（clientWidth>0 门槛）", async ({ page }) => {
  await page.setContent(
    '<style>.trunc{width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:16px/1.4 sans-serif}' +
      '.zero{width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:16px/1.4 sans-serif}</style>' +
      '<div class="trunc">averyveryverylongmembername</div><div class="zero">x</div>',
  )
  const offenders = await scanOverflow(page)
  const classes = offenders.map((offender) => offender.className)
  expect(classes).not.toContain("trunc")
  expect(classes).toContain("zero")
})

test("场景g1：添加成员弹窗可见态（轮D补景）", async ({ page }) => {
  await openGroupChat(page)
  await page.getByTestId("group-info-toggle").click()
  const open = page.getByTestId("group-add-open")
  await open.scrollIntoViewIfNeeded()
  await open.click()
  await expect(page.getByTestId("member-add-dialog")).toBeVisible()
  await shot(page, "member-add", "full")
  await shot(page, "member-add", "dialog", page.getByTestId("member-add-dialog"))
  await expectNoOverflow(page, "member-add")
})

test("场景g2：danger 解散弹窗可见态（轮D补景）", async ({ page }) => {
  await openGroupChat(page)
  await page.getByTestId("group-info-toggle").click()
  const open = page.getByTestId("group-dissolve-open")
  await open.scrollIntoViewIfNeeded()
  await open.click()
  await expect(page.getByTestId("dissolve-dialog")).toBeVisible()
  await shot(page, "dissolve", "full")
  await shot(page, "dissolve", "dialog", page.getByTestId("dissolve-dialog"))
  await expectNoOverflow(page, "dissolve")
})

test("场景g3：成员行移出确认可见态（轮D补景）", async ({ page }) => {
  await openGroupChat(page)
  await page.getByTestId("group-info-toggle").click()
  const remove = page.getByTestId("member-remove").first()
  await remove.scrollIntoViewIfNeeded()
  await remove.click()
  await expect(page.getByTestId("member-remove-confirm")).toBeVisible()
  await shot(page, "member-remove", "full")
  await shot(page, "member-remove-confirm", "row", page.getByTestId("member-remove-confirm"))
  await expectNoOverflow(page, "member-remove")
})

test("场景g4：选中会话计算样式（jade9% tint + inset 左缘 accent）", async ({ page }) => {
  await openGroupChat(page)
  // fixture active 会话 = 群「发布协调群」，其列表行藏于默认折叠的「群聊」分组内。
  const toggle = page.getByTestId("group-section-toggle")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // 展开后，active 行可见。
  const activeRow = page.locator('[data-testid="conversation-item"][data-active="true"]')
  await expect(activeRow).toBeVisible()
  // 计算样式断言（沿 e/f 走 evaluate + 窄化作用域）。
  // 算式来自 styles.css：
  //   .conversation-item[data-active="true"] {
  //     background: color-mix(in srgb, var(--color-jade) 9%, var(--color-raised)); // tint
  //     box-shadow: inset var(--line-signal) 0 0 0 var(--color-jade);              // inset 左缘 accent
  //   }
  //  对照：data-kind="shout" 行也含 inset（见 .conversation-item[data-kind="shout"]），
  //  故故意排除 shout 行，只择普通 DM/flat 行作对照。
  const styles = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> }
      getComputedStyle(element: { getAttribute(name: string): string | null }): {
        backgroundColor: string
        boxShadow: string
        display: string
        visibility: string
      }
    }
    type Sample = { backgroundColor: string; boxShadow: string }
    const items = scope.document.querySelectorAll('[data-testid="conversation-item"]')
    let active: Sample | null = null
    let control: Sample | null = null
    for (let index = 0; index < items.length; index += 1) {
      const element = items[index]
      if (element === undefined) continue
      const style = scope.getComputedStyle(element)
      if (style.display === "none" || style.visibility === "hidden") continue
      const isActive = element.getAttribute("data-active") === "true"
      const isShout = element.getAttribute("data-kind") === "shout"
      if (isActive) active = { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow }
      else if (!isShout && control === null)
        control = { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow }
    }
    return { active, control }
  })
  if (styles.active === null) throw new Error("data-active conversation-item 不可见/缺失")
  // 选中态：box-shadow 含 inset（左缘 accent）；background 非纯白（jade9% tint）。
  expect(styles.active.boxShadow).toContain("inset")
  expect(styles.active.backgroundColor).not.toBe("rgb(255, 255, 255)")
  // 对照：普通行不含 inset，且 background 与选中行不同。
  if (styles.control !== null) {
    expect(styles.control.boxShadow).not.toContain("inset")
    expect(styles.control.backgroundColor).not.toBe(styles.active.backgroundColor)
  }
  await shot(page, "g4-active-conversation", "list", page.getByTestId("middle-list"))
  await shot(page, "g4-active-conversation", "active", activeRow)
  await expectNoOverflow(page, "g4-active-conversation")
})
