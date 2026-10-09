# 角色预设与主控收件箱

attach 的 `role` 保存任务归属，`preset` 选择固定的 MCP 工具集合。两种主控的 role 都是 `controller`，preset 分别是 `executor` 和 `ideation`；worker、reviewer、monitor 默认使用同名预设。例：

```json
{
  "command": "attach",
  "task": "CONTROL_TASK",
  "role": "controller",
  "preset": "executor",
  "modelSelection": { "provider": "codex", "model": "gpt-6.1-sol" },
  "runtimeMode": "full-access",
  "instructions": "/absolute/path/role-card.txt"
}
```

预设在首次 turn 前绑定并持久保存；每次签发凭据复制其能力，改变预设不修改已签发凭据，须重新签发。未选择 a2a 预设的原生会话保留 Synara 的六种通用能力。预设会话不获得通用 `thread:write`，也不因 provider 的可选能力配置获得额外工具。没有自由编辑能力的接口。

| 预设               | MCP 工具                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| executor           | a2a_create、a2a_claim、a2a_dispatch、a2a_attach、a2a_verify、a2a_integrate、a2a_reclaim、a2a_run、a2a_revoke、a2a_revise；a2a_status、a2a_events、a2a_issues；a2a_disposition；三个 inbox 工具 |
| ideation           | a2a_status、a2a_events、a2a_issues；a2a_disposition；三个 inbox 工具；a2a_stop                                                                                                                 |
| worker             | a2a_submit、a2a_raise                                                                                                                                                                          |
| reviewer / monitor | a2a_raise                                                                                                                                                                                      |

operate 包含 read 权限，以便同名只读工具供两个主控使用；inbox 包含已定义的主控问题处置。a2a_disposition 保留原接口。所有门禁业务仍由同一核心负责，保持 task 操作锁、fence、CAS 与 attempt 绑定。HTTP 与 CLI 的 owner 入口供人工操作者使用；MCP 的角色来自固定凭据，不能从参数指定。

收件箱命令 `inbox_send`、`inbox_list`、`inbox_ack` 可经同一 `/api/a2a` HTTP 或现有 CLI 调用。MCP 名称为 `a2a_inbox_send`、`a2a_inbox_list`、`a2a_inbox_ack`。send 使用 kind、from、to、reply_to、refs、body 及相应的 issue/disposition/answer 字段；服务端产生 UUID、schema=1 和带时区的 created_at。MCP 忽略参数伪造的 sender/role。例：

```json
{"command":"inbox_send","from":"ideation","to":"executor","kind":"assign","refs":["ticket:T-058"],"body":"本批就绪 ticket 与授权原文"}
{"command":"inbox_list","role":"executor"}
{"command":"inbox_ack","role":"executor","id":"ENTRY_UUID"}
```

种类为 assign、revise、cancel、stop、report、needs-decision、issue、disposition、answer、ack。原条目和送达回执只追加，SQL 拒绝 UPDATE/DELETE；确认是指向原条目的新 ack，只有原收件人可以确认，ack 是终结，重复确认不产生新条目或重复唤醒。未确认列表也包含已有 issue 记录中的 executor 转交；不迁移 Herdr 文件，不双写。

写入后只尝试一次唤醒。唯一活跃归属的目标会话收到带条目 id 与首行摘要的 agent 来源消息，忙时排队；不产生用户输入。无目标、多目标或目标已结束时保留条目及 undelivered 回执，返回非成功。未知外部错误记 unknown；进程中断留下 pending，不能当作成功，也不自动重送。ack 可能已保存，但向原发送方的唤醒未送达；回执分别保留这两个事实。读取、重启和重复 ack 不重新唤醒。

a2a_stop 只请求 `thread.turn.interrupt`，不停止 session、不归档、不回收、不验收、不集成。参数为 thread、stop_id；目标须是当前受管或 active attach 的 worker/reviewer/monitor。stop 条目须从 user/ideation 发给 executor，refs 指向该 thread 或其当前 attempt，超过两分钟且没有 executor ack。检查与中断请求持有目标 task 锁及该 stop 条目锁。返回 interruptRequested 只表示原生请求已受理，实际 turn 状态须另行读回；构思主控仍须按角色卡取得用户当时的停止授权。

# 问题上报与答复

