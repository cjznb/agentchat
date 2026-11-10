# 升级后修复身份遗留数据（`repair-identity`）

> 适用版本：P7（容器语义修复）落地**之后**。P7 负责让新代码**不再产生**"容器冒充身份"的数据；
> 本脚本负责把升级**之前**已经产生的存量清干净。

"容器"指 `agents.role_tag = 'container'` 的分组节点（如 `opencode@<host>` / `dsh@<host>`）。
旧代码允许它们入群、发言，于是库里留下了容器署名的消息与会话成员行；容器不是聊天实体
（永不收件、从不取件），这些行属于历史遗留。

## 1. 命令

```powershell
# dry-run（缺省）：只扫描并打印报告，零写入
node bin/repair-identity.mjs

# 机器可读报告（JSON）
node bin/repair-identity.mjs --json

# 指定数据目录（等价 env AGENTCHAT_HOME；默认 ~/.agentchat）
node bin/repair-identity.mjs --home <dir>

# 执行修复（写前自动快照）
node bin/repair-identity.mjs --apply

# 升级后自检：只报残留，退出码 0=干净 / 1=有残留 / 2=失败
node bin/repair-identity.mjs --check
```

> 目前是独立脚本（`node bin/repair-identity.mjs`）。**尚未**接入 `agentchat` 子命令
> （接入需要改 `bin/agentchat.mjs`，不在本次改动范围内）。

## 2. dry-run 示例

```text
[repair-identity] 模式：dry-run（只读，零写入）
[repair-identity] 数据目录：C:\Users\<you>\.agentchat
[repair-identity] 容器节点：2 个：opencode@DESKTOP-XXXX(c4e7ff85)、dsh@DESKTOP-XXXX(4316eacf)
[repair-identity] 发现：
  - participants：1 行（容器永不可收件）
  - read_states：0 行（容器从不取件）
  - wake_jobs：0 行（以容器为唤醒目标）
  - 容器署名消息：1 条（已标注 0、待标注 1、system 不标注 0）
      seq=24 text 「…」
[repair-identity] 保留：容器 agents 行 2 个、agent_keys 2 行；容器创建的群 0 个（只报告不删）
[repair-identity] 清掉容器后不足两人的 DM：1 条（会话与历史保留，供 UI 标注）：
      <conversationId>（剩 1 人：<agentId>）
[repair-identity] 残留：participants 1、read_states 0、wake_jobs 0、未标注消息 1、容器创建的群 0
[repair-identity] 外键检查：OK（无悬挂引用）
[repair-identity] 以上为预演，未改动数据库；执行修复请加 --apply（写前自动快照）。
```

## 3. `--apply`：先停 Hub，写前自动快照

1. **先停止 Hub**。运行中写库有风险（与 `POST /api/admin/reset` 同一顾虑：Windows 锁文件、
   并发写）。本脚本与 Hub 之间没有协作协议，请确保没有进程在用同一个数据目录。
2. 写前自动 `VACUUM INTO '<home>.bak-identity-<ISO 时间戳>/agentchat.db'` 一致性快照
   （写法与 `server/routes/admin.ts` 同源）。**快照失败即中止**，库保持原状。
3. 修复在**单个 `BEGIN IMMEDIATE` 事务**内完成；提交前跑 `PRAGMA foreign_key_check`，
   不通过即抛错**回滚**（绝不留半修状态）。`PRAGMA foreign_keys = ON`。
4. **幂等**：无残留时 `--apply` 不写库、也不生成新快照；连跑两次第二次为零变更。

回滚方式（如需）：停 Hub → 用快照覆盖 `<home>/agentchat.db` → 删除 `<home>/agentchat.db-wal`
与 `-shm`（否则旧 WAL 会被重放）。

### 修复内容（安全、不丢消息）

| 对象 | 动作 |
| --- | --- |
| 容器 `participants` 行（DM 与群） | **删除**（容器永不可收件） |
| 容器 `read_states` 行 | **删除**（容器从不取件） |
| 以容器为唤醒目标的 `wake_jobs` 行 | **删除** |
| 容器署名的**非 system** 消息 | **不删**，仅标注 `meta.legacy_identity="container"`（合并进既有 meta、保留其它键） |
| 容器署名的 `kind='system'` 消息 | **不标注**（system 的作者是运行记账，不代表"身份使用"），只在报告中单独计数供人工判断 |
| 容器 `agents` / `agent_keys` 行 | **保留**（层级与注册仍需要），只报告 |
| 容器创建的群 | **不删**（删群会丢其它成员的历史，属破坏性动作），只报告 |
| 因删除而只剩单一参与者的 DM | **保留会话与其历史**，在报告中列出（供 UI 标注） |

