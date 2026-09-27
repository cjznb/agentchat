import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createApp } from "../../server/index"

describe("Hub static hosting", () => {
  let distDir = ""

  afterEach(() => {
    if (distDir !== "") rmSync(distDir, { recursive: true, force: true })
    distDir = ""
  })

  function createDist(): string {
    distDir = mkdtempSync(join(tmpdir(), "agentchat-static-"))
    mkdirSync(join(distDir, "assets"))
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>AgentChat shell</title>")
    writeFileSync(join(distDir, "assets", "app.js"), "console.log('shell')")
    return distDir
  }

  it("serves the built index and asset when dist exists", async () => {
    const app = createApp(undefined, { distDir: createDist() })

    const indexResponse = await app.request("/")
    const assetResponse = await app.request("/assets/app.js")

    expect(indexResponse.status).toBe(200)
    expect(await indexResponse.text()).toContain("AgentChat shell")
    expect(assetResponse.status).toBe(200)
    expect(await assetResponse.text()).toContain("shell")
  })

  it("falls back to index for a non-asset frontend route", async () => {
    const app = createApp(undefined, { distDir: createDist() })

    const response = await app.request("/notifications")

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("AgentChat shell")
  })

  it("does not swallow protected backend prefixes", async () => {
    const app = createApp(undefined, { distDir: createDist() })

    const responses = await Promise.all([
      app.request("/api/not-a-route"),
      app.request("/mcp/not-a-route"),
      app.request("/internal/not-a-route"),
    ])

    expect(responses.map((response) => response.status)).toEqual([404, 404, 401])
  })

  it("returns a clear 503 when the distribution is missing", async () => {
    distDir = join(mkdtempSync(join(tmpdir(), "agentchat-static-missing-")), "dist")
    const app = createApp(undefined, { distDir })

    const response = await app.request("/")

    expect(response.status).toBe(503)
    expect(await response.text()).toContain("npm run build")
  })
})
