/**
 * OpenCode 适配器**文件日志**（`mcp-bridge.mjs` 专用）：与 `log.ts` **同构**的极小纯 `.mjs` 实现
 * ——桥是被 OpenCode 直接 spawn 的纯 `.mjs`，不能 import TS，故在此复制同一语义：
 *
 * - 目标 `<AGENTCHAT_HOME>/logs/opencode-adapter.log`（空串视同未设，默认 `~/.agentchat`）；
 * - 行格式 `<ISO 时间> [tag] <message>\n`；追加写 + `mkdir -p`；**任何异常静默**；
 * - 写入前 > 1 MiB → 改名 `<文件>.1`（覆盖旧 `.1`，只保留一份）；
 * - `AGENTCHAT_LOG=console` → 改打 stderr（调试回退，默认关闭）；
 * - **绝不写 stdout**（桥的 stdout 恒为 JSON-RPC 帧）；日志行绝不含 token 值。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const LOG_ROTATE_BYTES = 1024 * 1024

function resolveHome(env) {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}

/** 建日志写入函数（tag 如 `bridge`）；与 `log.ts:createFileLog` 行为一致。 */
export function createFileLog(env, tag) {
  if (env["AGENTCHAT_LOG"] === "console") {
    return (message) => process.stderr.write(`${new Date().toISOString()} [${tag}] ${message}\n`)
  }
  const path = join(resolveHome(env), "logs", "opencode-adapter.log")
  return (message) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try {
        const stat = statSync(path, { throwIfNoEntry: false })
        if (stat !== undefined && stat.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`)
      } catch {
        // 轮转失败（文件被占用等）不阻断本次追加
      }
      appendFileSync(path, `${new Date().toISOString()} [${tag}] ${message}\n`)
    } catch {
      // 静默：日志失败绝不影响宿主，也绝不写 stdout
    }
  }
}
