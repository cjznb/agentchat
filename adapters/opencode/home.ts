/**
 * 数据目录解析（`AGENTCHAT_HOME`，空串视同未设 → `~/.agentchat`，与 Hub 一致）。
 *
 * 独立成模块：`token.ts`（读盘 + 读失败日志）与 `log.ts`（文件日志）**都**需要它；若仍放在
 * `token.ts` 里而 `token.ts` 又要引 `log.ts` 做失败日志，即形成 `token ↔ log` 循环依赖。
 * 居中抽出本模块后依赖图为 `token → {log, home}`、`log → home`，无环。
 */
import { homedir } from "node:os"
import { join } from "node:path"

export function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}
