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
    // T7：让 `import css from "*.css?raw"` 返回真实文本（默认 css:false 时 ?raw 恒为空串）。
    css: true,
    // 全局隔离：把 AGENTCHAT_HOME 指向一次性临时目录（见 tests/setup/isolate-home.ts），
    // 避免开发机真实 ~/.agentchat/config.json 渗进用例，也避免用例触碰真实数据目录。
    setupFiles: ["./tests/setup/isolate-home.ts"],
    // 真实子进程用例（Claude hooks、OpenCode 桥、token 轮转）在负载下 node 冷启动 + IO 会明显变慢：
    // 已捕获一例 5028ms 越默认 5s 的失败（idle.test.ts 链式 Stop，7 次 spawn）。30s 只放宽"等待上限"，
    // 不放宽任何断言——真正的挂起仍会在 30s 失败。
    testTimeout: 30_000,
  },
})
