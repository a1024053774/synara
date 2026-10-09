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

记录器覆盖受管 worker、attach、普通会话和主控会话。消息按服务端 `dispatchOrigin=user` 的域事件记录；异步问题答复保存问题 id 与答案。审批、结构化答复、停止、中断和归档在 WS RPC 入口记录。退出批量中断、临时线程清理和退出恢复标为 `ui-derived`，不派生人工介入。v1 不判断内容含义。

`user_input_observer` 对外提供记录器状态。受管 attempt 的记录失败保持门禁 fail-closed；其他范围失败不阻断业务。启动时重放事件日志和已登记的 RPC 来源；来源无法核对的中断区间保存 `form: gap`、序号范围与原因，不推断为用户决定。消息、RPC 与重放按稳定的来源键去重；受管输入与指向 `input_id` 的 `human_intervention` 在同一事务写入。面板答复仍使用其原有登记与去重路径。

旧 `human_inputs` 去重表迁入 `user_input_events`；`user_inputs` 的 task、message 可为空，历史正文和事件保留。迁移在事务中执行，允许中断后重跑；用户输入和 RPC 来源登记为追加式记录。
