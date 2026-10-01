/**
 * 注入消息工厂：优先用宿主自带的 `createUserMessage`（`@deepseek-ai/dsh-llm`），拿不到再退化为
 * 最小 UserMessage（`{id, role, content, source}`）——退化件实测可正常投递，只是少了宿主侧的
 * 冻结 / 身份语义，故**绝不因它失败而放弃唤醒**。
 *
 * 为什么需要兜底路径（真机日志已证实）：本 bundle 常以**目录联接**安装
 * （`~/.dsh/profiles/node_modules/@agentchat/dsh-adapter` → 仓库目录）。Node 的 ESM 解析按导入
 * 文件的**真实路径**（仓库所在盘）逐级向上找 `node_modules`，因此看不到 DSH profile 的扁平模块农场，
 * 裸包名 `@deepseek-ai/dsh-llm` 必然解析失败。故再按
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js` 的**绝对文件路径**试一次——
 * 该文件的自身依赖由它自己的真实路径解析，不受联接影响。
 */
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * 注入消息来源：语义 = 另一个 agent 发来的消息（**生产者自有** kind + `ContextForm: 'relay'`）。
 *
 * **必须是 `plugin:agentchat`，不能写成 `{kind:'plugin', plugin:'agentchat'}`**：后者是会话格式 v3 时代的包装，
 * v4 明确**拒绝**它——`dsh-session-format-v3-to-v4` 的准入校验是
 * `… || value.kind === "plugin" → SessionFormatError("format v4 message requires a producer-owned source kind")`，
 * 真机表现是注入后整轮「处理失败」。官方 v3→v4 迁移同表把旧包装重写为
 * `producerKind(plugin, role)`：已知首方插件查表，**未知插件 = `plugin:<名字>`**（本适配器即 `plugin:agentchat`），
 * 其余字段（如 `form`）原样保留——所以这里就是官方迁移的等价写法。
 */
export const MESSAGE_SOURCE = { kind: "plugin:agentchat", form: "relay" }

/**
 * 候选解析目标（按序尝试）：裸包名（bundle 被装进 profile 自己的 `node_modules` 时可命中）→
 * profile 扁平模块农场的绝对文件路径（联接安装时的实际可用路径）。
 *
 * @param {Readonly<Record<string, string | undefined>>} env `process.env`
 * @returns {string[]} import 说明符（第二个是 file:// URL）
 */
export function messageFactoryCandidates(env) {
  const configured = env["DSH_HOME"]
  const dshHome = configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh")
  return [
    "@deepseek-ai/dsh-llm",
    pathToFileURL(join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")).href,
  ]
}

/**
 * 建 `(text) => Promise<UserMessage>`：工厂解析**只尝试一次**并缓存结果（首次注入时才解析，
 * 避免加载期副作用）。任何失败都只记一条日志，之后恒走最小 UserMessage。
 *
 * @param {Readonly<Record<string, string | undefined>>} env `process.env`
 * @param {(message: string) => void} log 诊断（写文件日志，绝不写 stdout）
 * @returns {(text: string) => Promise<Record<string, unknown>>}
 */
export function createMessageBuilder(env, log) {
  /** 已解析的 `createUserMessage`；`undefined` = 尚未解析或解析失败（由 `resolved` 区分）。 */
  let factory
  let resolved = false
  return async (text) => {
    if (!resolved) {
      resolved = true
      for (const specifier of messageFactoryCandidates(env)) {
        try {
          const mod = await import(specifier)
          if (typeof mod["createUserMessage"] === "function") {
            factory = mod["createUserMessage"]
            log(`注入消息工厂已解析：${specifier}`)
            break
          }
        } catch {
          // 候选不可用：试下一个。逐条记失败原因只会刷屏，最终兜底会记一条。
        }
      }
      if (factory === undefined) log("宿主 createUserMessage 不可用，退化为最小 UserMessage（不影响投递）")
    }
    if (factory !== undefined) return factory({ content: [{ type: "text", text }], source: MESSAGE_SOURCE })
    return { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: MESSAGE_SOURCE }
  }
}
