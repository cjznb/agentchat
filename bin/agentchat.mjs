#!/usr/bin/env node
/**
 * `agentchat` 一行命令启动器（纯 Node，无第三方依赖）——`npm link` / `npm i -g .` 后可直接使用。
 *
 * 编排职责（IO）：
 *  1. 解析参数（纯逻辑在 `./cli-args.mjs`）；
 *  2. 按需构建前端（`client/dist/index.html` 缺失或显式 `--build`）；
 *  3. 以 `stdio: 'inherit'` 拉起真正的入口 `tsx server/main.ts`，转发 SIGINT/SIGTERM、透传退出码。
 *
 * 构建策略：优先**直接调用本地 Vite**（`node node_modules/vite/bin/vite.js build --config client/vite.config.ts`）——
 * 跳过 `npm run build` 的一层进程包装，更快、参数确定、无 shell 依赖；仅当本地 Vite 入口不存在
 * （node_modules 未装/布局异常）时回退 `npm run build`。
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HELP_TEXT, childEnv, parseArgs } from "./cli-args.mjs"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
    return typeof manifest.version === "string" ? manifest.version : "unknown"
  } catch {
    return "unknown"
  }
}

/** 按需构建前端；返回子进程退出码（0 = 成功）。 */
function buildClient(force) {
  if (!force && existsSync(join(packageRoot, "client", "dist", "index.html"))) return 0
  const viteBin = join(packageRoot, "node_modules", "vite", "bin", "vite.js")
  const options = { cwd: packageRoot, stdio: "inherit" }
  const result = existsSync(viteBin)
    ? spawnSync(process.execPath, [viteBin, "build", "--config", join("client", "vite.config.ts")], options)
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], options)
  return result.status ?? 1
}

/** 拉起 Hub 入口，前台代理信号与退出码。 */
function startHub(parsed) {
  const tsxBin = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs")
  if (!existsSync(tsxBin)) {
    console.error("[agentchat] 未找到 tsx，请先在仓库根目录执行 `npm install`。")
    process.exit(1)
  }
  const child = spawn(
    process.execPath,
    [tsxBin, join(packageRoot, "server", "main.ts"), ...parsed.passthrough],
    { cwd: packageRoot, env: childEnv(parsed, process.env), stdio: "inherit" },
  )
  process.on("SIGINT", () => child.kill("SIGINT"))
  process.on("SIGTERM", () => child.kill("SIGTERM"))
  child.on("error", (error) => {
    console.error(`[agentchat] 启动 Hub 失败：${error.message}`)
    process.exit(1)
  })
  child.on("exit", (code) => process.exit(code ?? 1))
}

function main() {
  if (process.argv[2] === "reset") {
    void import("./reset.mjs")
      .then(({ runResetCommand }) => runResetCommand(process.argv.slice(3)))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(`[agentchat] reset 失败：${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      })
    return
  }
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) console.error(`[agentchat] ${message}`)
    console.error("运行 `agentchat --help` 查看用法。")
    process.exit(2)
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT)
    return
  }
  if (parsed.version) {
    process.stdout.write(`${readVersion()}\n`)
    return
  }
  const status = buildClient(parsed.build)
  if (status !== 0) {
    console.error("[agentchat] 前端构建失败，已中止（如需跳过，请确保 client/dist 已存在）。")
    process.exit(status)
  }
  startHub(parsed)
}

main()
