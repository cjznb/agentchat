/**
 * `agentchat reset` 子命令的纯参数解析（无任何 IO）——供 `bin/reset.mjs` 编排使用，并被 vitest 直接导入。
 *
 * - `parseResetArgs(argv)`：把 `agentchat reset` 之后的参数数组解析成结构化结果 + 校验错误列表
 *   （不打印、不退出）。与 `bin/cli-args.mjs` 的 `parseArgs` 同风格：纯函数、错误以文本列出。
 *
 * 语义（退出码见 `bin/reset.mjs`）：
 *   --yes                非交互确认（无 TTY 时必须显式给出，否则拒绝）
 *   --keep-backups       保留 `<home>/backups/`，仍清其余数据
 *   --uninstall-adapters 依次调用两个安装器的 `--uninstall`
 *   --force              Hub 正在运行也继续（输出中明确风险）
 *   -h, --help           显示 reset 帮助
 */

/**
 * @typedef {object} ParsedResetArgs
 * @property {boolean} yes
 * @property {boolean} keepBackups
 * @property {boolean} uninstallAdapters
 * @property {boolean} force
 * @property {boolean} help
 * @property {string[]} errors
 */

export const RESET_HELP_TEXT = `agentchat reset —— 清除全部本地数据，恢复出厂设置

用法:
  agentchat reset [--yes] [--keep-backups] [--uninstall-adapters] [--force]

选项:
  --yes                跳过交互确认（无 TTY 的环境必须显式给出）
  --keep-backups       保留 <home>/backups/ 下的每日备份，仍清其余数据
  --uninstall-adapters 依次调用两个适配器安装器的 --uninstall
  --force              Hub 正在运行也继续（有数据损坏风险，仅在确认已停用时使用）
  -h, --help           显示本帮助

行为:
  1. 先把整个数据目录复制为 <home>.bak-<时间戳>（先快照，失败即中止、保留原状）
  2. 清空 agentchat.db(+wal/shm)、tokens/、agents/、logs/、backups/、config.json、hub_token 等
  3. 出厂态不含 config.json，由安装器或首次运行再生成

退出码:
  0 成功（或用户在交互确认中放弃）
  1 运行错误（如快照失败；原始数据保留）
  2 参数错误
  3 Hub 正在运行（未加 --force）
  4 非交互环境缺少 --yes
`

/**
 * 解析 `agentchat reset` 的参数（`process.argv.slice(3)`）。纯函数：不打印、不退出、不读环境。
 * @param {string[]} argv
 * @returns {ParsedResetArgs}
 */
export function parseResetArgs(argv) {
  /** @type {ParsedResetArgs} */
  const parsed = {
    yes: false,
    keepBackups: false,
    uninstallAdapters: false,
    force: false,
    help: false,
    errors: [],
  }
  for (const arg of argv) {
    if (arg === "--yes") parsed.yes = true
    else if (arg === "--keep-backups") parsed.keepBackups = true
    else if (arg === "--uninstall-adapters") parsed.uninstallAdapters = true
    else if (arg === "--force") parsed.force = true
    else if (arg === "--help" || arg === "-h") parsed.help = true
    else parsed.errors.push(`无法识别的参数：${arg}`)
  }
  return parsed
}
