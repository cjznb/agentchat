import { expect, test } from "@playwright/test"

test("shows three shell columns and switches the working view", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByTestId("app-shell")).toBeVisible()
  await expect(page.getByTestId("icon-rail")).toBeVisible()
  await expect(page.getByTestId("middle-list")).toBeVisible()
  await expect(page.getByTestId("right-view")).toBeVisible()
  await expect(page.getByRole("button", { name: "聊天" })).toBeVisible()
  await expect(page.getByRole("button", { name: "通讯录" })).toBeVisible()
  await expect(page.getByRole("button", { name: "喊话" })).toBeVisible()

  await page.getByRole("button", { name: "通讯录" }).click()
  await expect(page.getByRole("heading", { name: "Agent 树", level: 1 })).toBeVisible()

  await page.getByRole("button", { name: "喊话" }).click()
  await expect(page.getByRole("heading", { name: "全员喊话", level: 1 })).toBeVisible()
})

test("fits the compact shell inside a 375 by 800 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto("/")

  const shellHeight = await page.getByTestId("app-shell").evaluate((shell) => shell.getBoundingClientRect().height)
  const scrollHeight = await page.locator("html").evaluate((element) => element.scrollHeight)
  const targets = await page.getByRole("button").all()

  expect({ shellHeight, scrollHeight }).toEqual({ shellHeight: 800, scrollHeight: 800 })
  for (const target of targets) {
    const box = await target.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
})
