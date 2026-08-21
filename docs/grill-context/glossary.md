# 项目术语表

### 禁用（disable / enabled: false）

定义：schedule 定时任务和 queue 两类顶层对象的持久开关（front matter `enabled` 字段，缺省/非 `false` 即启用，仅显式 `false` 禁用）。disable 后：自动调度/消费一律跳过、`/schedule-run` 拒绝、在途 run 不打断、pending 任务保留堆积；显式 enable 后恢复（schedule 的 nextRun 从当前时钟重算不补跑，queue 的 backlog 自动 drain）。切换入口 = CLI `enable/disable` 子命令或 AI 编辑文件（无 IM 命令）。

易混淆点：queue 内单条排队任务没有 disable——"跳过某一条"= 删掉该 task 文件；它也不是一次性跳过（不会自动恢复）。

### 定时任务（Scheduled Task）

定义：挂在某个 channel 下的声明式任务，由任务文件（见"任务文件"）定义，随 channel 启停的调度器按调度语法触发，每次触发创建一个全新的临时 Agent 会话执行任务文件正文中的提示词，完成后把结果投递到绑定的 IM 聊天。

易混淆点：与用户在聊天里手动发起的会话完全独立；不是"在绑定聊天里执行 /new + 提示词"（该方案已明确否决，因为会重置用户会话）。

### 任务文件（Task File）

定义：`~/.config/agent-bridge/schedules/<task-name>.md`（去 channel 化改造后：所有 channel 共享一个目录，不再按 channel 分目录），front matter（扁平 key:value 子集）存配置（schedule、directory、timeout、enabled、target、channel），正文是提示词。文件名（去 .md）即任务的全局唯一键。

### 会话绑定 map（bindings）

定义：GatewayCore 的 `#clientToAgentSession`（clientSessionId → agentSessionId），记录"这个聊天由本 channel 服务过"。持久化在 channel 状态文件的 `bindings` 字段，启动时 rehydrate。填充时机是聊天第一次创建 agent 会话；adapter-local 命令（如 `/schedule-here`、`/st`）不产生 binding。

易混淆点：它不是 Client Adapter 的状态，adapter 无法直接访问；也不是"bot 能投递到的聊天清单"——投递走 adapter API，不要求聊天在 map 里。

### 归属 channel（channel 字段）

定义：任务文件 front matter 的 `channel` 字段，值是 channel 配置名，由处理 `/schedule-here` 的 channel 在绑定时写入。运行时每个 channel 扫描全部任务，只触发 `channel` 等于自己名字的任务。未绑定的任务没有 channel，不会被任何 channel 触发。

### 目标投递地址（target 字段）

定义：任务文件 front matter 的 `target` 字段，值是目标 IM 聊天的 clientSessionId（如 `feishu:dm:oc_xxx`），由 `/schedule-here` 在目标聊天里发送时写入。已绑定的任务再次 `/schedule-here` 会被拒绝，需先解绑。

易混淆点：它仅是结果投递地址，不授予对目标聊天会话的任何控制；与已否决的"绑定码"（6 位随机码 + `/schedule-bind` 命令 + channel 状态持久化绑定）不是一回事。

### 合成会话（`schedule:*` 会话）

定义：定时任务触发时使用的临时 Agent 会话，其 clientSessionId 形如 `schedule:<task-name>`（per-channel 作用域）。Core 把它当普通客户端会话管理，但其输出在 GatewayCore 出口处被分流给调度器，不直接投递 IM。

### 调度语法（Schedule Grammar）

定义：任务文件 `schedule` 字段的四档简化语法：`every <n>m|h|d`、`daily HH:MM`、`weekly <day> HH:MM`、`monthly <day> HH:MM`。本地时区、分钟粒度。明确不支持完整 cron 表达式。

### 运行历史（Run History）

定义：`~/.config/agent-bridge/run-history/` 下的 append-only JSONL 索引文件（schedule.jsonl / queue.jsonl 分开存），每次 run 结束（completed/failed/timeout/fire-failed）写一行：runId、ts、ms、outcome、reason?、channel、agent?（agentSessionId）、file（Output File 路径）。只作索引，不存详情。

易混淆点：它不是日志全文——assistant 输出全文在 Output File，工具调用/SubAgent 细节在 agent adapter 的 session file（靠 agent 字段定位）。

### 运行输出文件（Output File）

定义：`~/.config/agent-bridge/run-outputs/<run-id>.md`，run 注册时写入 front matter 头部（runId/channel/target/startedAt）+ `# Prompt` 全文，run 期间由 accumulator 逐条追加 assistant 消息，run 结束后保留，投递消息的斜体后缀引用它。刻意保持简单：不记 tool call / thinking。

易混淆点：它不是完整会话记录；完整记录在 agent adapter 的 session file（如 pi-sessions/*.jsonl）。