标注只写 meta，**不动正文、不动作者、不动 `seq`**。

## 4. `--check` 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 干净（无残留、外键检查通过） |
| 1 | 仍有残留 |
| 2 | 执行失败（打不开库、参数错误、外键检查不通过等） |

"残留"= 下列任一项 > 0：
容器 `participants` / 容器 `read_states` / 容器 `wake_jobs` / **未标注的**容器署名非 system 消息 /
容器创建的群（此项本脚本不修，需人工确认后处理）。

`PRAGMA foreign_key_check` 有悬挂引用时 `--check` 返回 **2**：这不是身份遗留，而是库完整性
问题；`--apply` 在此状态下会回滚，因此不能视为"可修干净"。

## 5. 标注消息（`meta.legacy_identity`）在 UI 如何呈现（建议）

UI 在另一个 worktree，以下为**建议**、未实现：

1. **气泡角标**：消息 `meta.legacy_identity === "container"` 时，在作者名旁加灰色小字
   （如"历史身份未区分"）或一个 info 图标，悬浮说明："该消息来自一个分组容器节点；
   真实发言者无法自动反推。"
2. **不要改写作者名，也不要隐藏/删除该消息**：标注是"解释"，不是"更正"；历史必须可追溯。
3. **不要把它当成系统消息**：它仍是 `kind='text'` 的普通消息（仅多一个 meta 键），
   聊天线、分页、未读计数等既有逻辑不应因该键改变行为。
4. **单一参与者的 DM**：`--apply` 报告里列出的会话，UI 可显示"对方已不在成员表（历史遗留）"，
   但**保留会话入口与历史**（不要因成员不足而从聊天栏消失）。
5. `kind='system'` 的容器署名消息按约定**不带**该标注；如 UI 需要提示，请单独依据
   `from_agent_id` 判断，不要复用本标注字段。

## 6. 运行时身份文件（本脚本不碰）

`<home>/agents/dsh.current`、`<home>/agents/dsh.id` 由适配器管理，本脚本**只读探测不修改**。

若报告出现"运行时身份文件缺失：`dsh.current` 不存在"且顶层 runtime 节点 ≥2，说明可能触发了
"顶层会话 ≥2 → 提示文件被删"的历史误归属：请**开启 `nativeTools`**，或**只保留一个顶层会话**
后再注册（与 P7/适配器文档一致）。历史误归属无法自动反推，只能标注。

> ⚠️ 探测路径就是 `--home` 指向的目录。**在真库副本上演练时，`agents/` 通常没有被一起复制，
> 报告必然显示"dsh.current / dsh.id 均不存在"**——那不是真机状态，只是副本缺文件。要判断真实
> 身份状态，请把 `--home` 指向真实数据目录（只读探测，不会写）；或在复制时一并带上 `agents/`。

## 7. 真机演练（推荐流程）

```powershell
# 1) 复制真库（含 -wal/-shm）到临时目录，绝不对真库直接 --apply
$src = "$env:USERPROFILE\.agentchat"
$dst = Join-Path $env:TEMP ("agentchat-repair-drill-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $dst | Out-Null
foreach ($f in @("agentchat.db","agentchat.db-wal","agentchat.db-shm")) {
  if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $dst $f) }
}

# 2) 在副本上看"这份库会修什么"
node bin/repair-identity.mjs --home $dst
node bin/repair-identity.mjs --home $dst --check

# 3) 确认无误后：停 Hub，再对真库执行
node bin/repair-identity.mjs --apply
node bin/repair-identity.mjs --check    # 期望 0（若仍有"容器创建的群"则为 1，需人工处理）
```

## 8. 实现位置

| 关注点 | 文件 |
| --- | --- |
| 参数解析（纯函数） | `bin/repair-args.mjs` |
| 扫描 / 快照 / 修复 / 报告 | `bin/repair-identity.mjs` |
| 集成测试（9 项） | `tests/integration/repair-identity.test.ts` |

测试直接 `import` 脚本函数（不 spawn 子进程），全程临时 `AGENTCHAT_HOME`，绝不触碰真实数据目录。
