/**
 * U1/task-16：版本面与更新检查（`server/routes/version.ts` + `version-check.ts` + `version-semver.ts`）。
 *
 * 全覆盖且**零网络**：`/api/version/check` 的 fetch 一律注入（`VersionRoutesOptions.fetchImpl`），
 * 任何用例都不得真打 GitHub。断言口径：
 * - `/api/version` 结构、hub 版本（读 package.json）、`bundledVersion`（读 adapters/<vendor>）、
 *   适配器上报版本比对（相等/不同/未上报）、路径穿越防护、注册表 ∪ 配置厂商
 * - `/api/version/check` 成功字段、缓存命中与 TTL 失效、releases→tags 回落、
 *   no_tags / network / timeout / too_large / http_error / invalid_url 的失败姿态（HTTP 200，非 500）
 * - semver 单源边界（预发布、数字段、build metadata）、tag 列表取最高版本
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../server/config"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import {
  HUB_MANIFEST,
  clearAdapterVersions,
  clearUpdateCache,
  compareSemver,
  compareVersionStrings,
  extractTags,
  latestTag,
  normalizeVersion,
  parseSemver,
  recordAdapterVersion,
  type UpdateCheckOutcome,
  type VersionRoutesOptions,
  type VersionSnapshot,
} from "../../server/routes/version"

let home = ""
let db: Db

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-version-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapterVersions()
  clearUpdateCache()
})

afterEach(() => {
  clearAdapterVersions()
  clearUpdateCache()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** 真实 `package.json`（Hub 版本的唯一来源）——测试与实现同源断言，不写死版本号。 */
const PACKAGE_JSON = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { name: string; version: string }

function appWith(version: VersionRoutesOptions = {}) {
  // `adapters: []`：隔离进程配置，厂商集合完全由用例的 `vendors` 决定。
  return createApp(db, { adapters: [], version })
}

async function getVersion(version: VersionRoutesOptions = {}): Promise<VersionSnapshot> {
  const response = await appWith(version).request("/api/version")
  expect(response.status).toBe(200)
  return (await response.json()) as VersionSnapshot
}

async function postCheck(version: VersionRoutesOptions = {}): Promise<UpdateCheckOutcome> {
  const response = await appWith(version).request("/api/version/check", { method: "POST" })
  expect(response.status).toBe(200) // 失败也是 200 + {ok:false}，绝不 500
  return (await response.json()) as UpdateCheckOutcome
}

/** 返回固定 tags 响应体的 fetch 双（记录调用 URL）。 */
function tagsFetch(calls: string[], tags: readonly unknown[], status = 200): typeof fetch {
  return async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify(tags), { status })
  }
}

describe("GET /api/version", () => {
  it("无鉴权可读：hub 版本读 package.json、厂商列表与 compareUrl 就位", async () => {
    const body = await getVersion()
    expect(body.ok).toBe(true)
    expect(body.hub.name).toBe(PACKAGE_JSON.name)
    expect(body.hub.version).toBe(PACKAGE_JSON.version)
    expect(body.hub.compareUrl).toBe("https://github.com/cjznb/agentchat")
    expect(body.checkedAt).toBeNull() // 尚未做过更新检查
    expect(body.adapters).toEqual([])
  })

  it("bundledVersion 读 adapters/<vendor>/package.json，缺失/非法厂商标识 → null", async () => {
    const body = await getVersion({ vendors: ["dsh", "no-such-adapter", "../evil"] })
    const dsh = body.adapters.find((adapter) => adapter.vendor === "dsh")
    expect(typeof dsh?.bundledVersion).toBe("string")
    expect(dsh?.version).toBeNull()
    expect(dsh?.reportedAt).toBeNull()
    expect(dsh?.outdated).toBeNull() // 任一侧缺失 → null（不谎报「落后」）
    for (const vendor of ["no-such-adapter", "../evil"]) {
      expect(body.adapters.find((adapter) => adapter.vendor === vendor)).toMatchObject({
        version: null,
        bundledVersion: null,
        outdated: null,
        reportedAt: null,
      })
    }
  })

  it("适配器上报版本与 bundledVersion 比对：相同 false、不同 true；注册表厂商自动列出", async () => {
    const bundled = (await getVersion({ vendors: ["dsh"] })).adapters[0]?.bundledVersion
    if (bundled === null || bundled === undefined) throw new Error("dsh 的内置版本缺失")

    recordAdapterVersion("dsh", bundled, 111)
    expect((await getVersion({ vendors: ["dsh"] })).adapters[0]).toMatchObject({
      vendor: "dsh",
      version: bundled,
      bundledVersion: bundled,
      outdated: false,
      reportedAt: 111,
    })

    recordAdapterVersion("dsh", "9.9.9")
    expect((await getVersion({ vendors: ["dsh"] })).adapters[0]).toMatchObject({
      version: "9.9.9",
      outdated: true,
    })

    recordAdapterVersion("ghost", "0.0.1", 7) // 不在配置厂商里也出现
    expect((await getVersion({ vendors: [] })).adapters.map((adapter) => adapter.vendor)).toEqual([
      "dsh",
      "ghost",
    ])
  })

  it("上报空值被忽略；`AGENTCHAT_COMMIT` 存在时作为 hub.commit 透出", async () => {
    recordAdapterVersion("", "1.0.0")
    recordAdapterVersion("dsh", "   ")
    expect((await getVersion({ vendors: ["dsh"] })).adapters[0]?.version).toBeNull()

    const saved = process.env["AGENTCHAT_COMMIT"]
    process.env["AGENTCHAT_COMMIT"] = "abc1234"
    try {
      expect((await getVersion()).hub.commit).toBe("abc1234")
    } finally {
      if (saved === undefined) delete process.env["AGENTCHAT_COMMIT"]
      else process.env["AGENTCHAT_COMMIT"] = saved
    }
  })
})

