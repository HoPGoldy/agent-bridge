# Run History Spec (Schedule/Queue 执行留痕)

> 背景与决策过程见 `docs/grill-context/qa-log.md`（2026-08-20 "Schedule/Queue 运行历史"）。
> 本 spec 取代 `docs/scheduled-tasks-spec.md` D2 中"There is deliberately no persisted run
> history or CLI-side observability"的表述（实现时同步修订该句）。

## Goal

Schedule Task 和 Queue Task 的每次执行留下可回看的痕迹：

1. 每个 run 在**生命周期终点**向 append-only JSONL 索引导入一行（结果、耗时、上下文指针）。
2. 每个 run 的 Output File **自包含**：头部记录元数据 + prompt 全文，正文是 assistant 输出。
3. CLI `history` 子命令按任务/队列查看历史表格。
4. 需要工具调用/SubAgent 级别的细节时，顺索引行里的 **agentSessionId** 去 agent app 的
   会话存储（如 `pi-sessions/`）定位完整会话文件。

## Non-Goals

- **不记录 fire 前被校验拒绝/未绑定未触发的 skip**——它们没有 runId，维持进程 warn 日志
  （2026-08-20 qa-log：用户先要求记录、后回退，定稿不记）。
- **不记录进行中状态**——JSONL 只记终态；bridge 重启时在途 run 不补记（queue 会
  at-least-once 重跑产生新记录；schedule 的中断从进程日志排查）。
- **不在 bridge 侧记录 tool call / thinking / SubAgent**——忠实记录完整会话是 agent
  adapter 的职责且已做好（原则：bridge 不复制 adapter 的会话记录职责）。
- **不做自动清理，不加 prune 命令**——history 与 run-outputs 无限制增长，碍事时手动清理。
- **不加 IM 侧命令**——查历史是运维动作，CLI 足够。
- **不改投递行为**——投递消息与其斜体后缀（引用 Output File 路径）保持现状。

## Key Design Decisions

### D1. 存储：按模块分文件的 append-only JSONL

```
~/.config/agent-bridge/run-history/schedule.jsonl
~/.config/agent-bridge/run-history/queue.jsonl
```

- 两个模块**分开存**（原则：持久化按模块分文件，不合并）——字段演进互不影响，查询
  入口本就分挂在 `schedule` / `queue` 命令组下。
- 结构与写法和 accumulator 同一哲学：单行 `appendFile`、O_APPEND、best-effort。
  写失败只 log warn，绝不影响 run 生命周期与投递。
- 多 channel（可能多进程）共享同一文件：每行 < 1KB，O_APPEND 下单行写原子，不加锁。
- 永不清理（见 Non-Goals）。

### D2. 记录字段（所有行结构统一）

```json
{"runId":"schedule:daily-report:20260820-090000-3","ts":"2026-08-20T01:00:00.000Z","ms":252000,"outcome":"completed","channel":"feishu-dev","agent":"pi-coding-agent:a8b7c75f-ebd9-4dac-8300-df779cdc1bae","file":"/home/wesley/.config/agent-bridge/run-outputs/schedule_daily-report_20260820-090000-3.md"}
```

| 字段 | 必有 | 说明 |
|---|---|---|
| `runId` | ✓ | 合成 clientSessionId。schedule: `schedule:<task>:<yyyymmdd-hhmmss>-<seq>`（D4）；queue: `queue:<queue>:<taskId>`。任务名/队列名/taskId 由 runId 解析得出，**不重复存** |
| `ts` | ✓ | run 开始时间，ISO UTC |
| `ms` | ✓ | 耗时毫秒（终点时间 − 注册时间） |
| `outcome` | ✓ | `completed` \| `failed` \| `timeout` \| `fire-failed` |
| `reason` | 非 completed | 失败/超时原因（沿用各终点现有的文本） |
| `channel` | ✓ | 执行该 run 的 channel 配置名（多 channel 共享文件时区分写入方） |
| `agent` | session.new 成功时 | agentSessionId（`<moduleType>:<uuid>`），D5 |
| `file` | ✓ | Output File 绝对路径（头部方案保证注册的 run 必有文件，D6） |

### D3. 写入时机：只在 run 终点，每 run 恰好一行

四个终点各写一行（写入在 run 结束之后，与投递无顺序耦合）：

| 模块 | completed | failed | timeout | fire-failed |
|---|---|---|---|---|
| Scheduler | `#deliverDone` | `#handleError` | `#handleTimeout` | `#failFire` |
| QueueController | `#completeTask` | `#failTask` | `#handleTimeout` | `#failFire` |

- `stop()` 清 run 表时**不写**（在途 run 无终态，见 Non-Goals）。
- `durationMs` 用 `RunRecord.startedAt`（已有）与终点时钟之差。
- fire 前校验拒绝（disabled/目录无效/prompt 为空/无 target/属其他 channel）**不写**
  （无 RunRecord，写入路径保持统一）。

### D4. schedule runId 跨重启唯一

