/**
 * DSH 安装器的**副作用层**：唯一真正动盘的地方——mkdir、`<file>.bak` 备份、
 * 临时文件 + rename 原子替换、symlink 建立/摘除。
 *
 * 分层（见 `install.mjs` 头部总览）：`install-yaml.mjs` / `install-plan.mjs` = 纯规划；
 * 本模块 = 副作用 + dry-run 判定；`install.mjs` = CLI + 公开再导出。
 *
 * 安全：摘除联结只对**链接本身**下手（`unlink` → `rmdir` 兜底），绝不用 `rmSync(..., { recursive: true })`
 * ——本机环境下它会穿透联接删掉目标内容。纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { writeAgentchatConfig } from "../agentchat-config.mjs"

/**
 * @typedef {object} PlannedAction
 * @property {string} kind `link` | `unlink` | `write` | `delete`
 * @property {string} path
 * @property {boolean} changed 本次是否真的动了盘（幂等时为 `false`）
 * @property {string} [target] 联结目标
 * @property {string} [type] 联结类型
 * @property {boolean} [backup] 是否写了 `<path>.bak`
 * @property {string} [note]
 */

/** 路径比较用规范化：去 `\\?\` 前缀、去尾部分隔符、`resolve`、win32 折叠大小写。 */
export function normalizePathForCompare(path) {
  const stripped = path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "")
  const resolved = resolve(stripped)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** 两侧都走 OS realpath（Windows 目录联接只有 `realpath.native` 认得出来）。 */
function sameTarget(a, b) {
  let na = a
  let nb = b
  try {
    na = realpathSync.native(a)
  } catch {
    /* 目标可能尚不存在：退回字面比较 */
  }
  try {
    nb = realpathSync.native(b)
  } catch {
    /* 同上 */
  }
  return normalizePathForCompare(na) === normalizePathForCompare(nb)
}

/**
 * 判断联结路径的现状。
 *
 * 注意：某些 Windows 环境（含本机）`lstat` 把目录联接报成普通目录、`readlink` 直接 EINVAL，
 * 于是这里补一条 `realpath.native` 兜底——它能解析出真实目标，据此判定"这是一个指向别处的联结"。
 */
function linkState(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { exists: false, link: false, target: undefined }
  }
  let target
  if (stat.isSymbolicLink()) {
    try {
      target = readlinkSync(path)
    } catch {
      target = undefined
    }
  }
  if (target === undefined) {
    try {
      const real = realpathSync.native(path)
      if (normalizePathForCompare(real) !== normalizePathForCompare(path)) target = real
    } catch {
      /* 忽略：拿不到就当普通目录 */
    }
  }
  return { exists: true, link: target !== undefined, target }
}

/**
 * 摘掉一个目录联接/符号链接。
 *
 * 只对**链接本身**下手：先 `unlink`（POSIX 符号链接），失败再 `rmdir`（Windows 目录联接——
 * `RemoveDirectoryW` 只删重解析点、不会删目标内容；对非空真实目录会 ENOTEMPTY，正好保护用户数据）。
 * 绝不用 `rmSync(..., { recursive: true })`：本机环境下它会**穿透联接删掉目标内容**。
 */
function removeLink(path) {
  try {
    unlinkSync(path)
  } catch {
    rmdirSync(path)
  }
}

/**
 * 落盘一份规划文件（`dryRun` 时只算不写）。
 *
 * @param {import("./install-plan.mjs").PlannedFile} file
 * @param {boolean} dryRun
 * @returns {PlannedAction}
 */
function applyFile(file, dryRun) {
  if (file.change !== true) {
    return { kind: "file", path: file.path, changed: false, note: "已是最新" }
  }
  if (file.content === null) {
    if (!dryRun) rmSync(file.path, { force: true })
    return { kind: "delete", path: file.path, changed: true }
  }
  if (file.kind === "agentchat") {
    if (dryRun) return { kind: "write", path: file.path, changed: true, backup: file.existed }
    const { backedUp } = writeAgentchatConfig(file.path, file.value)
    return { kind: "write", path: file.path, changed: true, backup: backedUp }
  }
  if (!dryRun) {
    mkdirSync(dirname(file.path), { recursive: true })
    if (file.existed) copyFileSync(file.path, `${file.path}.bak`)
    const tmp = `${file.path}.tmp-${process.pid}`
    writeFileSync(tmp, file.content)
    renameSync(tmp, file.path)
  }
  return { kind: "write", path: file.path, changed: true, backup: file.existed }
}

