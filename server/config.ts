/**
 * 端口、路径与本地配置（spec/计划锁定值的唯一来源）。
 *
 * 优先级：**env > `<home>/config.json` > 默认**。`home` 由 `AGENTCHAT_HOME`（空串视同未设，
 * 默认 `~/.agentchat`）决定——配置文件的解析**不依赖该文件自身**。
 * - port：env `AGENTCHAT_PORT` → 文件 `port` → `DEFAULT_PORT`
 * - 厂商：env `AGENTCHAT_ADAPTERS`（逗号分隔）→ 文件 `adapters` → `[]`
 * - openBrowser：env `AGENTCHAT_NO_OPEN`（`1`/`true` = 关）→ env `AGENTCHAT_OPEN`（`1`/`true` = 开、
 *   `0`/`false` = 关）→ 文件 `openBrowser` → `DEFAULT_OPEN_BROWSER`
 * - DB = `<home>/agentchat.db`；HUB_TOKEN = `<home>/hub_token`；配置文件 = `<home>/config.json`
 *
 * **只读**：Hub **不**创建 `config.json`（由安装器/CLI 写）；文件缺失用默认、不报错，
 * JSON 非法或键类型错 → 一条清晰 warn + 用默认，**绝不崩**。
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

export const DEFAULT_PORT = 4646
export const DEFAULT_OPEN_BROWSER = true
/** 本地配置文件名（相对 `home`）。 */
export const CONFIG_FILE_NAME = "config.json"

const portSchema = z.coerce.number().int().min(0).max(65535)

/** 文件内取值必须是正确类型（字符串端口 = 类型错 → 走默认并 warn，不做静默强转）。 */
const fileSchema = z.object({
  adapters: z.array(z.string()).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  openBrowser: z.boolean().optional(),
})

/** 厂商 id 规范化：trim、过滤空项、去重（保留首次出现顺序）。 */
function normalizeAdapters(values: readonly string[]): string[] {
  return [...new Set(values.map((part) => part.trim()).filter((part) => part !== ""))]
}

/** env `AGENTCHAT_ADAPTERS`（逗号分隔）→ 列表；未设 = `undefined`（交由文件/默认）。 */
const adaptersEnvSchema = z
  .string()
  .optional()
  .transform((raw) => (raw === undefined ? undefined : normalizeAdapters(raw.split(","))))

/** env 文本：空串视同未设（`AGENTCHAT_HOME`/`AGENTCHAT_PORT` 等）。 */
function envText(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const raw = env[key]
  return raw !== undefined && raw !== "" ? raw : undefined
}

/** env 布尔解析：`1`/`true`（大小写不敏感）为真、`0`/`false` 为假；其它/未设 = `undefined`。 */
function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  return undefined
}

export interface HubConfig {
  readonly port: number
  readonly home: string
  readonly dbPath: string
  readonly hubTokenPath: string
  /** `<home>/config.json`（Hub 只读，不创建）。 */
  readonly configPath: string
  /** 已配置厂商（进程外 pull 适配器的占位注册来源）。 */
  readonly adapters: readonly string[]
  /** 启动后是否自动打开浏览器（供 CLI/启动器消费）。 */
  readonly openBrowser: boolean
}

export type ConfigWarn = (message: string) => void

/** home 解析：`AGENTCHAT_HOME` 非空优先，空串视同未设 → `~/.agentchat`。 */
function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  return envText(env, "AGENTCHAT_HOME") ?? join(homedir(), ".agentchat")
}

interface FileConfig {
  readonly adapters?: readonly string[]
  readonly port?: number
  readonly openBrowser?: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读取 `<home>/config.json`（只读）：缺失 → `{}`；读取失败/JSON 非法/键类型错 →
 * 一条清晰 warn 后按 `{}`（默认）。
 */
function readConfigFile(path: string, warn: ConfigWarn): FileConfig {
  if (!existsSync(path)) return {}
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    warn(`[agentchat] 读取配置文件失败（${path}）：${errorText(error)}；按默认配置继续。`)
    return {}
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    warn(`[agentchat] 配置文件不是合法 JSON（${path}）：${errorText(error)}；按默认配置继续。`)
    return {}
  }
  const parsed = fileSchema.safeParse(json)
  if (!parsed.success) {
    warn(`[agentchat] 配置文件键类型错误（${path}）：${parsed.error.message}；按默认配置继续。`)
    return {}
  }
  return {
    ...(parsed.data.adapters === undefined ? {} : { adapters: normalizeAdapters(parsed.data.adapters) }),
    ...(parsed.data.port === undefined ? {} : { port: parsed.data.port }),
    ...(parsed.data.openBrowser === undefined ? {} : { openBrowser: parsed.data.openBrowser }),
  }
}

/**
 * 从环境变量 + `<home>/config.json` 解析配置（env > 文件 > 默认）。
 * `warn` 可注入（测试收集；缺省 `console.warn`）。配置文件**只读**，绝不创建。
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: ConfigWarn = (message) => console.warn(message),
): HubConfig {
  const home = resolveHome(env)
  const configPath = join(home, CONFIG_FILE_NAME)
  const file = readConfigFile(configPath, warn)
  const port = portSchema.parse(envText(env, "AGENTCHAT_PORT") ?? file.port ?? DEFAULT_PORT)
  const envAdapters = adaptersEnvSchema.parse(env["AGENTCHAT_ADAPTERS"])
  const adapters = envAdapters ?? file.adapters ?? []
  const noOpen = envFlag(envText(env, "AGENTCHAT_NO_OPEN"))
  const openFlag = envFlag(envText(env, "AGENTCHAT_OPEN"))
  const openBrowser = noOpen === true ? false : openFlag ?? file.openBrowser ?? DEFAULT_OPEN_BROWSER
  return {
    port,
    home,
    dbPath: join(home, "agentchat.db"),
    hubTokenPath: join(home, "hub_token"),
    configPath,
    adapters,
    openBrowser,
  }
}

/** 进程默认配置（import 时按当前环境解析）。测试覆盖请用 `loadConfig(customEnv)`。 */
export const config: HubConfig = loadConfig()
