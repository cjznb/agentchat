# 升级与修复操作手册（从旧版 → 含 P1–P7 的新版本）

> 适用场景：你已经在跑旧版（Hub + DSH 适配器），本次要升到包含以下修复的版本：
> 假 delivered（P1）、取件页饥饿（P2）、忙时取件 + `steer` 边界交付（P3）、工具可发现性（P4）、
> 容器语义（P5）、紧急度（P6）、身份根治（P7）、版本检查（U1）、身份遗留修复脚本（U2）。
>
> **顺序不能乱**：先备份 → 再升级代码 → 重装适配器 → 停 Hub 跑修复 → 起 Hub → 重启 DSH → 验证。
> 任何一步失败都可以回滚（见 §7）。

## 0. 升级前的现状认知（为什么必须做这一步）

| 旧行为 | 新版本后 |
|---|---|
| 多个 DSH 会话共用**容器身份** `dsh@<host>` 出站（`dsh.current` 只在"恰好 1 个顶层会话"时存在） | 每个会话**恒用自己的会话节点**（逐调用身份）；桥在无法确定身份时**显式报 `identity_required`**，不再冒名 |
| 工具面走 MCP 桥（进程级单身份） | **原生工具面**（`ctx.tools.register`，逐调用身份）默认开启；安装器默认**不再写 MCP 桥行**（可用 `--with-mcp-bridge` 显式开启） |
| 忙时完全收不到（只在 idle 才取件） | 忙时也取件，`steer` 在最近 step 边界交付；`low/normal/urgent` 三档 + 配额护栏 |
| 容器可被拉进群、可发言 | 容器不可入群 / 不可发送 / 不可作 DM 收件方；前端勾选框不可勾选 |
| 消息可能永久 pending（>50 条） | 认领页可推进，取空为止 |
| 无版本面 | `GET /api/version`、`POST /api/version/check`、`node bin/agentchat.mjs --check-update` |

## 1. 准备

```powershell
cd D:\projects\agent\agentchat
git status                 # 确认没有你不想带上的未提交改动
node -v                    # 需要 >= 22
```

**先检查有没有更新**（可选，需要网络）：

```powershell
node bin/agentchat.mjs --check-update
# 退出码：0=已最新 / 1=有更新 / 2=检查失败（Hub 未运行也会 2，属正常）
```

## 2. 停服

```powershell
# 2.1 停 Hub（当前 PID 见 .artifacts/hub-run/hub.pid）
$pidFile = 'D:\projects\agent\.artifacts\hub-run\hub.pid'
if (Test-Path $pidFile) { Stop-Process -Id (Get-Content $pidFile) -Force }
# 或按端口找：
Get-NetTCPConnection -State Listen -LocalPort 4646 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 2.2 退出 DSH（宿主进程持有旧插件代码；不重启不会加载新代码）
#     —— 用 DSH 自带退出，或托盘退出。
```

## 3. 更新代码与依赖

```powershell
cd D:\projects\agent\agentchat
git pull --ff-only
npm install
npm run build          # 重建前端（Hub 服务于 client/dist）
npm run typecheck      # 期望 exit 0
npx vitest run         # 期望全绿（含 ~572+ 用例与 3 条 it.fails 中已翻转的项）
```

> 若 `git pull` 从分支切到 master：确认在 `master` 或你指定的发布分支/标签（`git tag -l` 看 `v0.x.y`）。

## 4. 重装 DSH 适配器（**本次必须做**）

新版本默认切换工具面，旧安装里仍有 MCP 桥行 → 不重装会出现**两套工具**。

```powershell
cd D:\projects\agent\agentchat\adapters\dsh
node install.mjs            # 或你的安装入口；先 --help 看参数
# 若你的 DSH 版本没有原生工具服务（极少见），安装时加：--with-mcp-bridge
```

重装后确认 DSH profile 的 patch 层里：
- 有 `@agentchat/dsh-adapter` 行（插件本身）；
- **没有** MCP 桥行（除非你显式 `--with-mcp-bridge`）。

## 5. 修复历史数据（**停 Hub 状态下**）

旧版已经产生的"容器署名"数据需要一次性清理（新代码只防新增）。

```powershell
cd D:\projects\agent\agentchat
$hubHome = "$env:USERPROFILE\.agentchat"

# 5.1 预演：只读，零写入。看清要改什么再动手
node bin/repair-identity.mjs --home $hubHome

# 5.2 执行（先自动 VACUUM INTO 快照到 <home>.bak-identity-<时间戳>\）
node bin/repair-identity.mjs --home $hubHome --apply

# 5.3 自检：应输出"干净"且 exit=0
node bin/repair-identity.mjs --home $hubHome --check
```

它会做（都是无损的）：
- 删掉**容器**的 `participants` / `read_states` / `wake_jobs` 行（容器永不可收件）；
- 给容器署名的历史消息打标注 `meta.legacy_identity="container"`（**正文不动**），供 UI 显示"历史：身份未区分"；
- 保留容器 `agents`/`agent_keys` 行（层级与注册还要用）；
- 报告"清掉容器后只剩一人的 DM"（会话与历史保留）。

**不会做**：删除任何消息、反推历史误归属（无法自动修，只报告）、修改 `agents/dsh.current` 等运行时文件。

## 6. 启动与验证

