# 项目术语表

### 定时任务（Scheduled Task）

定义：挂在某个 channel 下的声明式任务，由任务文件（见"任务文件"）定义，随 channel 启停的调度器按调度语法触发，每次触发创建一个全新的临时 Agent 会话执行任务文件正文中的提示词，完成后把结果投递到绑定的 IM 聊天。

易混淆点：与用户在聊天里手动发起的会话完全独立；不是"在绑定聊天里执行 /new + 提示词"（该方案已明确否决，因为会重置用户会话）。

### 任务文件（Task File）

定义：`~/.config/agent-bridge/schedules/<channel>/<task-name>.md`，front matter（扁平 key:value 子集）存配置（schedule、directory、timeout、enabled、target），正文是提示词。文件名（去 .md）即任务在 channel 内的唯一键。

### 目标投递地址（target 字段）

定义：任务文件 front matter 的 `target` 字段，值是目标 IM 聊天的 clientSessionId（如 `feishu:dm:oc_xxx`），用户在目标聊天里发 `/st` 即可复制到。填写=绑定、改行=改绑、删行=解绑，全部靠热加载生效，无任何运行时绑定状态。

易混淆点：它仅是结果投递地址，不授予对目标聊天会话的任何控制；与已否决的"绑定码"（6 位随机码 + `/schedule-bind` 命令 + channel 状态持久化绑定）不是一回事。

### 合成会话（`schedule:*` 会话）

定义：定时任务触发时使用的临时 Agent 会话，其 clientSessionId 形如 `schedule:<task-name>`（per-channel 作用域）。Core 把它当普通客户端会话管理，但其输出在 GatewayCore 出口处被分流给调度器，不直接投递 IM。

### 调度语法（Schedule Grammar）

定义：任务文件 `schedule` 字段的四档简化语法：`every <n>m|h|d`、`daily HH:MM`、`weekly <day> HH:MM`、`monthly <day> HH:MM`。本地时区、分钟粒度。明确不支持完整 cron 表达式。
