# T01: 契约与事件——types + slash 解析 + core resume 事务

## 目标

为 `/resume` 打通从命令解析到 core 事务切换的完整管道（本任务不含两个 agent 模块的接管实现，pi/opencode 侧仅按新契约透传参数、行为不变）。新建事件 `command.session.resume`：解析层产出（`/resume <id>`、`/r <id>`，无参数产出 usage 类型），core 新增 `#handleSessionResume` 完成与 `/new` 同构的事务（创建→切绑定→停旧→删旧记录），成功回复展示工作目录。

## 上下文

- 必读：`docs/plans/resume-command/context.md` 全文（决策表、源码地图、已知坑）。
- `src/types.ts`（`ClientOutputEvent`、`AgentModule.createAgentSession`、`AgentAdapter` 契约）。
- `src/modules/client/utils/slash-commands.ts` 与 `src/modules/client/utils/slash-commands.test.ts`（解析器及 usage 先例 `schedule.run.usage`）。
- `src/core/gateway-core.ts` 与 `src/core/gateway-core.test.ts`（`#handleSessionNew` 事务件、Fake module/adapter 测试基建）。
- `src/i18n/index.ts`（keys 见下）。

## 边界

允许修改：

- `src/types.ts`
- `src/modules/client/utils/slash-commands.ts` 及其测试
- `src/core/gateway-core.ts` 及其测试
- `src/i18n/index.ts`（仅新增本命令 keys，见验收）
- `src/index.ts` 仅当需要 re-export 新类型时

不得修改：三个 client adapter（T04）、两个 agent 模块（T02/T03）、其他任何文件。agent 模块对新参数的"消费"不在本任务——`createAgentSession` 透传 `providerSessionId` 后现有实现忽略它即可（TS 层面不破坏）。

## 实现要求

1. `types.ts`：
   - `ClientOutputEvent` 增加 `{ type: "command.session.resume"; clientSessionId: string; providerSessionId: string }`。
   - `AgentModule.createAgentSession` args 增加可选 `providerSessionId?: string`（注释说明仅 resume 命令携带）。
   - `AgentAdapter` 增加可选 `getWorkingDirectory?(): Promise<string | undefined>`。
2. `slash-commands.ts`：
   - 新增 `parseResumeCommand`：正则 `/^\/(resume|r)(?:\s+(.*))?$/i`；无参数产出本地类型 `{ type: "command.session.resume.usage"; clientSessionId }`（仿 `ScheduleRunUsageCommand` 导出 interface）；有参数时 trim 后非空即透传，**不做任何格式校验**（决策 4）。
   - 接入 `parseSlashCommand` 返回联合类型；`resolveSlashCommandEvent` 对 resume 事件原样放行。
3. `gateway-core.ts` `#handleSessionResume(clientSessionId, providerSessionId)`：
   - 合成会话（`#isSyntheticClientSession`）防御性忽略（debug 日志 + 返回 ok）。
   - 事务流程与 `#handleSessionNew` 同构：`#createRuntimeForClient(clientSessionId, { providerSessionId })` → `#switchClientToAgent`（含旧记录删除语义）→ 停旧 runtime → 成功回复。创建/提交失败路径清理新 runtime 并回复失败（对齐 `#handleSessionNew` 的既有错误分支）。
   - 成功回复文案：`gateway.resumedSession`，参数 `{ sessionId, workingDirectory }`；目录通过新契约 `agentAdapter.getWorkingDirectory?.()` best-effort 获取（undefined/抛错则省略目录段——实现方式：i18n 文案分带目录/不带目录两个 key，或目录为 undefined 时传空并使用另一 key，二选一，保证中英文完整）。
4. `i18n/index.ts` 新增 keys（中英成对）：`client.resumeUsage`、`gateway.resumedSession`（及若采用的"无目录"变体 key）、`gateway.failedToResumeNewSession`（接管失败文案，带 `{ detail }`）。同时在 `client.helpMessage` 中英文各追加一行 resume 说明。

## 验收

- `pnpm test` 全绿，其中新增测试覆盖：
  - 解析：`/resume x`、`/r x`、大小写、无参数 usage、多余空格 trim、非 resume 文本不受影响。
  - core：resume 成功→切换绑定+旧记录删除+成功回复含目录；`getWorkingDirectory` 缺失/undefined→回复省略目录；创建失败→原会话原样保留+失败回复；合成会话忽略。
  - i18n：新增 keys 中英文存在且 helpMessage 含 resume 行。
- `pnpm build` 通过（新契约字段类型正确）。