/**
 * 建立一份规划联结（`dryRun` 时只算不写；路径被实体目录占着 → 拒绝覆盖）。
 *
 * @param {import("./install-plan.mjs").PlannedLink} link
 * @param {boolean} dryRun
 * @returns {PlannedAction}
 */
function applyLink(link, dryRun) {
  const state = linkState(link.path)
  if (state.exists && state.link && state.target !== undefined && sameTarget(state.target, link.target)) {
    return { kind: "link", path: link.path, target: link.target, type: link.type, changed: false }
  }
  if (state.exists && !state.link) {
    throw new Error(`联结路径已存在且不是符号链接/目录联接，拒绝覆盖：${link.path}`)
  }
  if (!dryRun) {
    mkdirSync(dirname(link.path), { recursive: true })
    if (state.exists) removeLink(link.path)
    symlinkSync(link.target, link.path, link.type)
  }
  return { kind: "link", path: link.path, target: link.target, type: link.type, changed: true }
}

/**
 * 摘除一份规划联结（`dryRun` 时只算不写；实体目录一律保留）。
 *
 * @param {{path: string}} item
 * @param {boolean} dryRun
 * @returns {PlannedAction}
 */
function applyUnlink(item, dryRun) {
  const state = linkState(item.path)
  if (!state.exists) return { kind: "unlink", path: item.path, changed: false }
  if (!state.link) {
    return {
      kind: "unlink",
      path: item.path,
      changed: false,
      note: "该路径不是符号链接/目录联接（可能是 pnpm 铺开的实体目录），已保留",
    }
  }
  if (!dryRun) removeLink(item.path)
  return { kind: "unlink", path: item.path, changed: true }
}

/**
 * 落盘：mkdir / `<file>.bak` 备份 / 临时文件 + rename 原子替换 / symlink。
 * `dryRun === true` 时**只计算不落盘**（返回"本来会做什么"）。
 *
 * 顺序：先建联结（bundle 必须先可解析），再写文件（manifest 才敢声明这个依赖），最后摘联结（卸载）。
 *
 * @param {import("./install-plan.mjs").Plan} plan
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ dryRun: boolean, actions: PlannedAction[] }}
 */
export function applyPlan(plan, options = {}) {
  const dryRun = options.dryRun === true
  const actions = []
  for (const link of plan.links ?? []) actions.push(applyLink(link, dryRun))
  for (const file of plan.files ?? []) actions.push(applyFile(file, dryRun))
  for (const item of plan.unlinks ?? []) actions.push(applyUnlink(item, dryRun))
  return { dryRun, actions }
}

/**
 * 只读判定"这份计划到底会不会动盘"（`--dry-run` 摘要用；不落盘、不抛"拒绝覆盖"）。
 *
 * 为什么不能只看条目是否存在：安装计划**恒带一条联结**、卸载计划**恒带一条 unlink**，它们只表示
 * "要保证的结果"，不代表现状需要改——联结已指向同一目标、或联结本就不存在时，这份计划其实是 no-op。
 * 这里按副作用层的判定口径逐条复算（联结已就绪 → 不算改动）。
 *
 * @param {import("./install-plan.mjs").Plan} plan
 * @returns {boolean}
 */
export function planHasChanges(plan) {
  if ((plan.files ?? []).some((file) => file.change)) return true
  for (const link of plan.links ?? []) {
    const state = linkState(link.path)
    // 路径被实体目录占着：applyLink 会明确拒绝（报错），绝不能报成"无改动"。
    if (!state.exists || !state.link) return true
    if (state.target === undefined || !sameTarget(state.target, link.target)) return true
  }
  for (const item of plan.unlinks ?? []) {
    const state = linkState(item.path)
    if (state.exists && state.link) return true
  }
  return false
}
