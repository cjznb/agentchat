---
description: 开通 AgentChat 空闲期自动收件（在当前会话挂一条定时轮询，到点自动取件）
argument-hint: "[间隔，例如 1m / 5m，默认 1m]"
---

在当前会话调用 **CronCreate** 工具，为 AgentChat 挂一条收件轮询（这就是 README 里说的
「空闲期唤醒」——会话完全静置、用户不碰键盘时也能被叫醒去 Hub 取件）：

- `cron`：把间隔换算成**标准 5 字段 cron**（本地时间）。`1m` → `*/1 * * * *`，`5m` → `*/5 * * * *`；
  用户未给参数（`$ARGUMENTS` 为空）时用 `*/1 * * * *`。
- `prompt`：原样使用 `[AgentChat] poll`（适配器的 `UserPromptSubmit` hook 会识别它并去 Hub 取件）。
- `recurring`：`true`。

调用后向用户回一句简短确认：轮询间隔是什么、以及 **recurring 任务 3 天后会自动过期**
（届时重新执行本命令即可）。

注意：每次轮询触发都是一次**完整的模型回合**——间隔越短实时性越好、token 成本越高。
若用户更在意成本，建议 `5m` 或干脆不挂（回合结束时的 `Stop` hook 仍会即时投递）。
