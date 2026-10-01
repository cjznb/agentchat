/**
 * DSH 安装器单测（`adapters/dsh/install.mjs`，实现已拆到 `install-plan/-apply/-yaml/-io.mjs`，
 * 此处只经由 `install.mjs` 的**公开面**调用，等于同时验证再导出没漏名字）。
 *
 * 为什么不用子进程：沙箱里不能开管道 stdio（`child_process.spawn`/`exec` 的默认 `stdio: "pipe"`
 * 会 EPERM），所以这里**直接 import 导出的函数**（纯规划 `parseArgs` / `planInstall` /
 * `planUninstall` / `renderPlan` + 副作用层 `applyPlan` + `--dry-run` 摘要 `dryRunSummary` /
 * `planHasChanges`），在**临时目录**上跑完整流程：真实 `~/.dsh`、`~/.agentchat` 一概不碰。
 *
 * ⚠️ 本机实测（Windows + 该 Node/沙箱组合）：`lstatSync` 把目录联接报成**普通目录**、
 * `readlinkSync` 直接 EINVAL、`realpathSync`（JS 版）也不解析；只有 `realpathSync.native` 能解析出
 * 真实目标。更危险的是 `fs.rmSync(dir, { recursive: true })` 会**穿透联接删掉目标目录的内容**。
 * 因此用例里：① 联接目标一律是临时目录中的**副本**，绝不指向仓库里的 `adapters/dsh`；
 * ② `afterEach` 先用 `rmdirSync` 摘掉联接（只删重解析点、不碰目标），再删临时目录。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MANAGED_HEAD,
  MANAGED_TAIL,
  applyPlan,
  dryRunSummary,
  parseArgs,
  planHasChanges,
  planInstall,
  planUninstall,
  renderPlan,
} from "../install.mjs"

const ADAPTER_ID = "@agentchat/dsh-adapter"
const PROFILE = "desktop"

/** `file:` 依赖值的期望形态：路径写**正斜杠**（跨平台 pnpm 便利），与 `install-plan.mjs` 一致。 */
function dependencyValue(path: string): string {
  return `file:${path.split("\\").join("/")}`
}

/** 规划结果的形状（由 `.mjs` 的 JSDoc typedef 推断，避免两边各写一份）。 */
type Plan = ReturnType<typeof planInstall>
type PlannedFile = Plan["files"][number]

/** 注入给纯规划函数的上下文（当前文件内容由调用方读好，见 install.mjs 头部设计说明）。 */
interface Ctx {
  dshHome: string
  profile: string
  adapterDir: string
  agentchatHome: string
  nodeExe?: string
  profilePackage?: string
  userPatch?: string
  agentchatConfig?: Record<string, unknown>
}

/** DSH 生成的 profile manifest 形状（`dependencies` 与 `dsh.profile.bundles` 容器恒存在）。 */
const EMPTY_MANIFEST: Record<string, unknown> = {
  name: "dsh-profile-desktop",
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    },
  },
}

/** 真实 patch 形状：顶层是数组，列表项带**缩进续行**（`name:` / `config:` 不顶格）。 */
const USER_PATCH = `${[
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries.",
  "- id: ui-settings-general",
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  "  config:",
  "    welcomeNoticeVersion: 2026-08-13.1",
  "- id: agent-default-model",
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  "  config:",
  "    provider: deepseek-account",
  "    model: deepseek-flash",
  "",
].join("\n")}`

/** Hub `config.json`：带无关键与其它厂商登记。 */
const USER_HUB: Record<string, unknown> = {
  port: 5555,
  adapters: ["opencode"],
  openBrowser: false,
}

const roots: string[] = []
const links: string[] = []