问题、答复和处置均写入追加式记录，状态从最后一条记录与读取时钟派生。无处置的判断期为 15 分钟；`forward` 从转交时重新计 15 分钟；`snooze` 为 1 小时。`close`、`dismiss`、答复送出分别派生为已关闭、已关闭、已送达。`reopen` 与 `needs-user` 开始新的答复周期，旧答复仍保留在记录链与用户输入中。

HTTP、工作台 CLI 与 MCP 共用门禁核心。以下请求可经现有 `a2a/scripts/gate` 发送：

```json
{
  "command": "disposition",
  "task": "TASK_ID",
  "issue": "ISSUE_ID",
  "action": "close",
  "reason": "重复问题",
  "basis": "ticket:T-099"
}
```

动作包括 `close`、`needs-user`、`forward`、`reopen`、`snooze`、`dismiss`、`delivered`。关闭必须有理由与依据；`delivered` 只接受已有的真实发送回执，不能用来伪造送达。认证的本机 owner/CLI 操作者代表用户；MCP 的身份来自凭据绑定的活跃会话与任务归属，不能从参数指定。处置 MCP 工具 `a2a_disposition` 只允许主控会话使用；主控不能关闭 blocking 问题，也不能替用户 reopen、snooze、dismiss 或回答。该工具走普通权限确认路径。

单条答复保持 `answer_issue` 接口；多条使用同一答复实现：

```json
{
  "command": "answer_issues",
  "task": "TASK_ID",
  "mode": "bundle",
  "answers": [
    { "issue": "ISSUE_ID_1", "answer": "第一条答复" },
    { "issue": "ISSUE_ID_3", "answer": "第三条答复" }
  ]
}
```

`bundle` 按会话各送一条消息，同包每题各有一条 answer，共享 bundle ID 与消息 ID；`individual` 每题各送一条消息。消息使用会话内问题号，正文最多 600 个 Unicode 字符，超出以“…”结束；空正文省略该行，答复只去掉末尾空白，题间一个空行。关闭告知附在该会话下一条面板/门禁答复消息末尾，并留下只发送一次的回执。结束会话保留答复并追加 `forward/session-ended`；未知发送错误保留已答复状态并返回失败。

工作台的问题面板默认显示等你决定，可切到全部或已关闭。草稿使用既有本机存储编码器，每题一个键；多个会话视图共享草稿，发送后清除。任务汇总可按会话打包，面板清单可滚动，批量操作区保留在清单之外。徽标仅计等你决定，稍后项在 1 小时内不计入；后台通知复用现有桌面通知桥与开关，静音，并合并同一批新问题。

# 用户输入记录

记录器覆盖受管 worker、attach、普通会话和主控会话。消息按服务端 `dispatchOrigin=user` 的域事件记录；异步问题答复保存问题 id 与答案。审批、结构化答复、停止、中断、编辑重发、检查点回退和归档在 WS RPC 入口记录。编辑重发保留被编辑消息的目标键与请求原文。退出批量中断、临时线程清理和退出恢复标为 `ui-derived`，不派生人工介入。v1 不判断内容含义。

解除阻塞的 `reconcileProviderDelivery` 也在 WS 入口记录：每个收到的请求一条 action，目标包含 `thread` 与原请求的 `eventSequence`，业务 CAS 拒绝的重复请求仍保留各自的输入记录。工作目录切换触发的停止标 `ui-derived`；退出恢复的项目键从服务端线程快照取得。

`user_input_observer` 对外提供记录器状态。受管 attempt 的记录失败保持门禁 fail-closed；其他范围失败不阻断业务。启动时重放事件日志和已登记的 RPC 来源；来源无法核对的中断区间保存 `form: gap`、序号范围与原因，不推断为用户决定。消息、RPC 与重放按稳定的来源键去重；受管输入与指向 `input_id` 的 `human_intervention` 在同一事务写入。面板答复仍使用其原有登记与去重路径。

人工介入事件保留输入的 `channel` 和目标 `request_id`。WS 结构化答复可以没有 message 键，但必须有 request；消息渠道的答复仍要求有效 message 身份，界面不会为结构化答复发明消息 id。

旧 `human_inputs` 去重表迁入 `user_input_events`；`user_inputs` 的 task、message 可为空，历史正文和事件保留。迁移在事务中执行，允许中断后重跑；用户输入和 RPC 来源登记为追加式记录。
