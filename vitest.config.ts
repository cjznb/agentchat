import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "client/**/*.test.ts", "client/**/*.test.tsx"],
    environment: "node",
  },
})
