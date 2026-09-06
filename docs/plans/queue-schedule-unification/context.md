# Queue / Schedule 统一化（设计、行为与使用对齐）

## 1. 背景与目标

schedule（定时任务）与 queue（事件队列）目前"长得像但不一样"：存储层代码是复制粘贴的两份、
`/queue-here` 与 `/schedule-here` 走完全不同的实现机制、`add` 向导问题集不同、queue 任务文件
缺任务级运行参数、失败语义不一致（queue fail-and-drop 删任务文件 vs schedule 保留）。

**目标**（按用户拍板的层级 B：用户感知面 + 行为语义 + storage 工具层共享）：

1. 抽共享 front-matter 存储工具模块，消除 task-file.ts / queue-file.ts 的复制粘贴。
2. queue 引入 dead-letter 失败终态：运行失败不删任务文件，记录追溯信息，通知一次。
3. queue 任务文件补齐任务级 `model:` / `timeout:` / `silence:` 覆盖（与 `directory:` 同链）。
4. `/queue-here` 改为 adapter-local 命令，与 `/schedule-here` 同机制；core 回归纯事件转发。
5. `add` 向导问题集统一：name → 触发配置 → timeout → silence → model → directory（全 i18n）。
6. `schedule run <name>` CLI 子命令（手动立即触发，对齐 `queue insert` 的"让它干活"入口）。
7. `DEFAULT_SILENCE_MS` 从 10m 改为 30m（单一常量，两边同时生效）。

**非目标**（一句话边界）：不抽共享 run-lifecycle 框架（层级 C，留待后续）；schedule 不引入
配置级/全局 defaults 文件；不做失败自动 disable 或通知限流（用户明确否决：每次失败都通知，
修复是用户的责任）；不改 timeout 默认值（维持 5h）；不加 `/queue-run` IM 命令；不沉淀
AGENTS.md 术语（用户明确否决）。

## 2. 方案概要（关键决策，均已在 grill 中拍板）

- **D1 统一参数解析链**：任务级 > 配置级（仅容器型功能=队列定义）> 内置默认。schedule 任务
  无配置级（用户明确否决全局 defaults.md）。`model` 特例：任务级 > 队列定义 > channel agent
  config（内置默认不参与 model 链）。原则：只要是一个运行参数，就必须有任务级覆盖。
- **D2 dead-letter 失败终态**：queue 任务运行失败（session 创建后的运行期失败：超时、agent
  出错、输出投递失败）→ `state: failed`，不删文件，front matter 记录 `agentSessionId` /
  `failedAt` / `reason`，通知 target 一次（通知含 agent 会话 id）。session 创建**之前**的失败
  （任务级 directory/model 无效）不存在会话 id——这类**配置错误**维持现状语义：任务级
  directory 无效 → fail-and-drop（删文件+通知"会话未创建+原因"）；用户修复配置后重新 insert。
  修复后的重放入口：`queue retry <queue> <taskId>`（把 failed 置回 pending）。`schedule` 侧失败
  语义不变（定义保留、每次触发失败都通知，不做限流）。
- **D3 queue 任务级覆盖字段**：KNOWN_TASK_KEYS 增加 `model` / `timeout` / `silence`（directory
  已有）。`queue insert` 增加 `--model` / `--timeout` / `--silence` 旗标。生效优先级与 directory
  一致：任务级 > 队列定义级 > 内置默认。`timeout`/`silence` 解析复用 schedule 的
  `parseTimeout`。
- **D4 `/queue-here` 改 adapter-local**：照抄 `/schedule-here` 全套机制——`slash-commands.ts`
  注册 `queue.here` 解析、`types.ts` 加 `OnQueueHere` 回调 shape 与 `createClientAdapter` 参数、
  channel-runner 接到 queue controller 的绑定方法（controller 需新增公开的 claim/bind 方法，
  语义照抄 core 现有 `#handleQueueHereCommand`：校验队列存在、未绑定、channel 上下文，写
  channel+target）、各 IM 适配器接线 + i18n 文案（`client.queueHere*` 系列 key 已存在，从 core
  移到 adapter 侧使用）。删除 core 的 `#handleQueueHereCommand` 及 user.message 裸文本识别分支。
- **D5 add 向导统一**：两边问题序列 `name → 触发配置(schedule 表达式 | workers) → timeout →
  silence → model → directory`，全走 i18n（schedule add 现有硬编码英文文案一并迁移）。
  queue add wizard 增加可选 body（共享上下文）提问放最后、留空不写。
- **D6 `schedule run` CLI**：`agent-bridge schedule run <task-name>` 调 scheduler 的
  `runNow(taskName)`（`/schedule-run` 已用的同一入口；CLI 场景无触发聊天，结果照常投递到任务
  的 target）。
- **D7 silence 默认 30m**：`DEFAULT_SILENCE_MS = 30 * 60_000`，同步更新两处 spec 文档描述与
  向导预填文案。
- **D8 共享存储工具**：新建 `src/modules/shared/front-matter.ts`（或同类路径），迁移
  splitFrontMatter / parseFrontMatter / stripQuotes / nonEmptyString / applyFrontMatterField /
  writeFileAtomic（queue 侧的 expandHome 一并考虑）。task-file.ts / queue-file.ts 改为 re-export
  或直接消费，行为零变化（纯重构）。

