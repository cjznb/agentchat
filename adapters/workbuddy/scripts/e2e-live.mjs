#!/usr/bin/env node
/**
 * 真机 E2E 冒烟脚本（需要一个**正在运行的 Hub**）。不属于 `npm test`（不联网单测见 `__tests__/`）。
 *
 * 用法：
 *   node adapters/workbuddy/scripts/e2e-live.mjs [--session <id>] [--cwd <path>] [--keep]
 *
 * 验证链条（每一步都有断言，失败即退出码 1）：
 *   1. `SessionStart` hook → Hub `/api/roster` 出现 `workbuddy@<host>` 容器 + 会话节点；
 *   2. 用探针 agent 经**真 MCP** `send` 一条消息给会话节点；
 *   3. `Stop` hook → stdout 必须是 `{continue:false, stopReason:…}` 且正文含该 messageId；
 *   4. 立刻再跑一次 `Stop` → stdout **为空**（租约重投去重，绝不重复注入）；
 *   5. `PreToolUse` hook → `modifiedInput` 含 `x-agentchat-session`，且原字段一个不少。
 *
 * `--keep` 保留临时探针 agent（默认保留，避免反复注册雷同名；用 `--fresh` 清掉重建）。
 */
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hubConfig, mcpCall, mcpRegister } from "../lib/hub.mjs"
import { adapterPaths, resolveHome } from "../lib/paths.mjs"
import { sessionNodeName } from "../lib/register.mjs"
import { readJson, readText, removeFile, writeText } from "../lib/token.mjs"
import { SESSION_ARG } from "../lib/session-hint.mjs"

const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const NODE = process.execPath

function parseArgs(argv) {
  const args = { session: "session-e2e-0001-0002-0003-0004", cwd: ADAPTER_DIR, fresh: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--fresh") args.fresh = true
    else if (argv[i] === "--session") args.session = argv[++i]
    else if (argv[i] === "--cwd") args.cwd = argv[++i]
  }
  return args
}

/** 以真实子进程运行一个 hook，stdin 喂 payload，返回 stdout/stderr/退出码。 */
function runHook(script, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [join(ADAPTER_DIR, "hooks", script)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}\n`)
}

/** 按插件清单里声明的方式拉起 MCP 桥（stdio JSON-RPC）。 */
function spawnBridge(env) {
  const child = spawn(NODE, [join(ADAPTER_DIR, "mcp-bridge.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const lines = []
  let buffer = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === "") continue
      try {
        lines.push(JSON.parse(line))
      } catch {
        lines.push({ parseError: line.slice(0, 200) })
      }
    }
  })
  child.stderr.on("data", () => undefined)
  return { child, lines, send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`) }
}

