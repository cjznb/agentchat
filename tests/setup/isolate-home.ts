/**
 * 全局测试隔离：把 `AGENTCHAT_HOME` 指向一次性临时目录（每个测试文件一份，退出时清理）。
 *
 * 为什么必须：
 * - `server/config.ts` 导出的 `config` 在**导入期**求值一次。若开发机存在真实
 *   `~/.agentchat/config.json`（例如安装器写过 `adapters: ["opencode"]`），它会被读进
 *   `config.adapters` 并渗进所有用例 —— 曾导致 `loadConfig({}).adapters` 非空、以及
 *   bootstrap 的"启动警告"用例失败（本机全绿、CI 假绿的反向情形）。
 * - 同时确保任何用例都**不会读写用户真实数据目录**（`~/.agentchat`）。
 *
 * 用例若需要自定义 home，仍应显式传 `AGENTCHAT_HOME`（`loadConfig({ AGENTCHAT_HOME: … })`）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

const existing = process.env["AGENTCHAT_HOME"]
const isolated = existing === undefined || existing === "" ? mkdtempSync(join(tmpdir(), "agentchat-test-home-")) : undefined

if (isolated !== undefined) {
  process.env["AGENTCHAT_HOME"] = isolated
  afterAll(() => rmSync(isolated, { recursive: true, force: true }))
}
