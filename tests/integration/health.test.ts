import { afterEach, describe, expect, it } from "vitest"
import { start, type RunningServer } from "../../server/index"

describe("GET /api/health", () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it("returns {status:'ok'} with HTTP 200 when the server is started", async () => {
    running = await start({ port: 0 })

    const res = await fetch(`${running.url}/api/health`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})
