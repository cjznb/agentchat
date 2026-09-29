/**
 * Hub `config.json` 读写（OpenCode / Claude Code 两个安装器共用）：把本厂商 id 合并进 /
 * 移出 `<home>/config.json` 的 `adapters` 数组，让用户**无需再手动**设置 `AGENTCHAT_ADAPTERS`。
 *
 * - `home` = `AGENTCHAT_HOME`（空串视同未设）→ `~/.agentchat`；配置路径 `<home>/config.json`
 * - 文件不存在 → 安装时创建（含父目录）；幂等（重复安装内容等价）；保留其它键
 * - 非法 JSON / 顶层非对象 / `adapters` 非字符串数组 → 抛明确错误（拒绝覆盖用户数据）
 * - 写入沿用「备份 `<path>.bak` + 临时文件 + rename 原子替换」范式；`--dry-run` 由调用方只打印
 *
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Hub 数据目录：`AGENTCHAT_HOME`（非空）否则 `~/.agentchat`（与 Hub 一致）。 */
export function agentchatHome(env) {
  const home = env.AGENTCHAT_HOME
  return home !== undefined && home !== "" ? home : join(homedir(), ".agentchat")
}

/** `<home>/config.json`。 */
export function agentchatConfigPath(env) {
  return join(agentchatHome(env), "config.json")
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读取配置对象（缺失 → `{}`）；非法 JSON / 顶层非对象 → 抛清晰错误。 */
export function readAgentchatConfig(path) {
  if (!existsSync(path)) return {}
  let value
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`AgentChat 配置不是合法 JSON：${path}（${errorText(error)}）`)
  }
  if (!isRecord(value)) throw new Error(`AgentChat 配置顶层不是对象，拒绝改写：${path}`)
  return value
}

/** 现有 `adapters` 字段（缺失 → `[]`）；非字符串数组 → 抛清晰错误。 */
function currentAdapters(config, path) {
  const value = config.adapters
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`AgentChat 配置的 adapters 字段不是字符串数组，拒绝改写：${path}`)
  }
  return [...value]
}

/**
 * 安装：把 `vendor` 追加进 `adapters`（已存在则不变）；卸载：从 `adapters` 移除 `vendor`（保留其余）。
 * 保留其它键；**返回是否改动**（幂等 → `false`）。卸载而配置本不存在 → 不创建、无改动。
 */
export function applyVendor(config, path, vendor, uninstall) {
  const value = config.adapters
  if (uninstall && value === undefined) return false
  const list = currentAdapters(config, path)
  const next = uninstall
    ? list.filter((id) => id !== vendor)
    : list.includes(vendor)
      ? list
      : [...list, vendor]
  const changed = JSON.stringify(next) !== JSON.stringify(value === undefined ? null : value)
  if (!changed) return false
  config.adapters = next
  return true
}

/** 序列化为落盘/打印文本（2 空格缩进 + 末尾换行）。 */
export function serializeAgentchatConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** 备份 `<path>.bak`（若存在）+ 临时文件 + rename 原子替换；父目录缺失则创建。 */
export function writeAgentchatConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true })
  const text = serializeAgentchatConfig(config)
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
