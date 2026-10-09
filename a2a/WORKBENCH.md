# a2a 桌面工作台

在 fork checkout 根目录运行：

```sh
./a2a/scripts/workbench
./a2a/scripts/workbench status
./a2a/scripts/workbench stop
```

启动器要求 macOS arm64 和已挂载的 `/Volumes/WD-Elements`，检查规则与 `a2a/scripts/bun` 相同。缺盘直接报错。启动前经 `a2a/scripts/bun run build:desktop` 检查标准产物，由既有构建系统处理缓存、缺失文件恢复和重建，然后后台启动 Electron。重复启动显示“已在运行”。启动成功还要求后端 `/health` 的 `startupReady=true`。进程脱离调用终端，关闭终端后继续运行；`stop` 核对 PID、启动时间和命令后向本实例发送 SIGUSR2，让桌面经既有优雅退出流程关闭后端。它只在本工作台中注册；普通界面退出保留确认框。停止超时保留现场供主控处理。

日常数据固定在 `~/Library/Application Support/a2a-workbench`：`userdata/` 保存设置、SQLite 与日志，`electron-profile/` 保存本工作台的 Electron profile。它们与官方 Synara 的数据分开。启动日志在 `workbench-launch.log`；`status` 只读，不创建目录。测试可通过 `A2A_WORKBENCH_DATA_DIR` 指定独立目录，日常使用应移除此变量。

进程身份的写入与读取都在 `LC_ALL=C` 下采集完整的 `ps lstart` 和命令，调用者的 locale 不影响记录。身份不匹配时拒绝启动、停止和门禁调用；PID 已退出时报告未运行。更新启动器身份格式前须先用当前代码停止，再更新并启动，让启动器写出新记录。

Codex 沿用 Synara 的正常 CODEX_HOME overlay：启动器保留用户 HOME 和已有 CODEX_HOME，不复制认证文件、不修改 `~/.codex`。Synara 自己在专用目录建立 overlay，使用已有登录；真实登录与模型调用不属于启动器的隔离验证。

更新时先停止，按项目既定流程拉取 fork，然后再次启动。若需主动重建：

```sh
./a2a/scripts/workbench stop
./a2a/scripts/bun run build:desktop
./a2a/scripts/workbench
```

构建缓存和工具链留在外置盘；checkout 中的 dist、node_modules 保持标准布局。不要移动、替换或链接这些目录。

主控在相同 checkout 调用门禁：

```sh
./a2a/scripts/gate status TASK_ID
./a2a/scripts/gate events TASK_ID
./a2a/scripts/gate '{"command":"reclaim","task":"TASK_ID","attempt":"ATTEMPT_ID"}'
```

其他操作传现有 `A2AGateRequest` JSON；该脚本读取 `a2a-gates/endpoint.json`，再经 HTTP 调用 `packages/a2a-gates/src/cli.ts`，不直接操作门禁数据库。请求与回执保持原门禁契约。未启动、endpoint 权限不为 0600 或进程身份不匹配时拒绝调用。

`create` 接受可选 `title`（省略时用 task id），并建立任务窗口条目；自动新建项目时用请求中的 `project` id 作为项目名，已有项目保留原名；`dispatch` 自动归入 worker 会话。主控可用 `attach` 创建带角色的普通会话，例如：

```sh
./a2a/scripts/gate '{"command":"attach","task":"TASK_ID","role":"reviewer","modelSelection":{"provider":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"high","fastMode":true}},"runtimeMode":"approval-required","instructions":"/absolute/path/review.txt"}'
./a2a/scripts/gate '{"command":"reclaim","task":"TASK_ID","thread":"ATTACHED_THREAD_ID"}'
```

`instructions` 是 UTF-8 指令文件。attach 返回 `attachment`，不产生交付 attempt，不授予 submit、验收或集成权限；其指令经 Synara 原生 turn 发送。worker 回收仍传 `attempt`，普通会话回收传 `thread`，不能同时传两者。回收必须经原生运行身份、空闲、停止与归档读回。error 会话只有在核对没有 provider 实例、没有活跃 turn、没有待批准/待回答/待处理计划交互时才可受控回收；身份不符或任一条件未知仍拒绝。run 的观察与等待收尾遇到 error 仍返回非成功，不能据此验收或集成。回收成功后保留 membership 和事件历史，任务窗口显示“已结束”。“会话归属”保留为人工修正入口，与门禁共用任务操作锁及 revision CAS。

endpoint 由桌面主进程在后端启动时原子写入，权限为 0600，保存当前本机 HTTP 地址及桌面生成的随机 backend auth token。token 每次桌面运行重新生成；后端重启时地址重新发布，token 沿用该次桌面运行；后端退出时删除 endpoint。它是 Synara 本机 owner 凭据，泄露后可操作本次后端的门禁和其他 owner 接口，并非只读或仅限门禁。不要把 endpoint、token、带认证的 URL 或环境转储加入 Git、报告或共享日志。桌面退出后旧 token 随旧后端失效；异常退出残留的 endpoint 不能通过启动器的进程身份核对。
