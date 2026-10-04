/**
 * 每个 hook 进程的公共引导：解析数据目录、Hub 配置、stdin 载荷，并给出绑定 tag 的日志器。
 *
 * 各 hook 脚本都只做"读 context → 调 lib → 写 stdout"，把差异留在 lib 层（便于单测）。
 */
import { hubConfig } from "./hub.mjs"
import { hookInput, readStdinJson } from "./hook-io.mjs"
import { createLogger } from "./log.mjs"
import { adapterPaths, resolveHome } from "./paths.mjs"

/**
 * 加载 hook 运行上下文。
 * `AGENTCHAT_LOG=console` 时额外把诊断镜像到 **stderr**（stdout 永远留给宿主协议）。
 */
export async function loadContext() {
  const home = resolveHome(process.env)
  const paths = adapterPaths(home)
  const config = hubConfig(process.env, home)
  const input = await readStdinJson()
  const { sessionId, cwd, event } = hookInput(input)
  const base = createLogger(home, event ?? "hook")
  const log = (message) => {
    base(message)
    if (process.env["AGENTCHAT_LOG"] === "console") process.stderr.write(`[agentchat] ${message}\n`)
  }
  return { home, paths, config, input, sessionId, cwd, event, log }
}
