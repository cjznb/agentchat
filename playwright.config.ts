import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:4646", trace: "retain-on-failure" },
  webServer: {
    // 自举：干净检出上 `npx playwright test` 直接可用 —— 先构建客户端（`start` 从 `client/dist`
    // 托管静态页），再拉起生产入口（HTTP + dispatcher）。
    command: "npm run build && npm start",
    url: "http://127.0.0.1:4646/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
