import { defineConfig } from "@playwright/test"

/**
 * 三层 UI 视觉测试仪器 —— 层1（确定性溢出断言）+ 层2（区域截图产图）配置。
 *
 * 与根 `playwright.config.ts`（E2E，需 Hub）完全隔离：
 * - `testDir: tests/visual`，`testMatch 全部 .spec.ts` —— 与 vitest 的
 *   `tests 下全部 .test.ts` include 天然不冲突（不改 vitest 配置）。
 * - 数据全靠 spec 内 `page.route 拦截 /api/** 路由` 拦截 mock，**不启动任何 Hub 进程**、
 *   不 import 任何 server 代码（绝对隔离红线：本配置及全部 visual 文件不含 Hub 端口）。
 * - webServer 只做「先 build 再 vite preview」静态托管 `client/dist`。
 */
export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command:
      "npm run build && node node_modules/vite/bin/vite.js preview --config client/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
