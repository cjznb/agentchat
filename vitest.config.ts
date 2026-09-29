import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "adapters/**/__tests__/**/*.test.ts",
      "client/**/*.test.ts",
      "client/**/*.test.tsx",
    ],
    environment: "node",
    // 真实子进程用例（Claude hooks、OpenCode 桥、token 轮转）在负载下 node 冷启动 + IO 会明显变慢：
    // 已捕获一例 5028ms 越默认 5s 的失败（idle.test.ts 链式 Stop，7 次 spawn）。30s 只放宽"等待上限"，
    // 不放宽任何断言——真正的挂起仍会在 30s 失败。
    testTimeout: 30_000,
  },
})
