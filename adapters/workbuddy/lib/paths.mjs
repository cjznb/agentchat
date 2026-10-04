/**
 * WorkBuddy 适配器落盘路径的**单一来源**。
 *
 * 数据目录口径与 Hub 及各适配器一致：`AGENTCHAT_HOME`（空串视同未设）→ 否则 `~/.agentchat`。
 * 前缀统一 `workbuddy.`，与 `opencode.` / `dsh.` / `claude-code.` 并列，互不覆盖。
 */
import { homedir } from "node:os"
import { join } from "node:path"

/** 本适配器厂商 id（Hub `config.json` 的 `adapters` 项、节点 `vendor` 字段）。 */
export const VENDOR = "workbuddy"

/** Hub 数据目录：`AGENTCHAT_HOME`（非空）否则 `~/.agentchat`。 */
export function resolveHome(env) {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}

/**
 * 本适配器全部落盘路径：
 * - `token`    — 实例节点 `join_token`（重连认领用，0600）
 * - `agentId`  — 实例（容器）节点 id，供桥作**出站身份兜底**
 * - `instance` — 实例名后缀（仅在 `workbuddy@<host>` 撞名时生成并持久化，见 `register.mjs`）
 * - `root`     — 最近一次 SessionStart 的实例上下文（`session_id` + pid，诊断用）
 * - `sessions` — 会话映射台账 `{ [sessionId]: { agentId, name, at } }`
 * - `stop`     — Stop 链内 block 计数（防注入自激）
 * - `seen`     — 已注入 `messageId` 去重集合（有界）
 * - `log`      — 适配器日志（1 MiB 轮转；**绝不写宿主 stdout**）
 */
export function adapterPaths(home) {
  const agents = join(home, "agents")
  return {
    home,
    token: join(agents, "workbuddy.token"),
    agentId: join(agents, "workbuddy.id"),
    instance: join(agents, "workbuddy.instance"),
    root: join(agents, "workbuddy.root.json"),
    sessions: join(agents, "workbuddy.sessions.json"),
    stop: join(agents, "workbuddy.stop.json"),
    seen: join(agents, "workbuddy.seen.json"),
    log: join(home, "logs", "workbuddy-adapter.log"),
  }
}

/** 从落盘路径反推数据目录（`<home>/agents/x` → `<home>`），供日志在无 home 时兜底。 */
export function homeForPath(path) {
  const parts = path.replace(/\\/g, "/").split("/")
  parts.pop()
  return parts[parts.length - 1] === "agents" ? parts.slice(0, -1).join("/") : parts.join("/")
}
