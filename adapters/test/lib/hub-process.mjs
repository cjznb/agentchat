/**
 * Hub 进程生命周期（`adapters/test/lib/hub-process.mjs`）——`--spawn` 模式的安全护栏与拉管。
 *
 * ## 为什么需要本文件（仓库有过历史事故）
 * - `~/.agentchat` 是**用户真实数据目录**：本适配器只在一次性临时目录上跑，
 *   且**拒绝对真实目录执行 `--spawn`**（宁可不跑，也不冒险）。
 * - Hub 的 `hub_token` 是**惰性**创建的（首个 `/internal/*` 或 `/mcp` 请求时才写盘）。
 *   若等 Hub 自建，客户端在构造 `createHubClient` 时读到的还是空 token → 全 401。
 *   故**先写 token 再拉起 Hub**：`ensureHubToken` 读到已有非空文件即复用（`routes/internal.ts:52`）。
 * - 关停必须杀**整棵进程树**：`tsx` 会再拉起子 node，只杀父进程会留下监听端口的孤儿。
 *   Windows 用 `taskkill /F /T /PID`；POSIX 用进程组（`detached` + `kill(-pid)`）。
 */
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** 仓库根（`agentchat/`）：本文件在 `agentchat/adapters/test/lib/`。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
/** hub_token 文件名（与 `server/config.ts` 的 `join(home, "hub_token")` 一致）。 */
export const HUB_TOKEN_FILE = "hub_token"

/** 真实数据目录的绝对路径（拒绝作为 `--spawn` 目标）。 */
export function realHomePath() {
  return resolve(join(homedir(), ".agentchat"))
}

/**
 * 拒绝把 `--spawn` 指向真实数据目录（大小写不敏感比较，Windows 路径不区分大小写）。
 * @param {string} home
 */
export function assertNotRealHome(home) {
  const target = resolve(home)
  const real = realHomePath()
  if (target.toLowerCase() === real.toLowerCase()) {
    throw new Error(
      `拒绝以 ${target} 作为 --spawn 的数据目录（那是用户真实 ~/.agentchat，仓库有历史事故）。` +
        "省略 --home 会自动建一次性临时目录；确需指定请给一个临时目录。",
    )
  }
}

/** 一次性临时 home（`--spawn` 未给 `--home` 时的缺省；只由调用方在结束时删除）。 */
export function makeTempHome(prefix = "agentchat-t6-") {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 预写 `hub_token`（0600）：让 Hub 与测试客户端用同一张票。
 * @returns {string} 生成的 token（调用方一般不需要，从文件读即可）
 */
export function prepareHubToken(home) {
  mkdirSync(home, { recursive: true })
  const token = randomBytes(32).toString("base64url")
  writeFileSync(join(home, HUB_TOKEN_FILE), token, { mode: 0o600 })
  return token
}

/** 取一个空闲端口（`listen(0)` 拿 OS 分配值后立即释放；随后交给 Hub）。 */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("freePort: expected AddressInfo"))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

/** 轮询 `/api/health` 直到 200（或超时抛出，附 Hub 日志尾部）。 */
export async function waitForHealth(baseUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // Hub 还没起来：继续轮询
    }
    if (Date.now() > deadline) {
      const tail = (options.logs ?? []).slice(-20).join("\n")
      throw new Error(`Hub 未在 ${timeoutMs}ms 内就绪（${baseUrl}/api/health）\n${tail}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
}

/** 杀整棵进程树（见文件头：Windows `taskkill /F /T`；POSIX 进程组）。 */
export function killTree(pid) {
  return new Promise((resolveKill) => {
    const done = () => resolveKill()
    if (typeof pid !== "number") {
      done()
      return
    }
    if (process.platform === "win32") {
      const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" })
      child.once("exit", done)
      child.once("error", done)
      return
    }
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // 已经退出
      }
    }
    done()
  })
}

/**
 * 拉起真实 Hub：`node <repo>/node_modules/tsx/dist/cli.mjs server/main.ts`
 * （等价 `npx tsx server/main.ts`，但直连本地 tsx 二进制，避免 Windows 上 `npx.cmd`
 * 需要 shell 包装、PID 变成 cmd.exe 的坑）。
 *
 * `AGENTCHAT_ADAPTERS=""` 显式清空厂商登记（空串 = 显式清空，压过 `config.json`）：
 * 测试面不需要任何 push 适配器，dispatcher 因此只退避、绝不注入我们的 job。
 *
 * @param {{home: string, port: number, log?: (line: string) => void, logs?: string[]}} options
 */
export async function startHubProcess(options) {
  const cli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs")
  const env = {
    ...process.env,
    AGENTCHAT_HOME: options.home,
    AGENTCHAT_PORT: String(options.port),
    AGENTCHAT_TEST_API: "1",
    AGENTCHAT_NO_OPEN: "1",
    AGENTCHAT_ADAPTERS: "",
  }
  const logs = options.logs ?? []
  const child = spawn(process.execPath, [cli, "server/main.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line === "") continue
      logs.push(line)
      options.log?.(line)
    }
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  const url = `http://127.0.0.1:${options.port}`
  return {
    url,
    pid: child.pid,
    logs,
    async stop() {
      await killTree(child.pid)
    },
  }
}
