/**
 * 安装器的 IO 层：备份 + 原子替换 + **字节级还原**。
 *
 * 两条硬要求（指南 §8）：
 * 1. 备份 `<path>.agentchat.bak`（**只保留首次安装前的原始字节**，后续安装不覆盖它）+ 临时文件
 *    + `rename` 原子替换；
 * 2. `--uninstall` 后**字节级还原**：若当前内容与本安装器"只加了自己那几个键"的预期一致
 *    （说明用户没在期间手改过），则直接写回 `.agentchat.bak` 的**原始字节**；否则退化为
 *    "精确移除自己那几个键"并**明确告警**（绝不静默损毁用户改动）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isRecord } from "./lib/util.mjs"

/** 备份后缀（与本仓其它适配器的 `.bak` 区分，避免互相覆盖）。 */
export const BACKUP_SUFFIX = ".agentchat.bak"

export function backupPath(path) {
  return `${path}${BACKUP_SUFFIX}`
}

export function exists(path) {
  return existsSync(path)
}

/** 读文本；不存在 → `undefined`。 */
export function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

/**
 * 读 JSON 对象并保留**原始字节**（供字节级还原）。不存在 → `undefined`。
 * 非法 JSON / 顶层非对象 → 抛明确错误（拒绝覆盖用户数据）。
 */
export function readJsonWithBytes(path, label) {
  if (!existsSync(path)) return undefined
  const bytes = readFileSync(path, "utf8")
  let value
  try {
    value = JSON.parse(bytes)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!isRecord(value)) throw new Error(`${label} 顶层不是对象，拒绝改写：${path}`)
  return { value, bytes }
}

/** 序列化（2 空格缩进 + 末尾换行；与本仓其它安装器一致）。 */
export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 原子替换：临时文件 + `rename`；必要时创建父目录。 */
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/**
 * 提交 JSON：**首次**写入时把原始字节存到 `<path>.agentchat.bak`（已存在则不覆盖，
 * 保留"第一次安装前"的真相），再原子写入。
 */
export function commitJson(path, value) {
  const bak = backupPath(path)
  if (existsSync(path) && !existsSync(bak)) writeFileSync(bak, readFileSync(path))
  atomicWrite(path, serialize(value))
}

/**
 * 读原始字节（供字节级还原）；不存在 → `undefined`。
 */
export function readRaw(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

/** 删除备份文件（卸载收尾：确认还原成功后不再留垃圾）。 */
export function dropBackup(path) {
  const bak = backupPath(path)
  if (existsSync(bak)) rmSync(bak, { force: true })
}

/** 「本安装器创建了该文件」标记：`.bak` 只有原文件已存在时才写，故新建场景靠本标记区分。 */
export function createdMarker(path) {
  return `${path}.agentchat.created`
}

export function markCreated(path) {
  const marker = createdMarker(path)
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

export function wasCreatedByUs(path) {
  return existsSync(createdMarker(path))
}

export function clearCreated(path) {
  const marker = createdMarker(path)
  if (existsSync(marker)) rmSync(marker, { force: true })
}

/** 删除文件（仅用于卸载时清掉"本安装器创建、且已无内容"的 JSON）。 */
export function removeFileIfExists(path) {
  if (existsSync(path)) rmSync(path, { force: true })
}

/** 目录树复制（`force:false` 时目标已存在则报错，避免误覆盖）。 */
export function copyTree(from, to, options = {}) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, force: options.force !== false, dereference: true })
}

/** 递归删除目录（只用于本安装器自己创建的市场目录 / 安装目录）。 */
export function removeTree(path) {
  rmSync(path, { recursive: true, force: true })
}
