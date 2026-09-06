# T04: silence 默认 30m + 文档同步

## 目标

`DEFAULT_SILENCE_MS` 从 10m（10 * 60_000）改为 30m（30 * 60_000）。10 分钟对慢任务（长构建、
慢模型、长工具调用）太短，agent 会被过早"戳"。常量在 task-file.ts 定义、queue-file.ts import
共享，改一处两边生效。同步更新 spec 文档与向导/帮助文案中的默认值描述。

## 上下文

- context.md §2 D7
- `src/modules/schedule/task-file.ts:42-43`（DEFAULT_SILENCE_MS 定义）
- `grep -rn "10m\|10 \* 60\|silence" docs/scheduled-tasks-spec.md docs/event-queue-spec.md
  docs/scheduled-tasks.md docs/event-queue.md src/i18n/index.ts`（找所有提及默认值处）
- `grep -rn "DEFAULT_SILENCE" src/ --include="*.ts"`（确认无第二定义/硬编码 10m）

## 边界

只允许修改：

- `src/modules/schedule/task-file.ts`（常量值与注释）
- `src/modules/schedule/task-file.test.ts` / `src/modules/queue/queue-file.test.ts`
  / `src/modules/schedule/scheduler.test.ts` / `src/modules/queue/controller.test.ts`
  （仅当现有用例断言了 10m 默认值时更新为 30m）
- `docs/scheduled-tasks-spec.md`、`docs/event-queue-spec.md`、`docs/scheduled-tasks.md`、
  `docs/event-queue.md`（默认值描述）
- `src/i18n/index.ts`（若有 wizard/帮助文案提及默认 silence）

要点：

- 只改默认值与描述，不改 silence 机制本身。
- 注释里 "2026-08-19 grill, layer 2" 等出处注释更新为本次决策（2026-08-27 unification grill）。

## 验收

```bash
npx vitest run            # 全绿
npx tsc --noEmit
grep -rn "10 \* 60_000" src/   # 无残留
```

## 依赖

T01（常量位置可能随共享模块迁移；若 T01 未动该常量则无硬依赖，串行执行即可）。