describe("POST /api/version/check（fetch 注入，零网络）", () => {
  it("取最高 tag、给出 updateAvailable/compareUrl，并在 TTL 内命中缓存", async () => {
    const calls: string[] = []
    const options: VersionRoutesOptions = {
      updateUrl: "https://example.test/tags",
      fetchImpl: tagsFetch(calls, [{ name: "v0.1.0" }, { name: "v99.0.0" }, { name: "v0.2.0" }]),
      now: () => 1_000,
      vendors: [],
    }
    const first = await postCheck(options)
    expect(first).toMatchObject({
      ok: true,
      current: PACKAGE_JSON.version,
      latest: "99.0.0",
      updateAvailable: true,
      tagsChecked: 3,
      source: "https://example.test/tags",
      checkedAt: 1_000,
      cached: false,
    })
    expect(first.ok && first.compareUrl).toBe(
      `https://github.com/cjznb/agentchat/compare/v${PACKAGE_JSON.version}...v99.0.0`,
    )
    expect(calls).toHaveLength(1)

    const second = await postCheck(options)
    expect(second).toMatchObject({ ok: true, cached: true, checkedAt: 1_000 })
    expect(calls).toHaveLength(1) // 缓存命中：不再出网
    expect((await getVersion()).checkedAt).toBe(1_000) // GET 反映上次成功检查时间
  })

  it("版本不落后时 updateAvailable=false（不靠真实版本号，用极低 tag）", async () => {
    const calls: string[] = []
    const outcome = await postCheck({
      updateUrl: "https://example.test/tags",
      fetchImpl: tagsFetch(calls, [{ tag_name: "v0.0.1" }]),
      vendors: [],
    })
    expect(outcome).toMatchObject({ ok: true, latest: "0.0.1", updateAvailable: false })
    expect(outcome.ok && outcome.compareUrl).toBe(
      `https://github.com/cjznb/agentchat/compare/v${PACKAGE_JSON.version}...v0.0.1`,
    )
  })

  it("缓存超 TTL 后重新出网", async () => {
    const calls: string[] = []
    let clock = 1_000
    const options: VersionRoutesOptions = {
      updateUrl: "https://example.test/tags",
      fetchImpl: tagsFetch(calls, [{ name: "v99.0.0" }]),
      now: () => clock,
      cacheTtlMs: 500,
      vendors: [],
    }
    expect(await postCheck(options)).toMatchObject({ ok: true, cached: false })
    clock = 1_499
    expect(await postCheck(options)).toMatchObject({ ok: true, cached: true })
    clock = 1_500 // now - at === ttl → 过期
    expect(await postCheck(options)).toMatchObject({ ok: true, cached: false })
    expect(calls).toHaveLength(2)
  })

  it("/releases 空或无内容 → 回落同仓库 /tags（HTTP 与响应体两种触发）", async () => {
    const empty: string[] = []
    const emptyFetch: typeof fetch = async (input) => {
      const url = String(input)
      empty.push(url)
      return url.endsWith("/releases")
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify([{ name: "v0.9.0" }]), { status: 200 })
    }
    expect(
      await postCheck({ updateUrl: "https://example.test/releases", fetchImpl: emptyFetch, vendors: [] }),
    ).toMatchObject({ ok: true, latest: "0.9.0", source: "https://example.test/tags", tagsChecked: 1 })
    expect(empty).toEqual(["https://example.test/releases", "https://example.test/tags"])

    // 404 变体：换数据源（缓存按源 URL 命中，不能复用上一段的源）后重新出网。
    clearUpdateCache()
    const notFound: string[] = []
    const notFoundFetch: typeof fetch = async (input) => {
      const url = String(input)
      notFound.push(url)
      return url.endsWith("/releases")
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify([{ tag_name: "v0.8.0" }]), { status: 200 })
    }
    expect(
      await postCheck({ updateUrl: "https://example.test/releases", fetchImpl: notFoundFetch, vendors: [] }),
    ).toMatchObject({ ok: true, latest: "0.8.0", source: "https://example.test/tags" })
    expect(notFound).toHaveLength(2)
  })

  it("失败姿态：no_tags / http_error / network / timeout / too_large / invalid_url（全部 200）", async () => {
    const emptyFetch = tagsFetch([], [])
    expect(
      await postCheck({ updateUrl: "https://example.test/tags", fetchImpl: emptyFetch, vendors: [] }),
    ).toMatchObject({ ok: false, error: "no_tags", source: "https://example.test/tags" })

    const brokenJson: typeof fetch = async () => new Response("<html>nope", { status: 200 })
    expect(
      await postCheck({ updateUrl: "https://example.test/tags", fetchImpl: brokenJson, vendors: [] }),
    ).toMatchObject({ ok: false, error: "no_tags" })

    const serverError: typeof fetch = async () => new Response("boom", { status: 500 })
    expect(
      await postCheck({ updateUrl: "https://example.test/tags", fetchImpl: serverError, vendors: [] }),
    ).toMatchObject({ ok: false, error: "http_error", detail: "HTTP 500" })

    const network: typeof fetch = async () => {
      throw new Error("dns down")
    }
    expect(
      await postCheck({ updateUrl: "https://example.test/tags", fetchImpl: network, vendors: [] }),
    ).toMatchObject({ ok: false, error: "network", detail: "dns down" })

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "TimeoutError"
          reject(error)
        })
      })
    expect(
      await postCheck({
        updateUrl: "https://example.test/tags",
        fetchImpl: hanging,
        timeoutMs: 20,
        vendors: [],
      }),
    ).toMatchObject({ ok: false, error: "timeout" })

    const oversized: typeof fetch = async () =>
      new Response(JSON.stringify([{ name: `v1.0.0-${"x".repeat(4096)}` }]), { status: 200 })
    expect(
      await postCheck({
        updateUrl: "https://example.test/tags",
        fetchImpl: oversized,
        maxResponseBytes: 512,
        vendors: [],
      }),
    ).toMatchObject({ ok: false, error: "too_large" })

    let calls = 0
    const counted: typeof fetch = async () => {
      calls += 1
      return new Response("[]", { status: 200 })
    }
    expect(
      await postCheck({ updateUrl: "http://example.test/tags", fetchImpl: counted, vendors: [] }),
    ).toMatchObject({ ok: false, error: "invalid_url" })
    expect(
      await postCheck({ updateUrl: "not a url", fetchImpl: counted, vendors: [] }),
    ).toMatchObject({ ok: false, error: "invalid_url" })
    expect(calls).toBe(0) // 非 https 直接拒绝，绝不出网
  })

  it("adaptersOutdated 口径：Hub 落后→内置版落后的厂商；运行版落后于内置版→恒列入；已最新→不误报", async () => {
    const calls: string[] = []
    const tags = (tags: readonly unknown[]): typeof fetch => tagsFetch(calls, tags)
    const base = { updateUrl: "https://example.test/tags", vendors: ["dsh", "none"] }

    // Hub 落后（v99.0.0）：内置版 0.1.0 的 dsh 列入；无内置版的 none 不列入。
    const behind = await postCheck({ ...base, fetchImpl: tags([{ name: "v99.0.0" }]) })
    expect(behind.ok && behind.adaptersOutdated).toEqual(["dsh"])

    // 运行版落后于内置版：与「Hub 是否落后」无关，恒列入（缓存按源 URL 命中 → 先清）。
    clearUpdateCache()
    recordAdapterVersion("dsh", "0.0.1", 1)
    const stale = await postCheck({ ...base, fetchImpl: tags([{ name: "v0.0.1" }]) })
    expect(stale.ok && stale.adaptersOutdated).toEqual(["dsh"])

    // 已是最新（最新 tag = 当前版本）且运行版=内置版 → 不因「适配器与 Hub 不同号」误报。
    clearUpdateCache()
    const dshBundled = (await getVersion({ vendors: ["dsh"] })).adapters[0]?.bundledVersion
    if (dshBundled === null || dshBundled === undefined) throw new Error("dsh 的内置版本缺失")
    recordAdapterVersion("dsh", dshBundled, 2)
    const current = await postCheck({
      ...base,
      fetchImpl: tags([{ name: `v${PACKAGE_JSON.version}` }]),
    })
    expect(current.ok && current.adaptersOutdated).toEqual([])
  })

  it("数据源解析：`updateCheck.url`（config.json）< env `AGENTCHAT_UPDATE_URL` < 显式选项", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ updateCheck: { url: "https://file.test/tags" } }),
    )
    const saved = process.env["AGENTCHAT_UPDATE_URL"]
    delete process.env["AGENTCHAT_UPDATE_URL"]
    try {
      const fromFile = await postCheck({
        homeDir: home,
        fetchImpl: tagsFetch([], [{ name: "v99.0.0" }]),
        vendors: [],
      })
      expect(fromFile.ok && fromFile.source).toBe("https://file.test/tags")

      process.env["AGENTCHAT_UPDATE_URL"] = "https://env.test/tags"
      const fromEnv = await postCheck({
        homeDir: home,
        fetchImpl: tagsFetch([], [{ name: "v99.0.0" }]),
        vendors: [],
      })
      expect(fromEnv.ok && fromEnv.source).toBe("https://env.test/tags")

      const explicit = await postCheck({
        updateUrl: "https://explicit.test/tags",
        homeDir: home,
        fetchImpl: tagsFetch([], [{ name: "v99.0.0" }]),
        vendors: [],
      })
      expect(explicit.ok && explicit.source).toBe("https://explicit.test/tags")
    } finally {
      if (saved === undefined) delete process.env["AGENTCHAT_UPDATE_URL"]
      else process.env["AGENTCHAT_UPDATE_URL"] = saved
    }
  })
})

