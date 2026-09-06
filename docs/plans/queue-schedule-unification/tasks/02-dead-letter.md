# T02: queue dead-letter 失败终态 + `queue retry`

## 目标

queue 任务运行失败不再删除任务文件（废除运行期 fail-and-drop）：置 `state: failed` 终态，
任务文件 front matter 记录 `agentSessionId` / `failedAt` / `reason`，通知 target 一次且
通知中携带 agent 会话 id（或"会话未创建"+原因）。新增 `queue retry <queue> <taskId>` CLI
子命令把 failed 任务置回 pending。失败可追溯是本 ticket 的核心验收点。

## 上下文

- context.md §2 D2、§3「关键文件」中 controller/queue-file 行号锚点、「坑」前三条
- `src/modules/queue/controller.ts`：`#tick`（消费循环 filter）、`#fire`、`#failFire`、
  `#onTimeout`（:590-620 附近）、`#registerRun`、启动恢复（running→pending）
- `src/modules/queue/queue-file.ts`：`TASK_STATES`、`setQueueTaskState`、`parseQueueTaskFile`
- `src/modules/queue/controller.test.ts`：createHarness 模式
- `src/cli.ts`：queue 子命令注册区（:847-903）与 `src/cli.test.ts` 对应区

## 边界

只允许修改：

- `src/modules/queue/queue-file.ts` + 测试
- `src/modules/queue/controller.ts` + 测试
- `src/cli.ts` + `src/cli.test.ts`（retry 子命令）
- `src/i18n/index.ts`（新增 key：失败通知带会话 id、retry 文案；en+zh）
- `docs/event-queue-spec.md`、`docs/event-queue.md`（失败语义与 retry 文档）

要点：

- 存储层：`TASK_STATES` 加 `failed`；`KNOWN_TASK_KEYS` 加 `failedAt` / `reason` /
  `agentSessionId`（可选，仅 failed 态出现）；`QueueTask` 接口加对应可选字段；新增
  `failQueueTask(name, taskId, { agentSessionId?, reason })` —— 一次原子写完成
  state+failedAt+reason+agentSessionId 多行（扩展 applyFrontMatterField 组合或新助手，注意
  多字段需单次原子写，不可多次 rename）。`failedAt` 为 ISO 时间戳。
- 消费循环：tick 的任务过滤只取 pending；启动恢复只把 running 置回 pending，failed 不动。
- controller：`#failFire` 拆分——session 创建成功后的运行期失败（session.new/user.message
  dispatch 失败、超时、agent 输出投递失败等）改调 `failQueueTask` + 单次通知；任务级
  directory 无效（session 创建前、无会话 id）维持删文件 + 通知"会话未创建 + 原因"。
  通知文案 i18n，运行期失败必须包含 agentSessionId（记录存在时）。
- `queue retry <queue> <taskId>`：校验任务存在且 state=failed → 置回 pending（清不清
  failedAt/reason/agentSessionId 皆可，倾向清除，保持文件干净）；非 failed 报错。
  retry 只是置状态，消费由下个 tick 自然完成。
- 超时路径（`#onTimeout`）同样落 failed 而非删除。

## 验收

```bash
npx vitest run src/modules/queue/ src/cli.test.ts   # 全绿
npx tsc --noEmit
```

新增用例至少覆盖：运行期失败 → 任务文件存在且 state=failed、front matter 含
agentSessionId/failedAt/reason、target 收到一次含会话 id 的通知；超时 → 同上；任务级
directory 无效 → 仍删文件、通知含"会话未创建"；tick 不消费 failed；启动恢复不把 failed
重入队；`queue retry` 置回 pending 后被消费、对非 failed 报错。

## 依赖

T01（消费共享 front-matter 工具，多字段原子写助手建立在共享模块上）。
