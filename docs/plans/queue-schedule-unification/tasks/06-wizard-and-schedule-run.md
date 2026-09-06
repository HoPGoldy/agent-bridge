# T06: add 向导统一 + `schedule run` CLI

## 目标

两个 add 向导的问题集统一为 `name → 触发配置(schedule 表达式 | workers) → timeout →
silence → model → directory`，全走 i18n（schedule add 的硬编码英文文案一并迁移）。
queue add 末尾增加可选 body（共享上下文）提问，留空不写。新增 `agent-bridge schedule run
<task-name>` 子命令手动立即触发（调 scheduler 的 `runNow`，对齐 `/schedule-run` 同一入口）。

## 上下文

- context.md §2 D5/D6、§3「关键文件」中 cli.ts 行号锚点、「坑」第 7 条
- `src/cli.ts`：`addSchedule`（:285-335，含 buildTaskFileContent / SCHEDULE_EXAMPLES /
  validateTaskNameInput / validateScheduleInput / validateTimeoutInput）、`addQueue`
  （:471-525）、`schedule run` 无、commander 注册区（:797-903）
- `src/cli.test.ts`：wizard 相关既有用例（vi.mock 模式注意）
- `src/i18n/index.ts`：`cli.*` key 结构（en+zh）
- `runNow` 入口：`src/modules/schedule/scheduler.ts`（/schedule-run 使用的同一方法，
  CLI 侧需从进程内拿到 scheduler 实例——注意 CLI 的 start 流程如何构造 channel runner /
  scheduler，参考 `queue insert` 不需要运行时、而 `schedule run` 需要：若 CLI 命令模式
  下无运行中的 bridge，则文档化为"需在 bridge 运行目录下执行"或复用与 `/schedule-run`
  等价的进程内调用路径；实现时读 cli.ts 的 start 结构决定最直接的方式，允许为 run 子命令
  走临时构造 scheduler 的路径，但必须复用 scheduler.runNow 而非复制触发逻辑）

## 边界

只允许修改：

- `src/cli.ts` + `src/cli.test.ts`
- `src/i18n/index.ts`（en+zh 新 key：timeout/silence prompt、schedule run 输出、queue body
  prompt、schedule wizard 迁移后的全部文案）
- `docs/scheduled-tasks-spec.md`、`docs/scheduled-tasks.md`、`docs/event-queue-spec.md`、
  `docs/event-queue.md`（CLI 表、向导流程、`schedule run`）

要点：

- 向导序列严格对齐：仅第二步不同（schedule 表达式 vs workers）；timeout 预填默认 5h、
  silence 预填默认 30m（T04 之后）、留空 = 不写该行（用内置默认）；model/directory 留空
  不写行（现有惯例）。queue add 的 body 提问放最后、留空不写。
- `buildTaskFileContent` 因 silence 字段加入而扩展；`writeQueueDefinition` 已支持
  timeout/silence/body 的定义写入（若 T03 已扩展 insert 则 definition 写入路径在本 ticket
  补齐 timeout/silence——`writeQueueDefinition` 的 QueueDefinitionInput 需加 timeout/silence/
  body 透传，保持"空则不写行"）。
- `schedule run <task-name>`：校验任务存在（loadAllTasks）→ 触发 → 输出结果（成功提示
  "已触发，结果将投递到任务 target"；失败输出 reason）。不创建新触发语义，只调 runNow。
- schedule wizard 迁 i18n 时保留 SCHEDULE_EXAMPLES 常量与校验函数逻辑，仅文案外移。

## 验收

```bash
npx vitest run src/cli.test.ts   # 全绿
npx tsc --noEmit
npm run build
```

新增用例至少覆盖：两个 wizard 的问题序列与落盘 front matter（含 silence 行、空值省略）；
`schedule run` 成功输出与任务不存在报错；i18n key en/zh 齐全（快照或存在性断言）。

## 依赖

T03（writeQueueDefinition/insertQueueTask 的 timeout/silence 扩展）、T05（cli.ts 的
commander 注册区稳定后再动，避免冲突）。
