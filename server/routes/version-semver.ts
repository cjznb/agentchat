/**
 * semver 与 tag/release 解析（U1/task-16 的**单源**实现，供 `version.ts` 与 `version-check.ts` 复用）。
 *
 * 本模块纯计算、无 IO：Hub 版本比对、适配器落后判定、远端 tag 取最高版本都走这里，
 * 避免「同一份 semver 规则写两遍」。规则：容忍 `v` 前缀与 build metadata；
 * 预发布 `<` 同号正式版；预发布段内数字段 `<` 字母段、段数少者更小。
 */

export interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析 semver；不可解析（含 null/undefined）→ undefined。 */
export function parseSemver(raw: string | null | undefined): Semver | undefined {
  if (raw === null || raw === undefined) return undefined
  const match = SEMVER.exec(raw.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  }
}

/** `v0.2.0` → `0.2.0`（不可解析 → undefined）。 */
export function normalizeVersion(raw: string): string | undefined {
  return parseSemver(raw) === undefined ? undefined : raw.trim().replace(/^v/i, "")
}

/** 预发布段比较：空段 = 正式版（更大）；数字 < 字母；前缀相同则段数少者更小。 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNum = /^\d+$/.test(a) ? Number(a) : undefined
    const bNum = /^\d+$/.test(b) ? Number(b) : undefined
    if (aNum !== undefined && bNum !== undefined) {
      if (aNum !== bNum) return aNum < bNum ? -1 : 1
      continue
    }
    if (aNum !== undefined) return -1
    if (bNum !== undefined) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

export function compareSemver(left: Semver, right: Semver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** 版本字符串比较（任一侧不可解析 → undefined）。 */
export function compareVersionStrings(left: string, right: string): number | undefined {
  const a = parseSemver(left)
  const b = parseSemver(right)
  return a === undefined || b === undefined ? undefined : compareSemver(a, b)
}

/** tag/release 条目集合 → 最高的 semver（规范化去 `v`）；无可用条目 → undefined。 */
export function latestTag(rawTags: readonly unknown[]): string | undefined {
  let best: { readonly tag: string; readonly value: Semver } | undefined
  for (const raw of rawTags) {
    if (typeof raw !== "string") continue
    const tag = normalizeVersion(raw)
    const value = tag === undefined ? undefined : parseSemver(tag)
    if (tag === undefined || value === undefined) continue
    if (best === undefined || compareSemver(value, best.value) > 0) best = { tag, value }
  }
  return best?.tag
}

/** 解析 tags/releases 响应体：字符串数组、`{name}`（GitHub /tags）、`{tag_name}`（/releases）。 */
export function extractTags(payload: unknown): string[] {
  if (!Array.isArray(payload)) return []
  const tags: string[] = []
  for (const entry of payload) {
    if (typeof entry === "string") {
      tags.push(entry)
      continue
    }
    if (entry === null || typeof entry !== "object") continue
    const record = entry as { tag_name?: unknown; name?: unknown }
    const tag = record.tag_name ?? record.name
    if (typeof tag === "string" && tag !== "") tags.push(tag)
  }
  return tags
}
