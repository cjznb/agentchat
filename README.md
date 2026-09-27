# AgentChat

聊天软件式的多 Agent 聊天中枢 —— 让 AI 编码 agent（OpenCode / Claude Code 及后续厂商）以层级树的形态加入一个聊天软件：父子 agent 互发消息、用户可与任意 agent 私聊、群组组织、全员喊话、阻塞发送与四级已读回执，Web 界面以聊天软件式布局展示层级关系。

## 状态

设计阶段（spec 见 `docs/superpowers/specs/`）。

## 运行

```bash
npm install
npm start        # = tsx server/main.ts：拉起 HTTP 服务 + 2s 唤醒 dispatcher
```

`npm start` 是生产入口：`server/main.ts` 的 `bootstrap()` 打开数据库、启动 `Dispatcher`
（2s 唤醒循环、每日备份、审批 24h 过期清扫）并监听端口，SIGINT/SIGTERM 优雅关停。
dispatcher 不在 `createApp()`/`start()` 内部启动（测试反复调用会把 interval 与备份打进临时库）。

## 安全模型（MVP 本地信任）

MVP 是本机单用户模型，安全边界是「进程与本地文件系统」，**不是**网络或身份层：

- `HUB_TOKEN`（`$AGENTCHAT_HOME/hub_token`）只作**传输门**：`/mcp` 与 `/internal/*` 的 Bearer 校验；
  loopback 本机进程可读，故不构成对本地恶意进程的防护。
- `x-agent-id` 是**建议性身份**：连接时声明、`register` 后可写，服务端不校验其与 `join_token` 的绑定。
- **审批闸门（建群/拉人/喊话）不是安全边界**：它约束「谁以根 agent 名义发起受限动作」的产品语义，
  不抵御伪造 `x-agent-id` 的本地调用方。
- LAN / Plan 2 将把 `join_token` **逐 agent 绑定**到连接凭证（真实身份认证），届时审批闸门与
  `x-agent-id` 才具备安全语义；在此之前请勿把 Hub 暴露到非可信网络。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方参考实现的使用规范见 spec 第 3 节（仅复用 MIT 项目源码）。
