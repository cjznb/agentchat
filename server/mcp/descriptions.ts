/**
 * MCP 工具 description 单源（P2 瘦身版：13 条描述共 ≈6KB，原 ≈10.5KB）。
 *
 * 为什么单独成文件：本仓硬约束「单文件 ≤ 250 纯行」（CONTRIBUTING.md:80）。另经 app.asar 内
 * dsh-mcp-client 源码核实：DSH 只消费 tool `description` + 参数 JSON Schema 的 `description` +
 * server `instructions`；tool `title` 与 4 个 annotation hint 会被丢弃 —— 故关键约束只能写在这里。
 *
 * 每条**三行**（`tests/integration/mcp.test.ts` 断言每条含「何时」与「常见错误」）：
 * 作用+示例 / 何时用+何时不用 / 常见错误。`send` 与 `shout` 必须保留反寒暄关键词
 * 「信息增量」「禁纯回执」（既有回归锁）。详细用法在 server `instructions`（guide.ts）。
 */
import type { McpToolName } from "../../shared/contracts"

/** 沟通纪律（R1/R2）摘要：send/shout 的「常见错误」行引用，避免两处措辞漂移。 */
const DISCIPLINE =
  "每条消息须有信息增量，禁纯回执/寒暄与复读（确认并入下一步；对 agent 只回一次、别向会话重发；回人类别复述工具输出）"

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  register: [
    "作用：注册/认领节点（根/子/逻辑），成功后本会话才有身份。示例：{\"name\":\"builder-1\",\"kind\":\"runtime\",\"vendor\":\"opencode\",\"parent_ref\":\"<父 id 或系统名>\",\"task_ref\":\"<会话 id>\"}",
    "何时用：会话第一条消息就调；子会话带 parent_ref+task_ref（同 task_ref 重连认领同一节点）。何时不用：改名/改状态别重注册（会新建或撞名）。",
    "常见错误：name_taken（换 name 或带 task_ref 认领）；parent_not_found（先 roster 取 id/名）；task_ref_required（给 parent_ref 必须同时给 task_ref）。",
  ].join("\n"),
  send: [
    "作用：给 agent id 或群会话 id 发一条消息，可 wait 等回信。示例：{\"to\":\"<agent id 或群 id>\",\"body\":\"X 已完成，下一步 Y\",\"mentions\":[\"<群成员名>\"],\"wait\":{\"until\":\"either\",\"timeoutMs\":30000},\"urgency\":\"urgent\"}",
    "何时用：要对方做事/回话；答复别人也用它（回发送者 id 或群 id）。何时不用：广播用 shout（to 不接受 \"*\"）；只读用 inbox；答 ask 用 respond_ask。",
    "常见错误：" + DISCIPLINE + "；not_participant（先 group{op:add}）；recipient_not_found（先 roster 取 id）；identity_required（先 register）；container_not_chat_target（容器不是聊天对象）。",
  ].join("\n"),
  inbox: [
    "作用：读自己的收件箱——各会话已读位点之后的未读，**默认排除自发**（喊话/system 例外）；默认 20 条、正文预览 200 字符，返回 has_more/next_after。示例：{\"ack\":true,\"limit\":20,\"preview_chars\":200}",
    "何时用：回合开始或等新消息（timeout 阻塞）。何时不用：inbox 不是回复（要回用 send）；看更早历史用 conversation；要把自发读回来用 include_self:true。",
    "常见错误：identity_required（先 register）；把 timeout 等到的消息当成已回复（必须 send）；timedOut=true 属正常；自己轮询时按 fromAgentId≠自己 过滤（include_self:true 下）。",
  ].join("\n"),
  ack: [
    "作用：把消息标为已读（推进自身读位点），不产生回复。示例：{\"message_ids\":[\"a1b2c3\"]}",
    "何时用：确认看到且不需回话；inbox{ack:true} 已顺手做过。何时不用：要答复就用 send——ack 对方收不到任何内容。",
    "常见错误：message_ids 空数组报 invalid_input；要传消息短 id（不是 seq）。",
  ].join("\n"),
  roster: [
    "作用：组织/联系人。**view 缺省 compact**（扁平精简、默认不含离线/退役、约 2-3KB）；summary=只给计数；tree=旧版完整树。示例：{\"filter\":\"builder\"}｜{\"view\":\"summary\"}｜{\"view\":\"tree\",\"conversation\":\"<群 id>\"}",
    "何时用：找 agent id、看谁在线、取父节点 id。何时不用：看群与成员用 group{op:list}；读消息用 conversation。",
    "常见错误：identity_required（先 register）；conversation 模式要求你是该群成员（否则 not_participant）；shout 广播会话不接受 conversation；别不加 filter 拉 tree（几十 KB）。",
  ].join("\n"),
  conversation: [
    "作用：按会话 id 读历史（before=seq 不含，往前翻页）；默认 20 条、正文预览 300 字符，返回 has_more/next_before。示例：{\"id\":\"<会话 id>\",\"limit\":20,\"preview_chars\":0}",
    "何时用：要上下文/翻旧账/看全文（preview_chars:0）。何时不用：只看未读用 inbox；发消息用 send；查回执用 message_status。",
    "常见错误：id 必须是会话 id（不是 agent id）；未知 id 返回空数组不报错；撤回正文对未投递读者显示占位符。",
  ].join("\n"),
  group: [
    "作用：群三合一：create 建群 / add 拉人 / list 列群（含 is_member，分页 50）。示例：{\"op\":\"list\"}｜{\"op\":\"add\",\"group\":\"<群 id>\",\"member\":\"<agent id>\"}｜{\"op\":\"create\",\"name\":\"发布协作\",\"member_ids\":[\"<agent id>\"]}",
    "何时用：发言前 list 拿群 id；不在群里先 add 自己（可能落审批单）。何时不用：DM 不需建群；容器不可入群/当成员。",
    "常见错误：is_member=false 发言报 not_participant（先 add）；container_not_group_member；返回 approval=等 human 批准；create 缺 name / add 缺 group+member → schema 错。",
  ].join("\n"),
  shout: [
    "作用：全员广播（所有非容器节点各收一份；root 发起需审批）。示例：{\"body\":\"全体注意：18:00 前提交结果\",\"urgency\":\"urgent\"}",
    "何时用：通告全员都要知道的事。何时不用：定向用 send；群内 @ 多人用 send+mentions——别拿 shout 代替定向消息。",
    "常见错误：同样须有信息增量、禁纯回执/寒暄与复读；子节点调用报 Forbidden；返回 approval=尚未投递；容器收不到广播。",
  ].join("\n"),
  status: [
    "作用：更新自己的状态文本（人类界面可见），不改 online/busy/offline。示例：{\"text\":\"正在核对发布清单（约 10 分钟）\"}",
    "何时用：开始长任务前说明进度。何时不用：改在线状态由适配器上报；这不是消息，别人不会收到通知。",
    "常见错误：identity_required（先 register）；别当进度广播用（要广播用 send/shout）。",
  ].join("\n"),
  message_status: [
    "作用：按消息 id 查各收件方四级回执 queued→sending→delivered→read（单次≤50 条）。示例：{\"ids\":[\"a1b2c3\",\"d4e5f6\"]}",
    "何时用：send 后久无回复、怀疑没投递、交付前核对。何时不用：看正文用 inbox/conversation；催办用 send 发新信息。",
    "常见错误：对端 busy/offline 停在 pending/queued 属正常（不丢，空闲后继续）；只对自己发出的消息有意义。",
  ].join("\n"),
  ask: [
    "作用：向 human 或 agent 发带选项的批示请求，可 wait 到答复；群问必须带 mentions。示例：{\"to\":\"human\",\"question\":\"采用 A 还是 B？\",\"options\":[\"A\",\"B\"],\"allow_custom\":true,\"wait\":{\"until\":\"either\",\"timeoutMs\":285000}}",
    "何时用：需要对方选择/批准才能继续。何时不用：只告知进度用 send；不需答复别开 ask（占审批卡）。",
    "常见错误：群 ask 缺 mentions 报 mentions_required；被 @ 者不在群报 mention_not_participant；自由答复需 allow_custom=true；群问 wait.scope=all/any。",
  ].join("\n"),
  respond_ask: [
    "作用：答复发给你的 ask（choice 或 text，二者择一，首答生效）。示例：{\"ask_id\":\"<ask id>\",\"choice\":\"yes\"}",
    "何时用：在 inbox/conversation 看到 ask 卡且你是答复人。何时不用：别重复答复；不是问你的别答。",
    "常见错误：invalid_choice（不在 options 且未开 allow_custom）；ask_already_answered；自由答复传 text 不是 choice。",
  ].join("\n"),
  whoami: [
    "作用：读**自己**的身份卡：agent_id、机器名 name、**展示名 display_name**（人类看到的昵称）、vendor/kind/status/role_tag/parent_id、unread。示例：{}",
    "何时用：想知道自己叫什么/自己是谁、跟人类对账名字、看未读数。何时不用：查别人用 roster；whoami 只读（改名由人类在 UI 改）。",
    "常见错误：identity_required（先 register）；别把机器名 name 当成人类看到的昵称（那是 display_name）。",
  ].join("\n"),
}
