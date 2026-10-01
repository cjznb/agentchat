/**
 * DSH 适配器的**文件日志**：诊断/错误输出落 `<AGENTCHAT_HOME>/logs/dsh-adapter.log`，
 * **绝不写宿主终端**（DSH 的 stderr 即用户界面的一部分；终端界面软件皆然）。
 *
 * 语义与 `adapters/opencode/log.ts` 逐条对齐：
 * - 行格式：`<ISO 时间> [<tag>] <message>\n`（本适配器 tag 为 `plugin`）。
 * - **追加写**；目录 `mkdir -p`；**任何异常一律静默**——日志失败绝不影响宿主（首要语义）。
 * - **轮转**：写入前文件已 > 阈值（默认 1 MiB，可注入便于测试）→ 整体改名 `<文件>.1`
 *   （覆盖旧 `.1`，只保留一份），主文件从新行重新开始。
 * - **绝不写入密钥**：任何日志行都不得含 `hub_token` / `join_token` 的**值**（只可出现变量名或路径）。
 * - 调试回退（默认关闭）：`AGENTCHAT_LOG=console` 时改打 stderr（现场排障用）。
 *
 * 路径在构造时解析，目录与文件**惰性**创建（仅首次写入触盘：宿主加载插件模块本身不碰文件系统）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveHome } from "./home.js"

/** 默认轮转阈值：1 MiB。 */
export const DEFAULT_ROTATE_BYTES = 1024 * 1024

/** 本适配器的文件名（`<home>/logs/dsh-adapter.log`）。 */
export const LOG_FILE_NAME = "dsh-adapter.log"

/**
 * 建日志写入函数。
 *
 * @param {Readonly<Record<string, string | undefined>>} env 环境（`AGENTCHAT_HOME` / `AGENTCHAT_LOG`）
 * @param {string} scope 行内 tag（如 `plugin`）
 * @param {number} [rotateBytes] 轮转阈值（默认 1 MiB；单测注入小值）
 * @returns {(message: string) => void} 写入函数（**永不抛错**、永不写 stdout）
 */
export function createFileLog(env, scope, rotateBytes = DEFAULT_ROTATE_BYTES) {
  if (env["AGENTCHAT_LOG"] === "console") {
    return (message) => {
      console.error(`${new Date().toISOString()} [${scope}] ${message}`)
    }
  }
  const path = join(resolveHome(env), "logs", LOG_FILE_NAME)
  return (message) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try {
        const stat = statSync(path, { throwIfNoEntry: false })
        if (stat !== undefined && stat.size > rotateBytes) renameSync(path, `${path}.1`)
      } catch {
        // 轮转失败（文件被占用等）不阻断本次追加
      }
      appendFileSync(path, `${new Date().toISOString()} [${scope}] ${message}\n`)
    } catch {
      // 静默是首要语义：日志失败绝不影响宿主
    }
  }
}
