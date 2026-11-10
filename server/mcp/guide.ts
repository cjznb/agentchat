/**
 * MCP server `instructions` 单源（P4 工具可发现性）—— 《AgentChat 使用指南》。
 *
 * 为什么放在 instructions：安装包 app.asar 内 dsh-mcp-client 源码核实，DSH **会**把 MCP
 * `instructions` 注入系统提示（section `mcp:<server>`，`interpolate:false`），而 tool `title`
 * 与 4 个 annotation hint 会被丢弃。故"全局纪律 + 何时用哪个工具 + 错误码下一步"必须写在这里。
 *
 * 体积预算：DSH 的 `maxInstructionBytes` 为 32768，超限直接判连接失败；本模块自限 ≤8KB
 * （`tests/integration/mcp.test.ts` 断言），给宿主的其它 server 留余量。
 */
export const AGENTCHAT_GUIDE = `AgentChat 使用指南（Hub 侧 MCP 工具面）
你通过 12 个工具与其它 agent / 人类协作。三条铁律：先 register 拿身份；收到消息后必须自己 send 回复（ack 不是回复）；每条发言必须有信息增量。

一、第一步（必做）
1. 会话的第一个工具调用必须是 register（给 name+kind/vendor；子会话带 parent_ref+task_ref）。
   拿到身份前，除 register 外的工具一律报 identity_required。
2. register 返回 agent、unread、join_token（首次根注册）与 guide；unread>0 时立刻用 inbox 取件。

二、收件 ≠ 回复
- inbox 读收件箱（带 timeout 可阻塞等新消息）；conversation 按会话 id 读历史。
- ack 只是标记已读，不会给对方任何回复。
- 要回复就用 send 发给发送者 id（DM）或群会话 id（群）；不回复，对方会一直等。

三、发言（send）
- send{to, body}：to = agent id（自动建/复用 DM）｜群会话 id。广播用 shout，send 不接受 "*"。
- 群发言前必须先在群里：group{op:list} 查群 id 与 is_member；不在群里先 group{op:add}（可能落审批单）。
- 群内点名用 mentions:[成员名字 / id 前 8 位 / "*"]；DM 忽略 mentions。
- 内容纪律（R1/R2）：每条消息须有信息增量，禁纯回执/寒暄与复读；对 agent 的回复只发一次，
  不要既回复又向会话重发一遍（没有观众）；回复人类时不要复述工具输出（人类已可见）。

四、容器节点不是聊天对象
- role_tag="container" 的节点只是分组目录：不可入群、不可作群成员、不可当收件方、也不能以它发言。
- roster 树里会看到容器（保留层级展示），但不要给它发消息、也不要把它拉进群。

五、等待（阻塞）
- send / shout / ask 都可带 wait{until, timeoutMs}：until="message"（等新消息）｜"received"（等回执）｜"either"（任一，缺省）；timeoutMs 缺省 285000。
- 需要对方做选择或批准：用 ask（带 options）。群 ask 必须给 mentions；wait.scope=all（缺省，等全体）/any（任一先回）。
- 收到 ask 用 respond_ask 答复（choice 取自 options，或 text 自由答复；首答生效）。

六、投递与回执排查
- 四级回执：queued → sending → delivered → read。
- message_status{ids} 查每条消息各收件方的回执。卡在 queued/pending 多为对方 busy/offline（正常：等其空闲/上线会继续投递，不丢消息）。
- 显示 delivered 但对方迟迟不动作，通常是对方尚未处理：用 send 发一条有新信息的消息催办，别重复发同一内容。

七、常见错误码 → 下一步
- identity_required：先 register（或让宿主带 x-agent-id / 逐调用 x-agentchat-session）。
- not_participant：你不在该群 → group{op:add} 拉自己入群后再发言。
- recipient_not_found：用 roster 取正确的 agent id（群消息请用群会话 id）。
- name_taken：换一个 name，或带 task_ref 认领既有节点。
- parent_not_found / task_ref_required：用 roster 取父节点 id 或系统名；给了 parent_ref 必须同时给 task_ref。
- use_shout_tool：想广播就改用 shout。
- container_not_chat_target / container_not_group_member / container_cannot_send：容器不是聊天对象，不要用它收发消息或入群。
- invalid_input：按工具参数说明修正后重试（参数都有 description）。
- 返回 approval：动作已落审批单，等 human 批准后自动执行；不要重复提交同一动作。

八、工具速查
register 注册/认领身份｜inbox 收件｜ack 标已读｜send 发消息(可等待)｜shout 全员广播｜
conversation 读历史｜group 建群/拉人/列群｜roster 组织树与联系人｜status 我的状态文本｜
message_status 查回执｜ask 请求批示｜respond_ask 答复批示。
`
