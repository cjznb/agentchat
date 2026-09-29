/**
 * 真机验证（需本机 `opencode`；缺失则整组跳过）：用**临时配置**确认 OpenCode 能解析安装器的
 * 本地桥条目，且旧 `remote` + `{file:}` 结构确实会让 OpenCode 直接无法解析配置（原缺陷的可证伪证据）。
 *
 * 隔离：`XDG_CONFIG_HOME` 指向临时目录、`OPENCODE_CONFIG` 指向临时文件 —— **绝不**读写用户的真实
 * `~/.config/opencode/**`。断言只看退出码与 stderr，不依赖用户机器上的其它 MCP 配置。
 *
 * 稳定性：缺 `opencode` → 整组 `describe.skip`；子进程有**有界上限**（`SPAWN_TIMEOUT_MS`），环境慢 /
 * 无网络（`debug config` 含网络检查）时**有条件跳过**单一用例，绝不无限挂起、绝不误报失败。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_DIR = join(TEST_DIR, "..")
const INSTALL = join(ADAPTER_DIR, "install.mjs")

/**
 * 真机子进程**有界上限**：环境慢 / 无网络时 `debug config`（含版本/模型注册表网络检查）可能远超
 * 实测值，绝不让它无限挂起（vitest 无法中断同步的 `spawnSync`）。超限即终止，由用例**有条件跳过**。
 */
const SPAWN_TIMEOUT_MS = 60_000

const available =
  spawnSync("opencode --version", {
    encoding: "utf8",
    shell: true,
    timeout: 10_000,
    killSignal: "SIGKILL",
  }).status === 0
const suite = available ? describe : describe.skip

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-oc-debug-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Isolated {
  readonly configPath: string
  readonly env: NodeJS.ProcessEnv
}

function isolate(dir: string): Isolated {
  const configPath = join(dir, "opencode.json")
  return {
    configPath,
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "xdg"), OPENCODE_CONFIG: configPath },
  }
}

function debugConfig(iso: Isolated): SpawnSyncReturns<string> {
  return spawnSync("opencode debug config", {
    encoding: "utf8",
    shell: true,
    env: iso.env,
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  })
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

/**
 * 子进程被本层超时终止 / 无法启动（环境慢、无网络、opencode 中途不可用）→ **有条件跳过**
 * 真机断言（非断言失败）。**只在 `opencode` 实际可用且及时响应时**才跑断言 —— 不是「永远跳过」。
 */
function timedOutOrUnavailable(result: SpawnSyncReturns<string>): boolean {
  return result.error !== undefined
}

suite("真实 OpenCode 解析安装器输出", () => {
  // 真实 `opencode debug config` 含网络检查（版本/模型注册表），实测首次约 20–35s、后续极快；
  // vitest 无法中断同步 `spawnSync`，故既有单次 spawn 上限（`SPAWN_TIMEOUT_MS`）才是真正的挂起边界；
  // 本超时只作兜底（须 > 安装 + 单次 spawn 上限）。
  const REAL_TIMEOUT = 75_000

  it("accepts the installer's local-bridge config (exit 0, no bad file reference)", (ctx) => {
    const dir = tempDir()
    const iso = isolate(dir)
    writeFileSync(iso.configPath, '{ "$schema": "https://opencode.ai/config.json" }\n')

    const install = spawnSync(process.execPath, [INSTALL, "--config", iso.configPath], {
      encoding: "utf8",
      env: { ...iso.env, AGENTCHAT_HOME: join(dir, "home") },
    })
    expect(install.status).toBe(0)

    const result = debugConfig(iso)
    if (timedOutOrUnavailable(result)) {
      ctx.skip(`opencode debug config 未在 ${SPAWN_TIMEOUT_MS}ms 内响应；跳过真机断言`)
    }
    const output = combined(result)
    expect(output).not.toContain("Configuration is invalid")
    expect(output).not.toContain("bad file reference")
    expect(result.status).toBe(0)
  }, REAL_TIMEOUT)

  it("reproduces the original bricking with a legacy {file:} reference to a missing file", (ctx) => {
    const dir = tempDir()
    const iso = isolate(dir)
    const missing = join(dir, "definitely-missing.id").split(/[\\/]/).join("/")
    writeFileSync(
      iso.configPath,
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            agentchat: {
              type: "remote",
              url: "http://127.0.0.1:4646/mcp",
              enabled: true,
              headers: { "x-agent-id": `{file:${missing}}` },
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    const result = debugConfig(iso)
    if (timedOutOrUnavailable(result)) {
      ctx.skip(`opencode debug config 未在 ${SPAWN_TIMEOUT_MS}ms 内响应；跳过真机断言`)
    }
    expect(result.status).not.toBe(0)
    expect(combined(result)).toMatch(/bad file reference|Configuration is invalid/)
  }, REAL_TIMEOUT)
})
