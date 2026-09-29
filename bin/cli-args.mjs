/**
 * `agentchat` CLI 的纯参数解析（无任何 IO）——供 `bin/agentchat.mjs` 编排使用，并被 vitest 直接导入。
 *
 * - `parseArgs(argv)`：把参数数组解析成结构化结果 + 校验错误列表（不打印、不退出）。
 * - `childEnv(parsed, base)`：把解析结果映射为子进程（Hub 入口）的环境变量覆盖。
 *   `--port`/`--home`/`--no-open` 分别落到 `AGENTCHAT_PORT`/`AGENTCHAT_HOME`/`AGENTCHAT_NO_OPEN`，
 *   由 `server/config.ts` 的「env > config.json > 默认」优先级统一消费。
 */

/**
 * @typedef {object} ParsedArgs
 * @property {number | undefined} port
 * @property {string | undefined} home
 * @property {boolean} noOpen
 * @property {boolean} build
 * @property {boolean} help
 * @property {boolean} version
 * @property {string[]} passthrough
 * @property {string[]} errors
 */

/**
 * @typedef {object} ChildEnvInput
 * @property {string | undefined} home
 * @property {number | undefined} port
 * @property {boolean} noOpen
 */

const PORT_MAX = 65535

export const HELP_TEXT = `agentchat —— 一行命令启动 AgentChat Hub

用法:
  agentchat [选项] [-- <透传给 Hub 入口的参数>]

选项:
  --port <n>      监听端口（等价 env AGENTCHAT_PORT，优先于 config.json）
  --home <dir>    数据目录（等价 env AGENTCHAT_HOME；默认 ~/.agentchat）
  --no-open       启动后不自动打开浏览器（等价 env AGENTCHAT_NO_OPEN=1）
  --build         启动前强制重建前端（默认仅在 client/dist 缺失时构建）
  -h, --help      显示本帮助
  -v, --version   显示版本
  --              其后的参数原样透传给 Hub 入口

示例:
  agentchat
  agentchat --port 5000 --home ./.data
  agentchat --no-open
`

/** 读取 `--flag value` / `--flag=value` 两种形式的取值。返回取值与下一个待处理下标。 */
function readOptionValue(argv, index, name, inline, errors) {
  if (inline !== undefined) {
    if (inline === "") errors.push(`选项 ${name} 缺少取值`)
    return { value: inline === "" ? undefined : inline, next: index + 1 }
  }
  const value = argv[index + 1]
  if (value === undefined) {
    errors.push(`选项 ${name} 缺少取值`)
    return { value: undefined, next: index + 1 }
  }
  return { value, next: index + 2 }
}

/** 校验端口：纯十进制整数、0..65535（0 = 交由 OS 分配临时端口）。 */
function validatePort(raw, errors) {
  if (!/^\d+$/.test(raw)) {
    errors.push(`端口必须是 0..${PORT_MAX} 的整数，收到：${raw}`)
    return undefined
  }
  const value = Number(raw)
  if (value > PORT_MAX) {
    errors.push(`端口必须是 0..${PORT_MAX} 的整数，收到：${raw}`)
    return undefined
  }
  return value
}

/**
 * 解析 CLI 参数（`process.argv.slice(2)`）。纯函数：不打印、不退出、不读环境。
 * `--` 之前无法识别的参数记为 `errors`，其后的全部原样进入 `passthrough`。
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const parsed = {
    port: undefined,
    home: undefined,
    noOpen: false,
    build: false,
    help: false,
    version: false,
    passthrough: [],
    errors: [],
  }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === "--") {
      parsed.passthrough.push(...argv.slice(index + 1))
      break
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      index += 1
      continue
    }
    if (arg === "--version" || arg === "-v") {
      parsed.version = true
      index += 1
      continue
    }
    if (arg === "--no-open") {
      parsed.noOpen = true
      index += 1
      continue
    }
    if (arg === "--build") {
      parsed.build = true
      index += 1
      continue
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const inline = arg === "--port" ? undefined : arg.slice("--port=".length)
      const { value, next } = readOptionValue(argv, index, "--port", inline, parsed.errors)
      if (value !== undefined) parsed.port = validatePort(value, parsed.errors)
      index = next
      continue
    }
    if (arg === "--home" || arg.startsWith("--home=")) {
      const inline = arg === "--home" ? undefined : arg.slice("--home=".length)
      const { value, next } = readOptionValue(argv, index, "--home", inline, parsed.errors)
      if (value !== undefined) parsed.home = value
      index = next
      continue
    }
    parsed.errors.push(`无法识别的参数：${arg}`)
    index += 1
  }
  return parsed
}

/**
 * 把解析结果映射为子进程环境变量覆盖（不改动传入的 base）。
 * @param {ChildEnvInput} parsed
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(parsed, base) {
  const env = { ...base }
  if (parsed.home !== undefined) env.AGENTCHAT_HOME = parsed.home
  if (parsed.port !== undefined) env.AGENTCHAT_PORT = String(parsed.port)
  if (parsed.noOpen) env.AGENTCHAT_NO_OPEN = "1"
  return env
}
