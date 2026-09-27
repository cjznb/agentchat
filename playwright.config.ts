import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "@playwright/test"

// 4646 上的自举 hub 必须落在**隔离的临时 AGENTCHAT_HOME**，绝不可触碰真实 ~/.agentchat
//（真实库写入、dispatcher 备份/清扫都会污染开发数据）。
//
// 注意：本配置文件会被**主进程与每个 worker 分别加载**。仅在主进程（`TEST_WORKER_INDEX`
// 未设）清空重建一次——worker 加载时自举 hub 已在运行并持有该目录下的 SQLite 文件，
// 此时 rmSync 在 Windows 上会 EPERM。
const hubHome = join(tmpdir(), "agentchat-e2e-hub")
if (process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(hubHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(hubHome, { recursive: true })
}

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
    env: { AGENTCHAT_HOME: hubHome },
  },
})
