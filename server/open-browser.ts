/**
 * 启动后自动打开浏览器（默认「交互式才开」）——决策与副作用分离，便于单测。
 *
 * - `browserCommand(ctx)`：**纯函数**。输入平台 + URL + 两个守卫结果，返回要执行的
 *   命令与参数，或 `undefined`（守卫拦截）。
 * - `openBrowser(command, warn?)`：**副作用**。`detached + stdio:ignore + unref` 拉起，
 *   **任何失败只 warn 一次、绝不影响/阻塞 Hub**。
 *
 * 触发点仅在 `server/main.ts` 的真实执行入口（`runForeground`），**不在 `bootstrap()` 内**，
 * 以免测试走到弹窗路径。
 */
import { spawn } from "node:child_process"

export interface BrowserCommand {
  readonly command: string
  readonly args: readonly string[]
}

export interface OpenBrowserContext {
  /** `process.platform`。 */
  readonly platform: NodeJS.Platform
  /** 要打开的地址（Hub 实际监听地址）。 */
  readonly url: string
  /** 守卫：`config.openBrowser`（env `AGENTCHAT_NO_OPEN` / CLI `--no-open` 已折入）。 */
  readonly openBrowser: boolean
  /** 守卫：`process.stdout.isTTY === true`（CI / 管道 / 脚本 → 不开）。 */
  readonly isTTY: boolean
}

/**
 * 决策：默认交互式且未被显式关闭 → 返回平台命令；任一守卫拦截 → `undefined`。
 * - `win32`：`cmd /c start "" <url>`（`start` 会把首个带引号参数当窗口标题，必须传空标题）。
 * - `darwin`：`open <url>`；其它：`xdg-open <url>`。
 */
export function browserCommand(ctx: OpenBrowserContext): BrowserCommand | undefined {
  if (!ctx.openBrowser || !ctx.isTTY) return undefined
  if (ctx.platform === "win32") return { command: "cmd", args: ["/c", "start", "", ctx.url] }
  if (ctx.platform === "darwin") return { command: "open", args: [ctx.url] }
  return { command: "xdg-open", args: [ctx.url] }
}

/**
 * 拉起浏览器：后台分离进程，失败仅 warn 一次，不抛出、不阻塞。`warn` 可注入（测试收集）。
 */
export function openBrowser(
  command: BrowserCommand,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  try {
    const child = spawn(command.command, [...command.args], { detached: true, stdio: "ignore" })
    child.once("error", (error: Error) => {
      warn(`[agentchat] 自动打开浏览器失败：${error.message}（不影响 Hub 运行）`)
    })
    child.unref()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`[agentchat] 自动打开浏览器失败：${message}（不影响 Hub 运行）`)
  }
}
