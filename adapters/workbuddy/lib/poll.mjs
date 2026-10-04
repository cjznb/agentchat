/**
 * 有界轮询器：**无重叠执行**、失败指数退避、到点即停。
 *
 * 用途：WorkBuddy 的 hook 是**一次性进程**，没有任何"常驻推送"通道。完备的空闲期唤醒依赖
 * 宿主内建会话级 cron（`CronCreate`，见 README §空闲期唤醒）；本模块提供的是**兜底**：
 * 在 Stop 交还控制权前，用一段**有界**窗口把刚到达的消息也捞走（`AGENTCHAT_STOP_LONGPOLL_MS`，
 * 默认 0 = 关闭）。代价是宿主在"刚结束一轮"后多等这段窗口 —— 属 UX 取舍，故默认关闭。
 *
 * 时间源可注入（`now` / `sleep`），使单测确定。
 */
import { sleep as defaultSleep } from "./util.mjs"

/**
 * 反复调用 `probe()` 直到它返回**真值**或超过 `timeoutMs`。
 * - `probe` 抛错/返回假值 → 按退避增大间隔（`intervalMs` ×2^n，上限 `maxIntervalMs`），**不中断**；
 * - 返回 `undefined` 表示窗口内没有结果（调用方按"无件"处理，绝不阻塞宿主）。
 */
export async function pollUntil(options) {
  const timeoutMs = options.timeoutMs
  if (!(timeoutMs > 0)) return undefined
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const intervalMs = Math.max(1, options.intervalMs ?? 1000)
  const maxIntervalMs = Math.max(intervalMs, options.maxIntervalMs ?? 5000)
  const deadline = now() + timeoutMs
  let interval = intervalMs
  for (;;) {
    const value = await probeSafely(options)
    if (value !== undefined && value !== false && value !== null) return value
    if (now() >= deadline) return undefined
    await sleep(Math.min(interval, Math.max(0, deadline - now())))
    interval = Math.min(maxIntervalMs, interval * 2)
  }
}

async function probeSafely(options) {
  try {
    return await options.probe()
  } catch (error) {
    if (options.onError !== undefined) options.onError(error)
    return undefined
  }
}