现状 `#runSeq` 重启归零，`schedule:<task>:1` 跨重启撞 id，history 里无法区分。改为：

```
schedule:<task-name>:<yyyymmdd-hhmmss>-<seq>
```

- 时间戳为**本地时间**紧凑格式（文件名家对人友好），seq 保留以区分同秒内的多次
  触发（`/schedule-run` 连打）。
- `parseSyntheticSessionId` / `syntheticSessionId` 同步更新（末段形如
  `\d{8}-\d{6}-\d+`）。
- 红利：`run-outputs/schedule_<task>_<ts>_<seq>.md` 文件名按时间可排序。
- queue 的 `queue:<queue>:<taskId>` 天然唯一，不动。

### D5. agentSessionId 获取：IngressResult 扩展（core 纯增量）

```ts
type IngressResult = { ok: true; agentSessionId?: string } | { ok: false; reason: string };
```

- 仅 `#handleSessionNew` 填充（返回 `newRuntime.agentSessionId`）；其余事件类型的
  ok 结果不带该字段。对既有调用方完全向后兼容。
- 两个控制器在 fire 时从 `command.session.new` 的返回里 capture，存入 RunRecord。
- **否决**事后反查 `session-bindings/<channel>.json`：绑定可能被后续 `/new` 换掉，
  fire 时捕获才是权威值。
- fire-failed 的行：session.new 成功、user.message 失败时 `agent` 存在；session.new
  本身就失败时缺席。

### D6. Output File 头部：自包含的 Markdown

`RunAccumulator` 增加 `writeHeader(fields)`，两个控制器在 registerRun 时调用（文件由
lazy 创建变为注册即建——**注册的 run 必有 Output File**，D2 的 `file` 字段因此必有）。

```markdown
---
runId: schedule:daily-report:20260820-090000-3
channel: feishu-dev
target: feishu:group:oc_xxx
trigger: tick            # schedule 专有：tick | run-now（#fire 需加参数，runNow 传 run-now）
schedule: daily 09:00    # schedule 专有
directory: /path         # schedule 专有（如有）
startedAt: 2026-08-20T01:00:00.000Z
---
# Prompt

（schedule：任务文件正文全文 / queue：队列正文 + 任务 prompt）

---

（assistant 消息逐条追加，accumulator 现有行为不变）
```

queue 头部对应字段：`runId / channel / target / queue / taskId / startedAt`。
两边头部字段可自由差异化（与 D1 分文件同理）。保持 Markdown 格式；tool 事件不入此文件。

**头部不含 `agent` 行**（设计取舍）：`writeHeader` 只能在 registerRun 时调用一次（此后
accumulator 只追加 assistant 输出），而 agentSessionId 要到 fire 的 session.new 成功后才
可知——注册时写头部则 agent 必缺席。agent 的权威记录在 history JSONL 行的 `agent` 字段
（D5，session.new 成功即有），需要时从索引行拿 agent ID 去 adapter 会话存储定位。

红利：fire-failed 的 run 也有带 prompt 头部的文件——queue 任务 fail-and-drop 删除任务
文件后 prompt 不再丢失（agent 在 history JSONL 行里查，见上）。

### D7. CLI：history 子命令（只收 name，无任何选项）

```
agent-bridge schedule history [task-name]   # 不传 name = 全部任务
agent-bridge queue history <queue-name>
```

- 读对应 JSONL，全量输出（行数少，不分页不截断），**时间倒序**。
- 列：`Time`（本地时区）/ `Name` / `Outcome` / `Duration` / `Reason` / `File`。
- Name 从 runId 解析；坏行跳过并 warn 到 stderr，不中断。
- 无 show 子命令：看详情拿 `File` 列路径自己 cat；要更深拿行内 agent ID 去 adapter
  会话存储定位（pi: `ls ~/.config/agent-bridge/pi-sessions | grep <uuid>`）。
- 纯只读，CLI 进程不需要也不接触运行中的 bridge。

## Component Map / Tickets

三个 ticket，按层划分（T2 依赖 T1，T3 依赖 T1）：

- **T1 记录基础设施**：`src/modules/run-completion/history.ts`——共享写入器
  （`appendRunHistory(kind, record)`，按 kind 路由到 `run-history/<kind>.jsonl`）+ 容错
  读取器（CLI 用）；core——`IngressResult` 加 `agentSessionId?`，`#handleSessionNew` 填充；
  schedule runId 唯一化（`syntheticSessionId` / `parseSyntheticSessionId` 及测试）。
  纯管道，无行为变化。
- **T2 控制器接入**：`RunAccumulator.writeHeader`；Scheduler/QueueController 在
  registerRun 写头部（schedule 侧 `#fire` 加 trigger 参数）、四个终点写 history
  （capture agent、算 ms）。两模块同构，一起改。
- **T3 查询面**：CLI `schedule history` / `queue history`；`config/channel-state.ts` 加
  `RUN_HISTORY_DIR`；文档同步——修订 `scheduled-tasks-spec.md` D2 的"no persisted run
  history"句、`event-queue-spec.md` 如有同类表述。