```powershell
# 6.1 起 Hub（真实数据目录；不要开 AGENTCHAT_TEST_API）
$env:AGENTCHAT_HOME = "$env:USERPROFILE\.agentchat"
$env:AGENTCHAT_NO_OPEN = '1'
Start-Process -FilePath 'npx.cmd' -ArgumentList 'tsx','server/main.ts' -WorkingDirectory 'D:\projects\agent\agentchat' `
  -RedirectStandardOutput 'D:\projects\agent\.artifacts\hub-run\hub-out.log' `
  -RedirectStandardError  'D:\projects\agent\.artifacts\hub-run\hub-err.log' -WindowStyle Hidden

# 6.2 健康与版本
Invoke-RestMethod http://127.0.0.1:4646/api/health        # {"status":"ok"}
Invoke-RestMethod http://127.0.0.1:4646/api/version       # 含 hub.version 与各适配器 bundledVersion

# 6.3 启动 DSH，让会话注册；看适配器日志
Get-Content "$env:USERPROFILE\.agentchat\logs\dsh-adapter.log" -Tail 20
#   期望：不再出现「实例节点注册失败」；出现「会话提示 = <会话节点>」或（≥2 顶层会话时）明确的
#   「出站身份缺失 → 本次不带 x-agent-id」告警，而不是「出站身份 …（取自 …agents\dsh.id）」
```

**功能验证（真机）**：

| 项 | 怎么看 |
|---|---|
| 身份 | 在群/DM 里让某个会话发言，`from_agent_id` 应是**该会话节点**，不是 `dsh@<host>` |
| 忙时到达 | 给正在跑长任务的会话发消息，应在下一 step 边界出现（Hub `wake_jobs` 不应长期 `pending`） |
| 工具可发现性 | 问 agent「群聊怎么发言 / 容器能不能发 / 你第一步该干什么」，应答对（清单见 `docs/test-plan-dsh.md` §S12） |
| 紧急度 | `send{urgency:"urgent"}` 的消息 `message_status` 带 urgency；忙时应插队 |
| 版本面 | 设置页「版本与更新」卡片 / `--check-update` |

**离线回归（不需要 LLM）**：

```powershell
cd D:\projects\agent\agentchat
node adapters/test/cli.mjs --scenario all --spawn     # 期望 9/9 PASS，exit 0
npx vitest run adapters/test/__tests__ tests/integration tests/unit
node adapters/test/cli.mjs --scenario all --spawn     # 再跑一次确认稳定
```

### 6.1 让 Hub 持久运行（**必须**：否则 DSH 退出会把 Hub 一起带走）

DSH 会把它启动过的进程树一并结束。**从 DSH 会话里起的 Hub，在 DSH 退出时会被杀掉**（实测：
Hub 明明 `health 200`，DSH 一退就"连接被拒"）。要脱离该进程树，用 Windows 计划任务拉起
（父进程是 `svchost/services`，与 DSH 无关）：

```powershell
# 启动器（放在仓库外，路径按需改）
$script = 'D:\projects\agent\.artifacts\start-hub.ps1'   # 内容见下
$pwsh = (Get-Command pwsh.exe).Source
$action  = New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -WindowStyle Hidden -File "' + $script + '"')
$trigger = @(
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(5)),
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME")   # 登录自动起
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'AgentChatHub' -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName 'AgentChatHub'

# 状态 / 停止 / 删除
Get-ScheduledTask -TaskName 'AgentChatHub' | Select-Object TaskName, State
Stop-ScheduledTask -TaskName 'AgentChatHub'
Unregister-ScheduledTask -TaskName 'AgentChatHub' -Confirm:$false
```

启动器内容要点：设 `AGENTCHAT_HOME=~\.agentchat`、`AGENTCHAT_NO_OPEN=1`、**不设** `AGENTCHAT_TEST_API`，
然后 `node node_modules/tsx/dist/cli.mjs server/main.ts`，stdout/stderr 追加到
`.artifacts\hub-run\hub.log`。

验证脱离成功：

```powershell
# 上游应是 svchost/services，而不是 dsh/electron/pwsh(由 DSH 启动)
$pid0 = (Get-NetTCPConnection -State Listen -LocalPort 4646).OwningProcess
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid0"; $p.ProcessId, $p.Name, $p.ParentProcessId
```

## 7. 回滚

| 回滚点 | 做法 |
|---|---|
| 代码 | `git checkout <旧 commit>`（或 `git reset --hard` 到你准备升级前的 commit）；`npm install && npm run build` |
| 数据（修复脚本写的） | 用 `<home>.bak-identity-<时间戳>/agentchat.db` 覆盖回 `<home>/agentchat.db`（**先停 Hub**） |
| 适配器配置 | 重跑旧版安装器，恢复 MCP 桥行 |
| 身份文件 | 删掉 `<home>\agents\dsh.current` 让适配器下次注册重写（`dsh.id` 保留） |

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| DSH 里出现两套 agentchat 工具 | 安装时仍写了 MCP 桥行 → 重装（默认不写），或从 profile patch 里删掉桥行后重启 DSH |
| 工具报 `identity_required` | 该调用没有逐调用身份：确认 `nativeTools` 已启用（新版本默认）、或该会话尚未注册完成 |
| `repair-identity --apply` 报外键失败 | 说明库里有非身份类的悬挂引用；脚本会回滚且不留半修，把输出发我排查 |
| 旧 DM 只剩一个参与者 | 正常（容器被移除）；会话与历史都保留，可在 UI 里标注"历史" |
| 消息仍显示排队 | 看 `wake_jobs` 的 `state/pending_reason`；对端 busy/offline 属正常，P3 后忙时会 `steer` 送达 |
