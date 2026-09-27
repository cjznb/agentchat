import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const clientRoot = fileURLToPath(new URL(".", import.meta.url))
const hubTarget = "http://localhost:4646"

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: hubTarget, ws: true },
      "/mcp": hubTarget,
      "/internal": hubTarget,
    },
  },
})
