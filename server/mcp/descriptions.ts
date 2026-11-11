/**
 * MCP 工具 description 单源（P4 工具可发现性）。
 *
 * 为什么单独成文件：本仓硬约束「单文件 ≤ 250 纯行（非空、非注释）」（CONTRIBUTING.md:80）。
 * 另经安装包 app.asar 内 dsh-mcp-client 源码核实：DSH 只消费 tool `description` +
 * 参数 JSON Schema 的 `description` + server `instructions`；tool `title` 与 4 个 annotation
 * hint 会被**丢弃** —— 故"何时用/何时不用/区别/示例/常见错误"只能写在这里。
 *
 * 每条固定六行渲染（`tests/integration/mcp.test.ts` 断言每条含「何时」与「常见错误」）：
 * 作用 / 何时用 / 何时不用 / 邻接区别 / 示例 / 常见错误。
 * `send` 与 `shout` 还必须保留反寒暄关键词「信息增量」「禁纯回执」（既有回归锁）。
 */
import type { McpToolName } from "../../shared/contracts"

/** 沟通纪律（R1/R2）全文：send/shout 的「常见错误」行引用它，避免两处措辞漂移。 */
const DISCIPLINE =
  "每条消息须有信息增量，禁纯回执/寒暄与复读，确认并入下一步；对 agent 的回复只发一次，" +
  "别向会话重发同样内容（没有观众）；回人类时别复述工具输出。"

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  register: [
    "作用：注册或认领节点（根 / 子 / 逻辑），成功后本会话获得身份，其它工具才可用。",
    "何时用：会话第一条消息就调用；子会话给 parent_ref+task_ref（同 task_ref 重连认领同一节点）。",
    "何时不用：不要为改名/改状态再注册；已认领的节点不要换名重注册（会新建或撞名）。",
    "邻接区别：register 建节点拿身份；status 改状态文本；roster 查节点 id 与在线态。",
    '示例：{"name":"builder-1","kind":"runtime","vendor":"opencode","parent_ref":"<父 id 或系统名>","task_ref":"<会话 id>"}',
    "常见错误：name_taken（换 name 重试，或带 task_ref 认领）；parent_not_found（先用 roster 取父 id/名）；task_ref_required（给 parent_ref 必须同时给 task_ref）。",
  ].join("\n"),
  send: [
    "作用：以当前身份给节点(agent id)或群会话(会话 id)发一条消息，可 wait 阻塞等回信。每条消息须有信息增量，禁纯回执/寒暄与复读。",
    "何时用：要对方做事/回话时；答复别人的消息也用 send，回给发送者 id（DM）或群会话 id（群）；急事加 urgency:\"urgent\"。",
    '何时不用：广播全员用 shout（send 的 to 不接受 "*"，会报 use_shout_tool）；只读消息用 inbox；答复 ask 单用 respond_ask。',
    "邻接区别：send=发+可选等；inbox=收；ack=仅标已读不回信；message_status=查回执与紧急度。",
    '示例：{"to":"<agent id 或群 id>","body":"X 已完成，下一步 Y","mentions":["<群成员名>"],"wait":{"until":"either","timeoutMs":30000},"urgency":"urgent"}',
    "常见错误：" + DISCIPLINE + "；not_participant（不在群里，先 group{op:add}）；recipient_not_found（先用 roster 取 id）；identity_required（先 register）；container_not_chat_target（容器不是聊天对象）。",
  ].join("\n"),
  inbox: [
    "作用：读自己的收件箱——**只看各会话「已读位点之后」的消息**（含对方发来的未读，也含**你自己刚发出的**；ack 会把位点推过去），全局 seq 升序；可按会话过滤、after 叠加翻页、ack=true 顺手标已读、timeout 阻塞等新消息。",
    "何时用：回合开始或想知道有没有新消息/任务时；等别人回信也可用 timeout。",
    "何时不用：inbox 不是回复——读完要回就用 send 回给发送者/群，只 ack 对方永远等不到答复；要看**更早的已读历史**用 conversation。",
    "邻接区别：inbox=位点之后的收件视角（含自己发出的；ack 后不再出现）；conversation=按会话读全部历史；ack=推进已读位点；roster 可见他人未读数。",
    '示例：{"conversation":"<群 id>","ack":true,"timeout":30000}',
    "常见错误：identity_required（先 register）；把 timeout 等到的消息当成已回复（必须 send）；超时返回 timedOut=true 属正常，不是错误。",
  ].join("\n"),
  ack: [
    "作用：把消息标记为已读（推进自己的已读位点），不产生任何回复。",
    "何时用：确认已看到且确实不需要回话时；inbox{ack:true} 在读的时候已自动做过一次。",
    "何时不用：需要答复时别用 ack 代替 send——对方只会看到已读，收不到内容。",
    "邻接区别：ack≠回复；message_status 里的 read 档由 ack 触发；回信要用 send。",
    '示例：{"message_ids":["a1b2c3"]}',
    "常见错误：message_ids 为空数组会被 schema 拒（invalid_input）；要传消息短 id（send/inbox 出参的 message.id），不是 seq。",
  ].join("\n"),
  roster: [
    "作用：读组织层级树与联系人卡（可 filter 名称、online_only 只看在线、conversation 只看某群成员）。",
    "何时用：找 agent id、看谁在线、取父节点 id（register 的 parent_ref 需要真实 id 或系统名）。",
    "何时不用：想看“我在哪些群、群里有哪些人”用 group{op:list}；读消息历史用 conversation。",
    "邻接区别：roster=组织树全量视角；group list=聊天群与成员（含 is_member）；conversation=消息。",
    '示例：{"filter":"builder","online_only":true}',
    "常见错误：identity_required（先 register）；带 conversation 时必须是该群成员，否则 not_participant；广播会话（shout）不接受 conversation。",
  ].join("\n"),
  conversation: [
    "作用：按会话 id 读消息历史分页（before=seq 不含，往前翻页；limit 缺省 50、上限 200）。",
    "何时用：需要上下文、翻旧账、确认自己发过什么时。",
    "何时不用：只看未读用 inbox；发新消息用 send；查投递情况用 message_status。",
    "邻接区别：conversation=只读历史（含他人消息）；inbox=我的收件箱；send=写入新消息。",
    '示例：{"id":"<会话 id>","before":123,"limit":50}',
    "常见错误：id 必须是会话 id（不是 agent id；可从 group{op:list} 或 send 出参的 conversationId 取）；未知 id 返回空数组而非报错；撤回消息正文对未投递读者显示占位符。",
  ].join("\n"),
  group: [
    "作用：群聊三合一：op=create 建群 / add 拉人 / list 列群并给出 is_member（你是否已在群）。",
    "何时用：发言前先用 list 拿群 id；不在群里先 add 自己（可能落审批单）；开新协作面用 create。",
    "何时不用：DM 不需要建群（首次 send 给某 agent 会自动建 DM）；容器节点不可入群、不可当成员。",
    "邻接区别：group 管群的组织关系；send 在群里发言；roster{conversation} 看群名册。",
    '示例：{"op":"list"}；{"op":"add","group":"<群 id>","member":"<agent id>"}；{"op":"create","name":"发布协作","member_ids":["<agent id>"]}',
    "常见错误：is_member=false 时发言会 not_participant（先 add）；container_not_group_member（容器不能入群）；返回 approval=已落审批单等 human 批准；缺必填字段（create 需 name、add 需 group+member）报 schema 错。",
  ].join("\n"),
  shout: [
    "作用：全员广播（广播会话 key=\"shout\"，所有非容器节点各收一份）；root 节点发起需人工审批。",
    "何时用：通告所有人都要知道的约定/变更（排期、规范变更等）；急事加 urgency:\"urgent\"（随审批 payload 保留，批准后仍按 urgent 投递）。",
    "何时不用：只给某人或某个群用 send；群内 @ 多人用 send+mentions，不要拿 shout 代替定向消息。",
    "邻接区别：shout=无目标广播；send=定向到 agent/群；两者都返回 receipts。",
    '示例：{"body":"全体注意：今天 18:00 前提交结果","urgency":"urgent"}',
    "常见错误：同样须有信息增量、禁纯回执/寒暄与复读；子节点调用报 Forbidden；返回 approval 表示尚未投递（等 human 批准）；容器节点不会收到广播。",
  ].join("\n"),
  status: [
    "作用：更新自己的状态文本（人类界面状态行可见），不改变 online/busy/offline。",
    "何时用：开始长任务前说明在做什么、预计什么时候有结果，方便人类与同伴判断。",
    "何时不用：改在线状态不用本工具（由适配器状态上报）；这不是发消息，别人不会收到通知。",
    "邻接区别：status=自己的状态文本；message_status=消息回执（名字近似、用途无关）；send=发消息。",
    '示例：{"text":"正在核对发布清单（约 10 分钟）"}',
    "常见错误：identity_required（先 register）；只改文本，别当进度广播用（要广播用 send/shout）。",
  ].join("\n"),
  message_status: [
    "作用：按消息 id 查每个收件方的四级回执 queued→sending→delivered→read，判断“对方到底收到没”。",
    "何时用：send 后迟迟没有回复、怀疑没投递、交付前核对时。",
    "何时不用：想看消息正文用 inbox/conversation；想催办就用 send 发一条有新信息的消息。",
    "邻接区别：message_status=只读回执与紧急度；inbox=读正文；status=自己的状态文本。",
    '示例：{"ids":["a1b2c3","d4e5f6"]}',
    "常见错误：对端 busy/offline 时停在 pending/queued 属正常（不是丢失，等其空闲/上线会继续投递）；只对自己发出的消息有意义；identity_required（先 register）。",
  ].join("\n"),
  ask: [
    "作用：向 human 或某个 agent 发“带选项的请求批示”，可 wait 阻塞到答复；群问要带 mentions。",
    "何时用：需要对方选择/批准才能继续，且必须拿到答复时（如“用 A 还是 B”）；急卡可加 urgency 加快投递（不影响答复链路）。",
    "何时不用：只是告知进度用 send；不需要答复就别开 ask 单（会占一张审批卡）。",
    "邻接区别：ask=结构化提问（有 options、有答复卡）；send=自由文本；respond_ask=答复别人的 ask。",
    '示例：{"to":"human","question":"采用 A 还是 B？","options":["A","B"],"allow_custom":true,"wait":{"until":"either","timeoutMs":285000}}',
    "常见错误：群 ask 必须给 mentions（mentions_required）且被 @ 者在群里（mention_not_participant）；要自由答复需 allow_custom=true；to 为群会话 id 时 wait.scope=all（缺省等全体）/any（任一先回）。",
  ].join("\n"),
  respond_ask: [
    "作用：答复一条发给你的 ask（choice=选项 或 text=自由文本，二者择一，首答生效）。",
    "何时用：在 inbox/conversation 看到 ask 卡、且你是答复人时。",
    "何时不用：不要重复答复（第二次报 ask_already_answered）；不是问你的 ask 不要答。",
    "邻接区别：respond_ask 只答复 ask 单；普通消息用 send 回复；ask 是发起侧。",
    '示例：{"ask_id":"<ask id>","choice":"yes"}',
    "常见错误：invalid_choice（choice 不在 options 内且未开 allow_custom）；ask_already_answered（已有人答过）；自由答复要传 text 而不是 choice。",
  ].join("\n"),
  whoami: [
    "作用：读**自己**的身份卡——agent_id、机器名 name、**展示名 display_name**（人类在 UI 里看到并修改的昵称）、vendor/kind/status/role_tag/parent_id 与 unread。",
    "何时用：想知道自己叫什么/自己是谁、要跟人类对账名字、确认自己已被收养、或看看还有多少未读时。",
    "何时不用：查别人用 roster；whoami 只读——**改展示名不是本工具**（由人类在 UI「联系人」改，或 PATCH /api/agents/:id）。",
    "邻接区别：whoami=自己一张卡；roster=整棵节点树（含他人 id/状态/未读）；register=建/认领节点并拿身份；status=改状态文本。",
    "示例：{}",
    "常见错误：identity_required（先 register 拿身份再 whoami）；把机器名 name 当成别人看到的昵称（人类看到的是 display_name）。",
  ].join("\n"),
}
