/**
 * `agentchat repair-identity` 的纯参数解析（无任何 IO）——供 `bin/repair-identity.mjs` 使用，
 * 并被 vitest 直接导入。与 `bin/reset-args.mjs` 同风格：纯函数、错误以文本列出、不打印不退出。
 *
 * 三种模式（互斥）：
 *   （缺省）dry-run  只扫描 + 打印报告，**零写入**
 *   --apply          执行修复；写前先 `VACUUM INTO` 快照，失败即中止
 *   --check          只报残留（供升级后自检），退出码 0=干净 / 1=有残留 / 2=失败
 */

/**
 * @typedef {object} ParsedRepairArgs
 * @property {boolean} apply
 * @property {boolean} check
 * @property {boolean} json
 * @property {string | undefined} home
 * @property {boolean} help
 * @property {string[]} errors
 */

export const REPAIR_HELP_TEXT = `agentchat repair-identity —— 修复"容器身份冒用"留下的存量数据

用法:
  node bin/repair-identity.mjs [--home <dir>] [--json]      # dry-run：只报告，零写入
  node bin/repair-identity.mjs --apply                      # 执行修复（写前自动快照）
  node bin/repair-identity.mjs --check                      # 自检残留，退出码 0/1/2

选项:
  --apply       执行修复（缺省只做 dry-run）。写前先 VACUUM INTO <home>.bak-identity-<时间戳>/agentchat.db
  --check       只报告残留，不写库：退出码 0=干净 / 1=有残留 / 2=执行失败
  --json        以 JSON 输出报告（机器可读；人类可读表格见缺省输出）
  --home <dir>  数据目录（等价 env AGENTCHAT_HOME；默认 ~/.agentchat）
  -h, --help    显示本帮助

修复内容（安全、不丢消息）:
  1. 删除容器节点的 participants 行（容器永不可收件）
  2. 删除容器节点的 read_states 行（容器从不取件）
  3. 删除以容器为唤醒目标的 wake_jobs 行
  4. 容器署名的**非 system** 消息不删，只标注 messages.meta.legacy_identity = "container"
     （合并进既有 meta、保留其它键、幂等）；容器署名的 system 消息不标注，只单独计数列出
  5. 容器 agents / agent_keys 行**保留**（层级与注册仍需要）；容器创建的群只报告不删

--check 的"残留"（任一项 > 0 → 退出码 1）:
  容器 participants / 容器 read_states / 容器 wake_jobs / 未标注的容器署名非 system 消息 /
  容器创建的群（此项本脚本不修，需人工确认后处理）

退出码:
  0 成功 / 干净（--check 无残留）
  1 --check 仍有残留
  2 执行失败（打不开库、快照失败、参数错误、外键检查不通过等）

注意:
  --apply 前请先停止 Hub（运行中写库有风险）；本脚本只碰数据库，不碰 adapters/ 下的运行时身份文件。
`

/**
 * 解析参数数组（`process.argv.slice(2)`）。纯函数：不打印、不退出、不读环境。
 * @param {string[]} argv
 * @returns {ParsedRepairArgs}
 */
export function parseRepairArgs(argv) {
  /** @type {ParsedRepairArgs} */
  const parsed = {
    apply: false,
    check: false,
    json: false,
    home: undefined,
    help: false,
    errors: [],
  }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === "--apply") {
      parsed.apply = true
      index += 1
      continue
    }
    if (arg === "--check") {
      parsed.check = true
      index += 1
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      index += 1
      continue
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      index += 1
      continue
    }
    if (arg === "--home" || arg.startsWith("--home=")) {
      const inline = arg === "--home" ? undefined : arg.slice("--home=".length)
      if (inline !== undefined) {
        if (inline === "") parsed.errors.push("选项 --home 缺少取值")
        else parsed.home = inline
        index += 1
        continue
      }
      const value = argv[index + 1]
      if (value === undefined || value === "") {
        parsed.errors.push("选项 --home 缺少取值")
        index += 1
        continue
      }
      parsed.home = value
      index += 2
      continue
    }
    parsed.errors.push(`无法识别的参数：${arg}`)
    index += 1
  }
  if (parsed.apply && parsed.check) parsed.errors.push("--apply 与 --check 互斥（--check 只读不写）")
  return parsed
}
