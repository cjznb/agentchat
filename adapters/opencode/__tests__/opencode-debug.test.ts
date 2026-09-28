/**
 * 真机验证（需本机 `opencode`；缺失则整组跳过）：用**临时配置**确认 OpenCode 能解析安装器的
 * 本地桥条目，且旧 `remote` + `{file:}` 结构确实会让 OpenCode 直接无法解析配置（原缺陷的可证伪证据）。
 *
 * 隔离：`XDG_CONFIG_HOME` 指向临时目录、`OPENCODE_CONFIG` 指向临时文件 —— **绝不**读写用户的真实
 * `~/.config/opencode/**`。断言只看退出码与 stderr，不依赖用户机器上的其它 MCP 配置。
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

const available = spawnSync("opencode --version", { encoding: "utf8", shell: true }).status === 0
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
  return spawnSync("opencode debug config", { encoding: "utf8", shell: true, env: iso.env })
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

suite("真实 OpenCode 解析安装器输出", () => {
  // 真实 `opencode debug config` 含网络检查（版本/模型注册表），实测约 20s 才退出；放宽超时。
  const REAL_TIMEOUT = 120_000

  it("accepts the installer's local-bridge config (exit 0, no bad file reference)", () => {
    const dir = tempDir()
    const iso = isolate(dir)
    writeFileSync(iso.configPath, '{ "$schema": "https://opencode.ai/config.json" }\n')

    const install = spawnSync(process.execPath, [INSTALL, "--config", iso.configPath], {
      encoding: "utf8",
      env: { ...iso.env, AGENTCHAT_HOME: join(dir, "home") },
    })
    expect(install.status).toBe(0)

    const result = debugConfig(iso)
    const output = combined(result)
    expect(output).not.toContain("Configuration is invalid")
    expect(output).not.toContain("bad file reference")
    expect(result.status).toBe(0)
  }, REAL_TIMEOUT)

  it("reproduces the original bricking with a legacy {file:} reference to a missing file", () => {
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
    expect(result.status).not.toBe(0)
    expect(combined(result)).toMatch(/bad file reference|Configuration is invalid/)
  }, REAL_TIMEOUT)
})
