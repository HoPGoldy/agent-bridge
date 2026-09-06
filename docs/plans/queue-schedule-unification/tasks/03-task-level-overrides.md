# T03: queue 任务级 model/timeout/silence 覆盖

## 目标

queue 任务文件补齐任务级运行参数：`model:` / `timeout:` / `silence:`（`directory:` 已有），
生效优先级统一为 任务级 > 队列定义级 > 内置默认（model 特例：任务级 > 队列定义级 > channel
agent config，无内置默认参与）。`queue insert` 增加 `--model` / `--timeout` / `--silence`
旗标。原则：只要是一个运行参数，就必须有任务级覆盖。

## 上下文

- context.md §2 D1/D3、§3「关键文件」「坑」
- `src/modules/queue/queue-file.ts`：`KNOWN_TASK_KEYS`、`QueueTask`、`insertQueueTask`
- `src/modules/queue/controller.ts`：`#fire` 的覆盖链合并点（directory 的
  `task.directory ?? queueDirectory` 模式）、`#effectiveRunTimeout`、silence 探测循环
- `src/modules/schedule/grammar.ts`：`parseTimeout`（duration 语法复用）
- `src/cli.ts`：`insertQueueCommand`（:524+）与 commander 注册
- `src/cli.test.ts` queue insert 相关区

## 边界

只允许修改：

- `src/modules/queue/queue-file.ts` + 测试
- `src/modules/queue/controller.ts` + 测试
- `src/cli.ts` + `src/cli.test.ts`
- `docs/event-queue-spec.md`、`docs/event-queue.md`

要点：

- 存储层：`KNOWN_TASK_KEYS` 加 `model` / `timeout` / `silence`；`QueueTask` 加
  `model?: string`、`timeoutMs?: number`、`silenceMs?: number`（解析失败进 errors 任务
  置 null，与 definition 侧同规则）；`insertQueueTask` options 扩展三个字段，"空则不写行"
  惯例与 directory 一致。注意：此 ticket 先不加 failed 相关 key（T02 并行演进时以 T02 为准
  合并 KNOWN_TASK_KEYS，二者 key 集合并集、互不冲突）。
- controller：`#fire` 里 model 改为 `task.model ?? definition.model`；timeout 改为
  `task.timeoutMs ?? definition.timeoutMs ?? DEFAULT_TIMEOUT_MS`（经 `#effectiveRunTimeout`
  或等价合并）；silence 探测窗口同样任务级覆盖（definition 的 silenceMs 只作回退）。
  解析链落点集中在 `#fire` 开头，一处可读。
- CLI：`queue insert <name> --prompt ... [--model M] [--timeout 10m] [--silence 30m]
  [--directory D]`，timeout/silence 在 CLI 层用 parseTimeout 预校验（坏值直接报错退出），
  model 原样落盘（fire 时校验，惯例不变）。
- 文档：覆盖链表格更新为四字段统一链。

## 验收

```bash
npx vitest run src/modules/queue/ src/cli.test.ts   # 全绿
npx tsc --noEmit
```

新增用例至少覆盖：仅任务级 model 生效、仅队列级生效、都有时任务级胜出、都无时 undefined
（走 channel config）；timeout/silence 各档回退含内置默认；insert 旗标落盘正确、坏
timeout 被拒；存储层坏值解析进 errors。

## 依赖

T01（共享解析工具）。