## 3. 公共上下文（开工前必读）

技术栈：TypeScript (ESM, node>=22)，commander v12，vitest。基线：919 测试全绿。
构建 `npm run build`，类型检查 `npx tsc --noEmit`，全量测试 `npx vitest run`。

### 关键文件与行号锚点

| 文件 | 角色 |
| ---- | ---- |
| `src/modules/schedule/task-file.ts` | schedule 存储：`DEFAULT_TIMEOUT_MS`(5h)/`DEFAULT_SILENCE_MS`(:43)/`KNOWN_KEYS`/`parseTaskFile`/`setTaskEnabled`/`bindTask` |
| `src/modules/queue/queue-file.ts` | queue 存储：`KNOWN_DEFINITION_KEYS`/`KNOWN_TASK_KEYS`(state,enqueuedAt,directory)/`parseQueueDefinition`/`parseQueueTaskFile`/`insertQueueTask`/`setQueueTaskState`/`deleteQueueTask`/`bindQueue` |
| `src/modules/queue/controller.ts` | queue 运行时：`#tick`(:280-345 含队列级目录校验)、`#fire`(:350-460)、`#failFire`(:473)、`#effectiveRunTimeout`、`#registerRun`(session.new 前注册、成功后回填 agentSessionId) |
| `src/modules/schedule/scheduler.ts` | schedule 运行时：fire-time 校验模板(:455-495)、`runNow`(已有, /schedule-run 入口) |
| `src/core/gateway-core.ts` | `#handleQueueHereCommand`(:351-420, 待删除)、user.message 裸文本分支(:294-304) |
| `src/core/channel-runner.ts` | `createClientAdapter` 回调注入(:44-56, `onScheduleRun`/`onScheduleHere` 模板)、QueueController 构造(:78-85) |
| `src/modules/client/utils/slash-commands.ts` | `parseScheduleHereCommand`(:133-149 模板)、`parseSlashCommand` 总入口 |
| `src/types.ts` | `OnScheduleRun`/`OnScheduleHere`/`ScheduleHereResult`(:278-290 模板)、`ClientModule.createClientAdapter`(:317-335) |
| `src/modules/client/{feishu,wecom,weixin}/adapter/*.ts` | 三个适配器的 `schedule.here` 接线处（如 feishu:174,402-425），queue.here 照抄 |
| `src/cli.ts` | schedule add(:285-335)/queue add(:471+)/queue insert(:524+)/commander 注册(:797-903) |
| `src/i18n/index.ts` | `client.queueHere*`(en:49/zh:162)、`cli.*` wizard 文案 key |

### 已有模式（照抄即可）

- 适配器回调注入：channel-runner.ts:44-56 的 `onScheduleRun`/`onScheduleHere` 写法；
  适配器侧 feishu-im-adapter.ts:174/402-425 的解析分发与本地化回复写法。
- dead-letter 状态转换：queue-file 已有 `setQueueTaskState(name, taskId, "pending"|"running")`
  的 surgical front-matter 编辑模式，扩展 `failed` 终态时新增 `failedAt`/`reason`/`agentSessionId`
  行的写入（`applyFrontMatterField` 模式，一次原子写多行需扩展或多次组合）。
- 覆盖链合并：controller `#fire` 里 directory 的 `task.directory ?? queueDirectory` 模式，
  model/timeout/silence 照此扩展。
- `#registerRun` 在 session.new 之前注册 run 记录、成功后回填 `agentSessionId`
  (scheduler.ts:520-525 同构)，failed 落盘时该值可得。

### 坑

- `#failFire` 内含 SF-2 stale-fire guard 与 fail-and-drop（删文件）逻辑——D2 需要拆分：运行期
  失败改为置 failed 终态而非删除；删任务文件的路径仅保留给"session 创建前的配置错误"
  （任务级 directory 无效）。`queue retry` 要求任务处于 failed 态才可重放。
- controller 每次 tick 重新 `listQueueDefinitions`+`listQueueTasks`（热加载）；failed 是新终态，
  消费循环（filter pending）必须排除 failed，启动恢复逻辑（running→pending 重入队）不得把
  failed 误重入队。
- CLI 测试 `src/cli.test.ts` 对 task-file/queue-file 模块有 `vi.mock`，改导出时注意 mock 提升。
- `/queue-here` 的 `already bound` 拒绝语义（target 已存在则拒绝重绑，改绑=手改文件）保持不变。
- 三个适配器（feishu/wecom/weixin）都要接线 queue.here，漏一个就是回归。
- i18n key 命名沿用现有惯例（`client.queueHere*`、`cli.*`），en+zh 双语都要补。
- schedule add 的硬编码英文文案迁 i18n 时，`SCHEDULE_EXAMPLES` 等常量保留在 cli.ts。

## 4. 端到端验收

完成定义：D1-D8 全部落地，`npx vitest run` 全绿、`npx tsc --noEmit` 无错误、`npm run build`
成功；`grep -n "queueHere" src/core/gateway-core.ts` 无残留（除测试外）。

```bash
cd /home/wesley/project/agent-bridge
npx vitest run            # 919+ 新增测试全绿
npx tsc --noEmit
npm run build
grep -n "queueHere\|queue-here" src/core/gateway-core.ts   # 应无输出
```
