/**
 * 端口与路径配置（spec/计划锁定值的唯一来源）。
 *
 * - 端口：默认 4646，env `AGENTCHAT_PORT` 覆盖
 * - 数据目录：env `AGENTCHAT_HOME`，默认 `~/.agentchat`
 * - DB = `<home>/agentchat.db`；HUB_TOKEN = `<home>/hub_token`
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

export const DEFAULT_PORT = 4646

const portSchema = z.coerce.number().int().min(0).max(65535)

export interface HubConfig {
  readonly port: number
  readonly home: string
  readonly dbPath: string
  readonly hubTokenPath: string
}

/** 从环境变量解析配置；env 是外部输入，边界处用 zod 一次解析成类型化值。 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HubConfig {
  const home = env["AGENTCHAT_HOME"] ?? join(homedir(), ".agentchat")
  const port = portSchema.parse(env["AGENTCHAT_PORT"] ?? DEFAULT_PORT)
  return {
    port,
    home,
    dbPath: join(home, "agentchat.db"),
    hubTokenPath: join(home, "hub_token"),
  }
}

/** 进程默认配置（import 时按当前环境解析）。测试覆盖请用 `loadConfig(customEnv)`。 */
export const config: HubConfig = loadConfig()