afterEach(() => {
  // 先摘联接（rmdir 只删重解析点；对非空真实目录会 ENOTEMPTY，正好不会误删）。
  for (const link of links.splice(0)) {
    try {
      rmdirSync(link)
    } catch {
      /* 不存在 / 不是联接：留给下面的整目录清理 */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

// ── 文件小工具 ──────────────────────────────────────────────────────

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

function mustRead(path: string): string {
  const text = readIfExists(path)
  if (text === undefined) throw new Error(`文件不存在：${path}`)
  return text
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("不是 JSON 对象")
  }
  return value as Record<string, unknown>
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function nativeResolve(path: string): string {
  const real = realpathSync.native(path).replace(/^\\\\\?\\/, "")
  const resolved = resolve(real)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

// ── 夹具 ────────────────────────────────────────────────────────────

interface Fixture {
  readonly root: string
  readonly dshHome: string
  readonly hubHome: string
  readonly adapterDir: string
  readonly bridgePath: string
  readonly profileDir: string
  readonly manifestPath: string
  readonly patchPath: string
  readonly hubPath: string
  readonly linkPath: string
}

interface FixtureOptions {
  /** 写一份 DSH 形状的 profile manifest（默认 true）。 */
  readonly withManifest?: boolean
  /** 写一份带用户条目的 patch 文件（默认 false = 文件不存在）。 */
  readonly withPatch?: boolean
  /** 写一份带其它厂商的 Hub 配置（默认 false = 文件不存在）。 */
  readonly withHub?: boolean
}

/**
 * 临时目录里的完整 profile 夹具。联接目标 `adapterDir` 是**临时副本**：
 * 即便清理时误穿透联接，也只会删掉这份副本，不会碰仓库里的 `adapters/dsh`。
 */
function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = tempDir("agentchat-dsh-install-")
  const dshHome = join(root, "dsh")
  const hubHome = join(root, "agentchat")
  const adapterDir = join(root, "adapter")
  const profileDir = join(dshHome, "profiles", PROFILE)
  const linkPath = join(dshHome, "profiles", "node_modules", "@agentchat", "dsh-adapter")
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(adapterDir, { recursive: true })
  writeFileSync(
    join(adapterDir, "package.json"),
    `${JSON.stringify({ name: ADAPTER_ID, version: "0.0.0-test" }, null, 2)}\n`,
  )
  writeFileSync(join(adapterDir, "mcp-bridge.mjs"), "// test bridge\n")
  const manifestPath = join(profileDir, "package.json")
  const patchPath = join(profileDir, "cordis.patch.yml")
  const hubPath = join(hubHome, "config.json")
  if (options.withManifest !== false) {
    writeFileSync(manifestPath, `${JSON.stringify(EMPTY_MANIFEST, null, 2)}\n`)
  }
  if (options.withPatch === true) writeFileSync(patchPath, USER_PATCH)
  if (options.withHub === true) {
    mkdirSync(hubHome, { recursive: true })
    writeFileSync(hubPath, `${JSON.stringify(USER_HUB, null, 2)}\n`)
  }
  links.push(linkPath)
  return {
    root,
    dshHome,
    hubHome,
    adapterDir,
    bridgePath: join(adapterDir, "mcp-bridge.mjs"),
    profileDir,
    manifestPath,
    patchPath,
    hubPath,
    linkPath,
  }
}

/** 从磁盘读回当前状态，组装注入式上下文（模拟 CLI 的 `main()`，但不 spawn）。 */
function contextOf(fixture: Fixture, nodeExe?: string): Ctx {
  const ctx: Ctx = {
    dshHome: fixture.dshHome,
    profile: PROFILE,
    adapterDir: fixture.adapterDir,
    agentchatHome: fixture.hubHome,
  }
  if (nodeExe !== undefined) ctx.nodeExe = nodeExe
  const manifest = readIfExists(fixture.manifestPath)
  if (manifest !== undefined) ctx.profilePackage = manifest
  const patch = readIfExists(fixture.patchPath)
  if (patch !== undefined) ctx.userPatch = patch
  const hub = readIfExists(fixture.hubPath)
  if (hub !== undefined) ctx.agentchatConfig = parseRecord(hub)
  return ctx
}

function fileAt(plan: Plan, path: string): PlannedFile {
  const file = plan.files.find((item) => item.path === path)
  if (file === undefined) throw new Error(`未规划该落点：${path}`)
  return file
}

interface Snapshot {
  readonly manifest: string | undefined
  readonly patch: string | undefined
  readonly hub: string | undefined
}

function snapshot(fixture: Fixture): Snapshot {
  return {
    manifest: readIfExists(fixture.manifestPath),
    patch: readIfExists(fixture.patchPath),
    hub: readIfExists(fixture.hubPath),
  }
}

// ── 1. 全新 profile 的规划（纯函数） ─────────────────────────────────

describe("planInstall：全新 profile", () => {
  it("规划四步安装（联结 / manifest / 托管块 / 厂商登记），全程不落盘", () => {
    const fixture = makeFixture({ withManifest: false, withPatch: false, withHub: false })
    const nodeExe = process.execPath
    const plan = planInstall(contextOf(fixture, nodeExe))

    // 纯规划：一个字节都不该写
    expect(existsSync(fixture.manifestPath)).toBe(false)
    expect(existsSync(fixture.patchPath)).toBe(false)
    expect(existsSync(fixture.hubPath)).toBe(false)
    expect(existsSync(fixture.linkPath)).toBe(false)

    // 1) 共享扁平模块根里的目录联接
    expect(plan.links).toHaveLength(1)
    const link = plan.links[0]
    if (link === undefined) throw new Error("缺少联结规划")
    expect(link.path).toBe(
      join(fixture.dshHome, "profiles", "node_modules", "@agentchat", "dsh-adapter"),
    )
    expect(link.target).toBe(fixture.adapterDir)
    expect(link.type).toBe(process.platform === "win32" ? "junction" : "dir")
    expect(plan.unlinks).toEqual([])

    // 2) manifest：file: 依赖 + bundle 选择项
    const manifestFile = fileAt(plan, fixture.manifestPath)
    expect(manifestFile.change).toBe(true)
    expect(manifestFile.existed).toBe(false)
    const manifest = parseRecord(manifestFile.content ?? "{}")
    expect(manifest["dependencies"]).toEqual({ [ADAPTER_ID]: dependencyValue(fixture.adapterDir) })
    expect(manifest["dsh"]).toEqual({ profile: { bundles: [ADAPTER_ID] } })
    expect(manifest["private"]).toBe(true)

    // 3) patch：托管块（marker 各一次；写 node 与桥的绝对路径）
    const patchFile = fileAt(plan, fixture.patchPath)
    const patch = patchFile.content ?? ""
    expect(patch.startsWith("# dsh profile 用户 patch 层")).toBe(true)
    expect(countOccurrences(patch, MANAGED_HEAD)).toBe(1)
    expect(countOccurrences(patch, MANAGED_TAIL)).toBe(1)
    expect(patch).toContain("- insert:")
    expect(patch).toContain("id: agentchat-mcp")
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(patch).toContain("serverName: agentchat")
    expect(patch).toContain("transport: stdio")
    expect(patch).toContain(`command: '${nodeExe}'`)
    expect(patch).toContain(`          - '${fixture.bridgePath}'`)

    // 4) Hub 厂商登记
    const hubFile = fileAt(plan, fixture.hubPath)
    expect(hubFile.change).toBe(true)
    expect(hubFile.kind).toBe("agentchat")
    expect(parseRecord(hubFile.content ?? "{}")["adapters"]).toEqual(["dsh"])

    expect(plan.notes.join("\n")).toContain("dsh.profile.bundles")
  })

  it("manifest 的 file: 依赖写正斜杠（跨平台 pnpm；仍是合法 JSON 字符串值）", () => {
    const fixture = makeFixture({ withManifest: false, withPatch: false, withHub: false })
    const plan = planInstall(contextOf(fixture))
    const dependencies = parseRecord(fileAt(plan, fixture.manifestPath).content ?? "{}")["dependencies"]
    expect(dependencies).toEqual({ [ADAPTER_ID]: dependencyValue(fixture.adapterDir) })
    const value = (dependencies as Record<string, unknown>)[ADAPTER_ID]
    expect(typeof value).toBe("string")
    expect(value as string).not.toContain("\\")
    expect(value as string).toMatch(/^file:.+$/)

    // 落盘原文同样是正斜杠：写原生反斜杠时 JSON 里会是 `"file:C:\\..."`，这条断言即失败。
    applyPlan(plan, {})
    expect(mustRead(fixture.manifestPath)).toContain(JSON.stringify(dependencyValue(fixture.adapterDir)))
  })

  it("写进已有 patch 时保留用户条目（含缩进续行），且顶层校验接受真实形状", () => {
    const fixture = makeFixture({ withPatch: true })
    const plan = planInstall(contextOf(fixture))
    const patch = fileAt(plan, fixture.patchPath).content ?? ""
    expect(patch.startsWith(USER_PATCH)).toBe(true)
    expect(patch).toContain("welcomeNoticeVersion: 2026-08-13.1")
    expect(countOccurrences(patch, MANAGED_HEAD)).toBe(1)
  })
})

// ── 2. 幂等 ─────────────────────────────────────────────────────────

describe("幂等安装", () => {
  it("安装两次逐字节相同，第二次无改动且不重写 .bak", () => {
    const fixture = makeFixture({ withPatch: true, withHub: true })
    const before = snapshot(fixture)

    const first = applyPlan(planInstall(contextOf(fixture)), {})
    expect(first.actions.some((action) => action.changed)).toBe(true)
    const afterFirst = snapshot(fixture)
    expect(afterFirst.manifest).not.toBe(before.manifest)
    expect(afterFirst.patch).not.toBe(before.patch)
    expect(afterFirst.hub).not.toBe(before.hub)
    // 备份是"安装前"的内容
    expect(mustRead(`${fixture.manifestPath}.bak`)).toBe(before.manifest ?? "")
    expect(mustRead(`${fixture.patchPath}.bak`)).toBe(before.patch ?? "")
    expect(mustRead(`${fixture.hubPath}.bak`)).toBe(before.hub ?? "")

    const second = planInstall(contextOf(fixture))
    expect(second.files.every((file) => !file.change)).toBe(true)
    const result = applyPlan(second, {})
    expect(result.actions.every((action) => !action.changed)).toBe(true)

    // 逐字节不变（含联接：第二次必须认出"已就绪"）
    expect(snapshot(fixture)).toEqual(afterFirst)
    expect(mustRead(fixture.manifestPath)).toBe(afterFirst.manifest ?? "")
    expect(countOccurrences(mustRead(fixture.patchPath), MANAGED_HEAD)).toBe(1)
    // 第二次没有重写备份
    expect(mustRead(`${fixture.manifestPath}.bak`)).toBe(before.manifest ?? "")
  })
})

// ── 3. --dry-run ────────────────────────────────────────────────────

describe("--dry-run / renderPlan", () => {
  it("dryRun 只计算不落盘：磁盘保持原样、无 .bak、无联接，但计划本身有改动", () => {
    const fixture = makeFixture({ withPatch: true, withHub: true })
    const before = snapshot(fixture)

    const plan = planInstall(contextOf(fixture))
    const result = applyPlan(plan, { dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.actions.some((action) => action.changed)).toBe(true)

    expect(snapshot(fixture)).toEqual(before)
    expect(existsSync(`${fixture.manifestPath}.bak`)).toBe(false)
    expect(existsSync(`${fixture.patchPath}.bak`)).toBe(false)
    expect(existsSync(`${fixture.hubPath}.bak`)).toBe(false)
    expect(existsSync(fixture.linkPath)).toBe(false)
  })

  it("renderPlan 打印全部落点路径与将要写入的原文（YAML + JSON）", () => {
    const fixture = makeFixture({ withManifest: false, withPatch: false, withHub: false })
    const text = renderPlan(planInstall(contextOf(fixture)), false)
    expect(text).toContain(fixture.manifestPath)
    expect(text).toContain(fixture.patchPath)
    expect(text).toContain(fixture.hubPath)
    expect(text).toContain(fixture.linkPath)
    expect(text).toContain(MANAGED_HEAD)
    expect(text).toContain(`command: '${process.execPath}'`)
    expect(text).toContain('"dependencies"')
    expect(text).toContain('"adapters"')
  })
})

// ── 3b. --dry-run 摘要：no-op 不得报「将有改动」──────────────────────

describe("dryRunSummary：no-op 与真有改动要分清", () => {
  it("安装计划恒带一条联结，但联结已指向同一目标 → 「无改动」", () => {
    const fixture = makeFixture({ withPatch: true, withHub: true })
    applyPlan(planInstall(contextOf(fixture)), {}) // 先真装一次：三份文件 + 联结全部就绪

    const plan = planInstall(contextOf(fixture))
    expect(plan.files.every((file) => !file.change)).toBe(true)
    // 关键：计划里确实有一条联结条目（旧实现在此恒报"将有改动"）
    expect(plan.links).toHaveLength(1)
    expect(planHasChanges(plan)).toBe(false)
    expect(dryRunSummary(plan)).toBe("[agentchat] --dry-run：未写入（无改动）")
  })

  it("卸载计划恒带一条 unlink，但联结本就不存在 → 「无改动」", () => {
    const fixture = makeFixture({ withManifest: true }) // 干净 profile：无联结、无 patch、无 Hub 配置
    const plan = planUninstall(contextOf(fixture))
    expect(plan.unlinks).toHaveLength(1)
    expect(plan.files.every((file) => !file.change)).toBe(true)
    expect(planHasChanges(plan)).toBe(false)
    expect(dryRunSummary(plan)).toBe("[agentchat] --dry-run：未写入（无改动）")
  })

  it("真有改动时仍报「将有改动」（未安装的安装、已安装的卸载）", () => {
    const fixture = makeFixture({ withPatch: true, withHub: true })
    expect(planHasChanges(planInstall(contextOf(fixture)))).toBe(true)
    expect(dryRunSummary(planInstall(contextOf(fixture)))).toBe(
      "[agentchat] --dry-run：未写入（将有改动）",
    )

    applyPlan(planInstall(contextOf(fixture)), {})
    expect(planHasChanges(planUninstall(contextOf(fixture)))).toBe(true)
    expect(dryRunSummary(planUninstall(contextOf(fixture)))).toBe(
      "[agentchat] --dry-run：未写入（将有改动）",
    )
  })
})

// ── 4. 卸载逐字节还原 ───────────────────────────────────────────────

describe("planUninstall：逐字节还原", () => {
  it("卸载后 profile 文件与安装前快照逐字节相同（用户条目 / 无关键完好），联接被摘除", () => {
    const fixture = makeFixture({ withPatch: true, withHub: true })
    const before = snapshot(fixture)

    applyPlan(planInstall(contextOf(fixture)), {})
    expect(mustRead(fixture.patchPath)).toContain(MANAGED_HEAD)
    expect(countOccurrences(mustRead(fixture.patchPath), MANAGED_HEAD)).toBe(1)

    // 安装只动我们这两处：无关 manifest 键与其它 bundle 选择项保持
    const installedManifest = parseRecord(mustRead(fixture.manifestPath))
    expect(installedManifest["private"]).toBe(true)
    expect(installedManifest["name"]).toBe("dsh-profile-desktop")
    expect(installedManifest["dsh"]).toEqual({
      profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ADAPTER_ID] },
    })
    const installedHub = parseRecord(mustRead(fixture.hubPath))
    expect(installedHub["port"]).toBe(5555)
    expect(installedHub["openBrowser"]).toBe(false)
    expect(installedHub["adapters"]).toEqual(["opencode", "dsh"])

    const result = applyPlan(planUninstall(contextOf(fixture)), {})
    expect(result.actions.some((action) => action.changed)).toBe(true)

    expect(mustRead(fixture.manifestPath)).toBe(before.manifest ?? "")
    expect(mustRead(fixture.patchPath)).toBe(before.patch ?? "")
    expect(mustRead(fixture.hubPath)).toBe(before.hub ?? "")
    expect(existsSync(fixture.linkPath)).toBe(false)
  })

  it("预置不存在 patch / manifest 时：安装会创建，卸载会删掉（Hub 配置保留但不删）", () => {
    const fixture = makeFixture({ withManifest: false, withPatch: false, withHub: false })

    applyPlan(planInstall(contextOf(fixture)), {})
    expect(existsSync(fixture.patchPath)).toBe(true)
    expect(existsSync(fixture.manifestPath)).toBe(true)
    expect(existsSync(fixture.hubPath)).toBe(true)

    applyPlan(planUninstall(contextOf(fixture)), {})
    expect(existsSync(fixture.patchPath)).toBe(false)
    expect(existsSync(fixture.manifestPath)).toBe(false)
    // Hub 配置是 Hub 的文件：只摘厂商登记，不删文件（与 opencode / claude-code 安装器一致）
    expect(existsSync(fixture.hubPath)).toBe(true)
    expect(parseRecord(mustRead(fixture.hubPath))["adapters"]).toEqual([])
  })

  it("在干净 profile 上卸载是幂等的（无改动、不创建任何文件）", () => {
    const fixture = makeFixture({ withManifest: true })
    const plan = planUninstall(contextOf(fixture))
    expect(plan.files.every((file) => !file.change)).toBe(true)
    expect(plan.links).toEqual([])
    const result = applyPlan(plan, {})
    expect(result.actions.every((action) => !action.changed)).toBe(true)
    expect(existsSync(fixture.patchPath)).toBe(false)
    expect(existsSync(fixture.hubPath)).toBe(false)
    expect(existsSync(`${fixture.manifestPath}.bak`)).toBe(false)
  })

  it("原文末尾没有换行符时也能逐字节还原（patch 与 manifest）", () => {
    const fixture = makeFixture({ withManifest: false })
    const manifest = JSON.stringify(EMPTY_MANIFEST, null, 2) // 故意不带末尾换行
    const patch = USER_PATCH.replace(/\n$/, "") // 故意不带末尾换行
    writeFileSync(fixture.manifestPath, manifest)
    writeFileSync(fixture.patchPath, patch)

    applyPlan(planInstall(contextOf(fixture)), {})
    expect(mustRead(fixture.patchPath)).toContain(MANAGED_HEAD)
    expect(mustRead(fixture.patchPath).endsWith("\n")).toBe(true)

    applyPlan(planUninstall(contextOf(fixture)), {})
    expect(mustRead(fixture.patchPath)).toBe(patch)
    expect(mustRead(fixture.manifestPath)).toBe(manifest)
  })

  it("Hub 配置沿用共享 helper 的序列化（2 空格 + 末尾换行），压缩格式会被规范化", () => {
    const fixture = makeFixture({ withManifest: true })
    mkdirSync(fixture.hubHome, { recursive: true })
    writeFileSync(fixture.hubPath, '{"adapters":[]}')

    applyPlan(planInstall(contextOf(fixture)), {})
    applyPlan(planUninstall(contextOf(fixture)), {})
    expect(mustRead(fixture.hubPath)).toBe('{\n  "adapters": []\n}\n')
  })
})

// ── 5. 托管块：替换而不是重复追加 ───────────────────────────────────

describe("托管块", () => {
  it("重新安装只替换块内文本：marker 仍各一次，用户正文与其它条目原样保留", () => {
    const fixture = makeFixture({ withPatch: true })
    applyPlan(planInstall(contextOf(fixture, "C:\\old\\node.exe")), {})
    const first = mustRead(fixture.patchPath)
    expect(countOccurrences(first, MANAGED_HEAD)).toBe(1)
    expect(first).toContain("command: 'C:\\old\\node.exe'")

    const result = applyPlan(planInstall(contextOf(fixture, "C:\\new\\node.exe")), {})
    const updated = mustRead(fixture.patchPath)
    expect(result.actions.some((action) => action.changed)).toBe(true)
    expect(countOccurrences(updated, MANAGED_HEAD)).toBe(1)
    expect(countOccurrences(updated, MANAGED_TAIL)).toBe(1)
    expect(updated).toContain("command: 'C:\\new\\node.exe'")
    expect(updated).not.toContain("C:\\old\\node.exe")
    expect(updated.startsWith(USER_PATCH)).toBe(true)
    expect(updated).toContain("welcomeNoticeVersion: 2026-08-13.1")
    expect(updated).toContain('name: "@deepseek-ai/dsh-agent-default-model"')
  })

  it("CRLF 的 patch：托管块按 CRLF 写，卸载后逐字节还原", () => {
    const fixture = makeFixture({ withManifest: true })
    const crlf = USER_PATCH.split("\n").join("\r\n")
    writeFileSync(fixture.patchPath, crlf)

    applyPlan(planInstall(contextOf(fixture)), {})
    const installed = mustRead(fixture.patchPath)
    expect(installed).toContain(USER_PATCH.split("\n")[0] ?? "")
    // 除 CRLF 外不应出现"裸 LF"
    expect(/[^\r]\n/.test(installed)).toBe(false)

    applyPlan(planUninstall(contextOf(fixture)), {})
    expect(mustRead(fixture.patchPath)).toBe(crlf)
  })

  it("顶层不是 YAML 数组 → 拒绝改写并抛清晰错误（一个字节都不写）", () => {
    const fixture = makeFixture({ withManifest: true })
    const map = "dsh:\n  profile:\n    bundles: []\n"
    writeFileSync(fixture.patchPath, map)

    expect(() => planInstall(contextOf(fixture))).toThrow(/顶层不是 YAML 数组/)
    expect(mustRead(fixture.patchPath)).toBe(map)
    // 规划期就抛，所以 applyPlan 根本没机会落盘
    expect(readIfExists(`${fixture.patchPath}.bak`)).toBeUndefined()
  })
})

// ── 6. CLI 参数 ─────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("未知参数 → 明确错误 + 用法提示（main 据此返回非 0）", () => {
    const bad = parseArgs(["--nope"])
    expect(bad.error).toContain("未知参数：--nope")
    expect(bad.error).toContain("--dry-run")
    expect(bad.error).toContain("--uninstall")

    expect(parseArgs(["--profile"]).error).toContain("需要一个值")
    expect(parseArgs(["--dsh-home", "--dry-run"]).error).toContain("需要一个值")
  })

  it("解析全部支持的参数", () => {
    const none = parseArgs([])
    expect(none.error).toBeUndefined()
    expect(none.dryRun).toBe(false)
    expect(none.uninstall).toBe(false)
    expect(none.help).toBe(false)

    const all = parseArgs([
      "--profile",
      "web",
      "--dsh-home",
      "C:\\dsh",
      "--agentchat-home",
      "C:\\hub",
      "--dry-run",
      "--uninstall",
    ])
    expect(all.error).toBeUndefined()
    expect(all.profile).toBe("web")
    expect(all.dshHome).toBe("C:\\dsh")
    expect(all.agentchatHome).toBe("C:\\hub")
    expect(all.dryRun).toBe(true)
    expect(all.uninstall).toBe(true)

    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })
})

