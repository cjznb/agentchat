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
  },
})
