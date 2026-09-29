/**
 * Plan 3 T9 —— 四级回执**全链** E2E（真 Hub + 真 dispatcher + 进程内可阻塞适配器）：
 * `queued（排队中）→ sending（唤醒中）→ delivered（已送达）→ read（已读）` 四态在己方气泡上逐级点亮。
 *
 * 现有 chat-view 用例覆盖 `queued → read` 的跳变；本用例用真 `Dispatcher` + 可阻塞 `VendorAdapter`
 * 把中间两态（`sending`/`delivered`）稳定观测出来，补齐 spec §6.3 的四级变色矩阵。
 *
 * 前置：webServer 已含 `npm run build`（见 playwright.config.ts）。
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  clearAdapters,
  registerAdapter,
  type AdapterInjectResult,
  type AdapterState,
  type VendorAdapter,
} from "../../server/adapters/types"
import { Dispatcher } from "../../server/core/dispatcher"
import { ack, sendMessage } from "../../server/core/messaging"
import { start } from "../../server/index"
import { resetWsHub } from "../../server/ws"
import { seedBase } from "./seed"

/**
 * 可阻塞假适配器：`inject` 挂起至测试放行，令 `sending` 态可稳定观测。
 * 放行语义：`settle()` 置 `released` 并 flush 已排队的 resolver；此后（含两阶段派发中
 * 排在其后的 job 的）`inject` 一律立即 resolve —— 「放行注入 → delivered」对全部注入生效。
 */
class GatedAdapter implements VendorAdapter {
  readonly id = "opencode" as const
  private released: AdapterInjectResult | undefined
  private resolvers: ((result: AdapterInjectResult) => void)[] = []

  start(): void {}
  reportState(_nodeId: string, _state: AdapterState): void {}
  inject(): Promise<AdapterInjectResult> {
    if (this.released !== undefined) return Promise.resolve(this.released)
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  /** 测试放行注入（`delivered`/`refused`）：解锁已排队的注入，其后注入立即完成。 */
  settle(result: AdapterInjectResult): void {
    this.released = result
    for (const resolve of this.resolvers.splice(0)) resolve(result)
  }
}

test("lights up queued → sending → delivered → read on the sender's own bubble", async ({ page }) => {
  resetWsHub()
  const seeded = seedBase("agentchat-receipts-e2e-")
  const adapter = new GatedAdapter()
  registerAdapter(adapter) // push 适配器按 vendor 匹配（建 job 不再依赖注册时机，seed 消息同样有 job）
  const dispatcher = new Dispatcher({ db: seeded.db, home: seeded.home })
  const running = await start({
    port: 0,
    db: seeded.db,
    home: seeded.home,
    hubTokenPath: join(seeded.home, "hub_token"),
  })
  try {
    const sent = sendMessage(seeded.db, { from: seeded.humanId, to: seeded.rootId, body: "receipt-chain" })
    const messageId = sent.message.id

    await page.goto(`${running.url}/`)
    await page.getByTestId("conversation-item").first().click()

    const receipt = page.locator(`[data-message-id="${messageId}"]`).getByTestId("receipt")
    await expect(receipt).toHaveAttribute("data-stage", "queued")
    await expect(receipt).toContainText("排队中")

    // 真 dispatcher 认领 job → `sending`；`inject` 挂起，态稳定。
    void dispatcher.tick(Date.now() + 1000)
    await expect.poll(async () => receipt.getAttribute("data-stage"), { timeout: 3000 }).toBe("sending")
    await expect(receipt).toContainText("唤醒中")

    // 放行注入 → `delivered`。
    adapter.settle("delivered")
    await expect.poll(async () => receipt.getAttribute("data-stage"), { timeout: 3000 }).toBe("delivered")
    await expect(receipt).toContainText("已送达")

    // 收件方 ack → `read`（终态品牌绿）。
    expect(ack(seeded.db, seeded.rootId, [messageId])).toBe(1)
    await expect.poll(async () => receipt.getAttribute("data-stage"), { timeout: 3000 }).toBe("read")
    await expect(receipt).toContainText("已读")
  } finally {
    clearAdapters()
    await page.close()
    resetWsHub()
    await running.close()
    seeded.db.close()
    rmSync(seeded.home, { recursive: true, force: true })
  }
})