// ── 7. 目录联接的副作用 ─────────────────────────────────────────────

describe("目录联接", () => {
  it("在共享扁平模块根建立联接；沙箱禁止建重解析点时只保留规划断言", () => {
    const fixture = makeFixture({ withPatch: true })
    const plan = planInstall(contextOf(fixture))
    const link = plan.links[0]
    if (link === undefined) throw new Error("缺少联结规划")
    expect(link.path).toBe(fixture.linkPath)
    expect(link.target).toBe(fixture.adapterDir)

    let created = false
    let denied = false
    try {
      applyPlan(plan, {})
      created = existsSync(fixture.linkPath)
    } catch (error) {
      // 某些沙箱禁止建重解析点：此时只保留上面的规划断言（规格允许）
      denied = true
      expect(String(error)).toMatch(/EPERM|EACCES|UNKNOWN|symlink/i)
    }

    // 环境支持建联结却没有建出来 → 说明副作用层坏了，必须失败（不是"跳过"）
    if (!denied) expect(created).toBe(true)

    if (created) {
      // 本机 lstat 认不出联接，改用 realpath.native 验证确实解析到目标
      expect(nativeResolve(fixture.linkPath)).toBe(nativeResolve(fixture.adapterDir))
      expect(mustRead(join(fixture.linkPath, "mcp-bridge.mjs"))).toContain("test bridge")

      const result = applyPlan(planUninstall(contextOf(fixture)), {})
      expect(result.actions.some((action) => action.kind === "unlink" && action.changed)).toBe(true)
      expect(existsSync(fixture.linkPath)).toBe(false)
      // 摘链接绝不碰目标内容
      expect(existsSync(join(fixture.adapterDir, "mcp-bridge.mjs"))).toBe(true)
      expect(existsSync(join(fixture.adapterDir, "package.json"))).toBe(true)
    }
  })
})
