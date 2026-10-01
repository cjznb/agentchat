/**
 * DSH 适配器数据目录解析（与 OpenCode / Claude Code 适配器**同语义**）。
 *
 * `AGENTCHAT_HOME`（空串视同未设）→ 数据目录；缺省 `~/.agentchat`（与 Hub 一致）。
 * 单独成模块的原因与 `adapters/opencode/home.ts` 相同：`token.js`（读盘 + 读失败日志）
 * 与 `log.js`（文件日志）**都**需要它，居中抽出即可避免 `token ↔ log` 循环依赖。
 *
 * 纪律：本模块**不触盘、不抛错**，纯字符串运算。
 */
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 解析数据目录。
 *
 * @param {Readonly<Record<string, string | undefined>>} env 环境（至少含可选 `AGENTCHAT_HOME`）
 * @returns {string} 数据目录绝对/相对路径（空串与 `undefined` 均回落 `~/.agentchat`）
 */
export function resolveHome(env) {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}
