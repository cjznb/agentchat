import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:4646", trace: "retain-on-failure" },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4646/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
