/**
 * E2E 种子入口（Plan 3 终审 F7：文件本体只留 CLI + re-export，构造器拆到 `seed/`）——
 * 规格文件继续 `import { seedBase } from "./seed"`（路径不变）；`seed/base.ts` 提供细粒度
 * 构造器，`seed/experience.ts` 提供完整体验数据。
 *
 * 独立运行：`npx tsx tests/e2e/seed.ts`（临时 home，或 `AGENTCHAT_HOME` 指定）→ 打印摘要 JSON。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../../server/config"
import { openDb } from "../../server/db"
import { seedExperience, type ExperienceSummary } from "./seed/experience"

export * from "./seed/base"
export * from "./seed/experience"

/** CLI 入口：临时 home（或 `AGENTCHAT_HOME`）生成完整体验数据并打印摘要。 */
export function runSeedCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperienceSummary & { readonly home: string } {
  const configured = env["AGENTCHAT_HOME"]
  // 无显式 home 时落一次性临时目录；用后清理，避免 `agentchat-seed-*` 目录泄漏。
  // 摘要中的 `home` 仍报告本次所用路径（即便临时目录已在 finally 清除）。
  const ephemeral = configured === undefined
  const home = configured ?? mkdtempSync(join(tmpdir(), "agentchat-seed-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  try {
    return { home, ...seedExperience(db, home) }
  } finally {
    db.close()
    if (ephemeral) rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runSeedCli(), null, 2))
}