/** 等某 id 的 JSON-RPC 回复（轮询已收到的行；超时 → `undefined`）。 */
async function waitFor(lines, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = lines.find((line) => line.id === id)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

async function fetchRoster(config) {
  const response = await fetch(`${config.baseUrl}/api/roster`, {
    headers: { authorization: `Bearer ${config.token}` },
  })
  return response.json()
}

function findWorkbuddy(roster) {
  return roster.find((agent) => agent.vendor === "workbuddy" && agent.role_tag === "container" && agent.status !== "retired")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = { ...process.env }
  const home = resolveHome(env)
  const paths = adapterPaths(home)
  const config = hubConfig(env, home)
  if (config.token === "") {
    process.stderr.write(`[e2e] 读不到 Hub token（${home}/hub_token）；请先启动 Hub\n`)
    return 1
  }
  const hookEnv = { AGENTCHAT_HOME: home }

  // ── 1. SessionStart ────────────────────────────────────────────────
  await runHook("session-start.mjs", { session_id: args.session, cwd: args.cwd, hook_event_name: "SessionStart", source: "startup" }, hookEnv)
  const roster = await fetchRoster(config)
  const container = findWorkbuddy(roster)
  check("SessionStart → roster 出现 workbuddy 容器节点", container !== undefined)
  if (container === undefined) return report()
  const expectedName = sessionNodeName(args.cwd, args.session)
  const sessionNode = container.children.find((child) => child.name === expectedName)
  check("SessionStart → 容器下有本会话节点", sessionNode !== undefined, `期望 "${expectedName}"，实际 ${JSON.stringify(container.children.map((c) => c.name))}`)
  if (sessionNode === undefined) return report()
  const ledger = readJson(paths.sessions)
  check("SessionStart → 会话节点状态为 online", sessionNode.status === "online")
  check("SessionStart → 本地台账已登记该会话", ledger !== undefined && ledger[args.session] !== undefined)

  // ── 2. 探针 agent 经真 MCP send ────────────────────────────────────
  const probeTokenPath = join(home, "agents", "workbuddy-e2e.token")
  if (args.fresh) removeFile(probeTokenPath)
  const existing = readText(probeTokenPath)
  const rootArgs = existing === undefined
    ? { vendor: "workbuddy-e2e", purpose: "coding-agent", name: `workbuddy-e2e@${process.env.COMPUTERNAME ?? "host"}`, role_tag: "container" }
    : { vendor: "workbuddy-e2e", purpose: "coding-agent", name: `workbuddy-e2e@${process.env.COMPUTERNAME ?? "host"}`, role_tag: "container", join_token: existing }
  const probe = await mcpRegister(config, rootArgs, "agentchat-workbuddy-e2e")
  if (probe.joinToken !== undefined) writeText(probeTokenPath, probe.joinToken)
  const body = `[e2e] 你好，这是一条来自探针的测试消息 ${new Date().toISOString()}`
  const sent = await mcpCall(config, "send", { to: sessionNode.id, body }, probe.agentId)
  check("MCP send → 消息已受理", sent !== undefined && sent.message !== undefined, JSON.stringify(sent).slice(0, 200))
  const messageId = sent?.message?.id

  // ── 3. Stop hook 注入 ──────────────────────────────────────────────
  const stopPayload = { session_id: args.session, cwd: args.cwd, hook_event_name: "Stop", stop_hook_active: false }
  const first = await runHook("stop.mjs", stopPayload, hookEnv)
  let parsed
  try {
    parsed = JSON.parse(first.stdout.trim())
  } catch {
    parsed = undefined
  }
  check("Stop → stdout 是合法 hook JSON", parsed !== undefined, first.stdout.slice(0, 200) || first.stderr.slice(0, 200))
  check("Stop → continue:false（阻止停止并继续对话）", parsed?.continue === false)
  check("Stop → stopReason 与 additionalContext 双通道同文", parsed?.stopReason === parsed?.hookSpecificOutput?.additionalContext)
  check("Stop → 正文含 messageId", typeof messageId === "string" && String(parsed?.stopReason).includes(messageId), `messageId=${messageId}`)
  check("Stop → 退出码 0", first.code === 0)

  // ── 4. 二次取件不重投 ──────────────────────────────────────────────
  const second = await runHook("stop.mjs", { ...stopPayload, stop_hook_active: true }, hookEnv)
  check("Stop 二次 → 不重复注入（去重集合生效）", second.stdout.trim() === "", second.stdout.slice(0, 200))

  // ── 5. PreToolUse 逐会话身份 ───────────────────────────────────────
  const toolInput = { to: sessionNode.id, body: "hi" }
  const pre = await runHook("pre-tool-use.mjs", {
    session_id: args.session,
    cwd: args.cwd,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agentchat__send",
    tool_input: toolInput,
  }, hookEnv)
  let preJson
  try {
    preJson = JSON.parse(pre.stdout.trim())
  } catch {
    preJson = undefined
  }
  const modified = preJson?.hookSpecificOutput?.modifiedInput
  check("PreToolUse → 输出 modifiedInput", modified !== undefined, pre.stdout.slice(0, 200))
  check("PreToolUse → 注入会话提示", modified?.[SESSION_ARG] === args.session)
  check("PreToolUse → 原字段未被破坏", modified?.to === toolInput.to && modified?.body === toolInput.body)
  check("PreToolUse → permissionDecision=allow（不误 block）", preJson?.hookSpecificOutput?.permissionDecision === "allow")

  // 非本适配器工具 → 必须静默
  const foreign = await runHook("pre-tool-use.mjs", {
    session_id: args.session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" },
  }, hookEnv)
  check("PreToolUse → 非本适配器工具静默（不触碰用户其它工具）", foreign.stdout.trim() === "")

  // ── 6. MCP 桥：剥离会话提示 + 出站身份落在**会话节点** ────────────────
  const target = await mcpCall(config, "register", {
    vendor: "workbuddy-e2e",
    parent_ref: probe.agentId,
    task_ref: "e2e-target",
    name: `e2e-target@${process.env.COMPUTERNAME ?? "host"}`,
  }, probe.agentId)
  const bridge = spawnBridge(hookEnv)
  try {
    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-host", version: "0" } } })
    await waitFor(bridge.lines, 1, 8000)
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    bridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "send", arguments: { to: target.agent.id, body: "[e2e] via bridge", [SESSION_ARG]: args.session } },
    })
    const reply = await waitFor(bridge.lines, 2, 8000)
    const payload = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}")
    check("MCP 桥 → tools/call 成功（会话提示已被剥离，未撞 Hub 入参校验）", reply?.error === undefined, JSON.stringify(reply?.error ?? {}).slice(0, 200))
    check("MCP 桥 → 出站身份 = 会话节点（不是实例容器）", payload?.message?.fromAgentId === sessionNode.id, `from=${payload?.message?.fromAgentId} 期望=${sessionNode.id}`)
  } finally {
    bridge.child.kill()
  }

  return report()
}

function report() {
  const failed = results.filter((item) => !item.ok)
  process.stdout.write(`\n[e2e] ${results.length - failed.length}/${results.length} 项通过\n`)
  return failed.length === 0 ? 0 : 1
}

process.exitCode = await main()
