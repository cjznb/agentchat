/**
 * OpenCode 适配器的**文件日志**：诊断/错误输出落 `<AGENTCHAT_HOME>/logs/opencode-adapter.log`，
 * **绝不写宿主终端**（宿主的 stderr 即其界面终端——OpenCode 及其它终端界面软件都如此）。
 *
 * - 行格式：`<ISO 时间> [tag] <message>\n`（tag：`plugin`；桥的同构实现在 `file-log.mjs`，tag `bridge`）。
 * - **追加写**；目录 `mkdir -p`；**任何异常一律静默**——日志失败绝不影响宿主（首要语义）。
 * - **轮转**：写入前文件已 > 阈值（默认 1 MiB，可注入便于测试）→ 整体改名 `<文件>.1`
 *   （覆盖旧 `.1`，只保留一份），主文件从新行重新开始。
 * - **绝不写入密钥**：任何日志行都不得含 `hub_token` / `join_token` 的**值**（只可出现变量名或路径）。
 * - 调试回退（默认关闭）：`AGENTCHAT_LOG=console` 时改打 stderr（现场排障用）。
 *
 * 与 `token.ts:resolveHome` 同语义：`AGENTCHAT_HOME` 空串视同未设，默认 `~/.agentchat`。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveHome } from "./token"

/** 默认轮转阈值：1 MiB。 */
export const DEFAULT_ROTATE_BYTES = 1024 * 1024

/**
 * 建日志写入函数（tag 如 `plugin`）。路径在构造时解析；目录与文件**惰性**创建
 * （仅首次写入触盘，宿主加载插件模块本身不碰文件系统）。
 */
export function createFileLog(
  env: Readonly<Record<string, string | undefined>>,
  tag: string,
  rotateBytes: number = DEFAULT_ROTATE_BYTES,
): (message: string) => void {
  if (env["AGENTCHAT_LOG"] === "console") {
    return (message) => {
      console.error(`${new Date().toISOString()} [${tag}] ${message}`)
    }
  }
  const path = join(resolveHome(env), "logs", "opencode-adapter.log")
  return (message) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try {
        const stat = statSync(path, { throwIfNoEntry: false })
        if (stat !== undefined && stat.size > rotateBytes) renameSync(path, `${path}.1`)
      } catch {} // no-excuse-ok: catch —— 轮转失败（文件被占用等）不阻断本次追加
      appendFileSync(path, `${new Date().toISOString()} [${tag}] ${message}\n`)
    } catch {} // no-excuse-ok: catch —— 静默是首要语义：日志失败绝不影响宿主
  }
}