describe("semver 单源", () => {
  it("解析规则：容忍 v 前缀/build metadata，段数不足即不可解析", () => {
    expect(parseSemver("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0, prerelease: [] })
    expect(parseSemver("0.3.0-rc.1+build.5")).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
      prerelease: ["rc", "1"],
    })
    expect(parseSemver("1.2")).toBeUndefined()
    expect(parseSemver("latest")).toBeUndefined()
    expect(parseSemver(null)).toBeUndefined()
    expect(normalizeVersion("v0.2.0")).toBe("0.2.0")
    expect(normalizeVersion("nope")).toBeUndefined()
  })

  it("比较边界：数字段按数值、预发布 < 正式版、数字段 < 字母段", () => {
    expect(compareVersionStrings("0.10.0", "0.9.9")).toBe(1)
    expect(compareVersionStrings("v0.2.0", "0.2.0")).toBe(0)
    expect(compareVersionStrings("0.3.0-rc.1", "0.3.0")).toBe(-1)
    expect(compareVersionStrings("0.3.0-rc.2", "0.3.0-rc.10")).toBe(-1)
    expect(compareVersionStrings("0.3.0-alpha", "0.3.0-beta")).toBe(-1)
    expect(compareVersionStrings("0.3.0-1", "0.3.0-alpha")).toBe(-1)
    expect(compareVersionStrings("1.0.0+build", "1.0.0")).toBe(0)
    expect(compareVersionStrings("1.0.0", "not-a-version")).toBeUndefined()
  })

  it("compareSemver 直接比较解析结果", () => {
    const left = parseSemver("1.2.3")
    const right = parseSemver("1.3.0")
    if (left === undefined || right === undefined) throw new Error("解析失败")
    expect(compareSemver(left, right)).toBe(-1)
    expect(compareSemver(right, left)).toBe(1)
  })

  it("extractTags 支持三种形状；latestTag 取最高 semver 并忽略非 semver", () => {
    expect(extractTags([{ name: "v1.0.0" }, { tag_name: "v2.0.0" }, "v3.0.0", { nope: 1 }, 42])).toEqual([
      "v1.0.0",
      "v2.0.0",
      "v3.0.0",
    ])
    expect(extractTags({ message: "Not Found" })).toEqual([])
    expect(latestTag(["v0.1.0", "0.10.0", "garbage", "v0.9.9"])).toBe("0.10.0")
    expect(latestTag(["v1.0.0-rc.1", "v0.9.9"])).toBe("1.0.0-rc.1") // 预发布也比低号正式版新
    expect(latestTag(["v1.0.0-rc.1", "v1.0.0"])).toBe("1.0.0") // 同号正式版 > 预发布
    expect(latestTag([])).toBeUndefined()
    expect(latestTag([{ name: "v1.0.0" }])).toBeUndefined() // 非字符串条目不由 latestTag 处理
  })

  it("HUB_MANIFEST 与 package.json 同源", () => {
    expect(HUB_MANIFEST.name).toBe(PACKAGE_JSON.name)
    expect(HUB_MANIFEST.version).toBe(PACKAGE_JSON.version)
  })
})
