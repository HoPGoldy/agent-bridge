# T05: `/queue-here` 迁移为 adapter-local 命令

## 目标

`/queue-here <name>` 从 core 裸文本识别迁到 adapter-local 命令机制，与 `/schedule-here`
完全同构：适配器解析 → 结构化回调 → 本地化回复，core 回归纯事件转发（删除
`#handleQueueHereCommand` 与 user.message 识别分支）。用户敲的命令文本与行为（含 already-bound
拒绝语义）零变化。

## 上下文

- context.md §2 D4、§3「关键文件」中 gateway-core/channel-runner/slash-commands/types/
  三个适配器/i18n 行号锚点、「坑」第 4/5/6 条
- 照抄模板：`src/modules/client/utils/slash-commands.ts:133-149`（parseScheduleHereCommand）
  与 `:230-243`（parseSlashCommand 接线）、`src/types.ts:278-335`（OnScheduleHere shape 与
  createClientAdapter 参数）、`src/core/channel-runner.ts:44-56`（回调注入）与 `:78-85`、
  适配器侧 `src/modules/client/feishu/adapter/feishu-im-adapter.ts:174,402-425`（wecom/weixin
  各自的对应处）
- 被删除的语义源：`src/core/gateway-core.ts:294-304, 351-420`（#handleQueueHereCommand 的
  全部校验与绑定逻辑，含 already-bound 拒绝、channel 上下文缺失拒绝）
- `src/i18n/index.ts`：`client.queueHereUsage/queueHereQueueNotFound/queueHereAlreadyBound/
  queueHereFailed`（en:49 附近 / zh:162 附近）已存在，迁移后由适配器使用
- 现有测试：`src/core/gateway-core.test.ts:3705-3790`（/queue-here 用例，迁走）、
  `src/core/channel-runner.test.ts:564-625`（onScheduleRun/onScheduleHere 暴露测试模板）

## 边界

只允许修改：

- `src/modules/client/utils/slash-commands.ts` + 其测试
- `src/types.ts`
- `src/core/channel-runner.ts` + `src/core/channel-runner.test.ts`
- `src/core/gateway-core.ts` + `src/core/gateway-core.test.ts`（删迁移的用例）
- `src/modules/client/{feishu,wecom,weixin}/adapter/*.ts`（及各自存在的 slash 接线测试）
- `src/modules/queue/controller.ts`（新增公开绑定方法，如 `claimTarget(name,
  clientSessionId)`，语义照抄 core 版：loadQueueDefinition 校验 → already-bound 拒绝 →
  channel 上下文 → bindQueue；返回 `{ ok: true } | { ok: false; reason: string }`）+
  controller.test.ts
- `src/modules/client/index.ts`（导出 OnQueueHere 相关 type，替换"deliberately NOT
  registered"注释）

要点：

- 回调命名 `onQueueHere`，参数 `(queueName, clientSessionId)`，类型 `OnQueueHere`，与
  OnScheduleHere 形状一致；`createClientAdapter` 参数可选，适配器缺省时降级（log，不回复），
  与 onScheduleHere 的降级路径一致。
- queue.here 解析：`/^\/queue-here(?:\s+(.*))?$/i`，名称小写归一化，非法名 → usage 提示
  （复用 `client.queueHereUsage` 文案）。
- channel-runner 注入：`onQueueHere: (queueName, clientSessionId) =>
  queueController.claimTarget(...)`，注意 QueueController 实例化时序与 scheduler 相同
  （let 声明、创建后赋值——channel-runner.ts:30-45 已有模式）。
- 三个适配器都要接线，行为对齐各自 schedule.here 的分发与回复方式。
- core 删除分支后，user.message 恢复直通 `#handleUserMessage`；`#common`/`#t` 若因此出现
  未用引用要清理。i18n 的 `client.queueHere*` key 迁到适配器侧使用（key 名不变）。
- 合成会话保护不变：queue.here 解析发生在适配器，用户聊天永远不会是合成会话，core 侧
  `#isSyntheticClientSession` 分支保留。

## 验收

```bash
npx vitest run src/core/ src/modules/client/ src/modules/queue/controller.test.ts  # 全绿
npx tsc --noEmit
grep -n "queueHere\|queue-here" src/core/gateway-core.ts    # 无输出
```

新增/迁移用例至少覆盖：slash 解析（合法/非法名/大小写归一）；适配器回调缺省降级；
claimTarget 成功绑定（channel+target 双行落盘）、already-bound 拒绝、队列不存在拒绝；
channel-runner 暴露 onQueueHere；core 不再处理裸文本 /queue-here（原用例删除或改写为
"直通 user.message"）。

## 依赖

无（与 T01-T04 无文件冲突，可并行；但按串行流程排在本批靠后以隔离回归面）。
