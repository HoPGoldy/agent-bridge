# Agent 失败后自动继续：方案调研记录

- 日期：2026-08-01
- 状态：仅调研，暂不实现
- 适用项目：Agent Bridge

## 1. 背景

当前 Agent Bridge 将飞书、企微等客户端连接到 Pi Coding Agent、OpenCode 等 Agent。Agent 在一次运行中可能因为模型限流、网络波动或 Provider 临时故障而返回失败。失败会终止当前 Agent run，即使原始任务和已经完成的工具操作仍保留在会话及工作区中，也需要用户手动发送“继续”才能恢复。

此前讨论过 Provider/HTTP 层的结构化重试，包括识别 HTTP 429、`Retry-After`、SSE `response.failed` 等。但这一方案需要每个 Provider 提供结构化失败信息，设计和实现相对复杂。

本次讨论的是一个更简单、位于 Agent Bridge Core 层的通用恢复机制：

> Agent run 失败后等待一段时间，然后通过现有 Agent Adapter 接口发送一条普通 `user.message`，让 Agent 根据已有会话和当前工作区状态自行继续。

它不分析 Azure、OpenAI、Anthropic 等 Provider 的具体错误，也不重新发送完全相同的 HTTP 请求。

## 2. 建议名称

该机制严格来说不是传统意义上的“重试”。

传统重试：

```text
原始模型请求失败
-> 重新发送同一个请求
```

本方案：

```text
Agent run 失败
-> 追加一条新的用户消息
-> 创建一个新的 Agent run
```

建议将配置命名为：

```ts
autoContinueOnFailure: boolean
```

配置界面可显示为：

```text
Agent 失败后自动继续
```

不建议命名为 `retryOnFailure`，以免使用者误以为系统会精确重放失败请求。

## 3. 为什么该方案通常有效

以 Coding Agent 为例，一次运行可能已经：

1. 读取文件；
2. 修改代码；
3. 执行测试；
4. 在下一次模型调用时因 Azure 限流失败。

失败后通常仍保留：

- 原始用户任务；
- 会话历史；
- 已经落盘的文件修改；
- Tool 调用及结果；
- 尚未销毁的 Agent session。

此时发送：

```text
继续之前的任务。请先检查当前状态，避免重复已经完成的操作。
```

Agent 可以重新查看当前状态并决定下一步。与精确重放相比，这种方式允许 Agent 适应已经发生变化的文件系统和工具状态。

## 4. 当前代码中的可用接口

Channel 通用配置目前定义为：

```ts
export interface ChannelCommonConfig {
  language: LocaleCode;
}
```

未来可扩展为：

```ts
export interface ChannelCommonConfig {
  language: LocaleCode;
  autoContinueOnFailure: boolean;
}
```

Core 向 Agent 发送普通用户消息的现有调用形式为：

```ts
await runtime.agentAdapter.input({
  type: "user.message",
  text,
});
```

当前 Pi Coding Agent Adapter 在 Pi assistant message 的 `stopReason` 为 `error` 时，会输出：

```ts
{
  type: "error",
  kind: "agent.run.failed",
  detail,
}
```

Core 已经统一接收并转发 `AgentOutputEvent`，因此未来可在 Core 的 Agent output 处理路径中监听该事件。

## 5. 触发范围

不应对所有 `type: "error"` 自动继续。

Agent Bridge 中还存在以下错误：

```text
agent.status.unavailable
agent.model.invalid
agent.model.busy
agent.model.set.unavailable
```

这些错误不代表 Agent 的任务运行中断。例如模型名称输错时自动发送“继续”会产生不符合预期的行为。

第一版建议只响应：

```ts
event.type === "error" &&
event.kind === "agent.run.failed"
```

以下情况不触发：

- `assistant.tool.error`；
- 模型切换错误；
- Session status 查询错误；
- IM/飞书消息投递失败；
- Channel 配置错误；
- 普通命令执行错误。

Tool error 通常会被 Agent 自身看到，Agent 可以在同一次 run 中调整方案，不等于整个 Agent run 已终止。

## 6. 建议的自动消息

不建议仅发送：

```text
继续
```

因为它没有提示 Agent 检查已经发生的副作用。建议根据 Channel language 发送：

中文：

```text
继续之前的任务。请先检查当前状态，避免重复已经完成的操作。
```

英文：

```text
Continue the previous task. Check the current state first and avoid repeating work that has already completed.
```

这仍然是普通 `user.message`，不要求 Agent Adapter 支持新的输入事件类型。

## 7. 主要风险

### 7.1 只增加成本但无法恢复

以下永久错误通常不会因为等待一分钟而恢复：

- API Key 无效；
- 模型或 deployment 不存在；
- 订阅无权限；
- 余额或月度额度耗尽；
- Context 已经溢出；
- Agent Adapter/RPC 进程已经死亡。

如果不分析错误内容，Core 无法提前识别这些情况。自动继续可能只增加一次无效模型调用。

### 7.2 自动继续后仍然失败

例如 Azure 的 TPM 限流持续超过一分钟，第二次运行仍可能失败。如果没有次数限制，会形成：

```text
失败 -> 继续 -> 失败 -> 继续 -> ...
```

这可能无限消耗 tokens 和费用。

### 7.3 重复副作用

如果失败前 Agent 已经执行了外部操作，继续后可能再次执行：

- 部署；
- 发消息；
- 创建工单；
- 数据库写入；
- 发布版本；
- 其他非幂等 API。

普通的读文件、运行测试和 build 通常风险较低，但外部写操作可能造成重复结果。因此自动消息应明确要求先检查当前状态。

### 7.4 原始消息没有进入 Agent

如果 `agentAdapter.input(originalMessage)` 在提交到 Agent 前就失败，Agent session 中可能没有原始任务。此时只发送“继续”没有意义，因为 Agent 不知道要继续什么。

所以第一版不应把 `agentAdapter.input()` 的直接异常等同于 `agent.run.failed`。只有 Agent 已接受任务并明确报告 run failure 时，才适合发送“继续”。若未来要处理 input submission failure，应考虑重发原始消息，而不是发送“继续”。

### 7.5 Adapter 或 RPC 已经死亡

“继续”只能恢复 Agent 的任务流，不能修复已经退出的进程。如果 Adapter 不再可用：

```ts
runtime.agentAdapter.input(...)
```

仍然会失败。恢复此类故障需要另一套机制：重启 Adapter、恢复 Session，再决定是否继续。

### 7.6 等待期间用户已开始新任务

可能出现：

```text
12:00:00 Agent 失败，安排 60 秒后自动继续
12:00:30 用户发送新任务
12:01:00 自动消息“继续”被发送
```

如果不取消定时器，自动消息可能干扰用户的新任务。

### 7.7 Agent 正忙时消息会成为 steer

Pi Adapter 当前使用 `prompt(..., "steer")`。如果定时器到期时 Agent 正在运行，自动“继续”可能被注入正在执行的新任务，而不是启动一个独立 run。

发送前必须调用：

```ts
await runtime.agentAdapter.isBusy()
```

若 Agent 正忙，建议取消此次自动继续，不要发送或反复延期。

## 8. 最小安全策略

虽然配置只需要一个布尔值，但内部必须包含以下约束。

### 8.1 每个失败链只自动继续一次

推荐固定：

```text
第一次 run 失败
-> 等待 60 秒
-> 自动继续一次
-> 再次失败则停止
```

不向用户暴露复杂重试策略，也不进行无限循环。

该限制把最坏额外成本控制为一次 Agent run。

### 8.2 用户活动取消待执行任务

以下操作应取消 timer：

- 任意真实 `user.message`；
- `command.session.stop`；
- `command.session.new`；
- Channel stop；
- Runtime release；
- Session 绑定发生变化。

`compact`、model set 等操作也应当取消，避免旧任务的自动消息打断管理操作。

### 8.3 发送前重新验证

定时器到期时必须确认：

- 原 runtime 仍存在；
- client 仍绑定到同一个 Agent session；
- Channel 尚未停止；
- 等待期间没有新的用户活动；
- Agent 当前不 busy；
- 该失败链尚未进行过自动继续。

### 8.4 防止陈旧定时器执行

仅调用 `clearTimeout` 不足以消除全部竞态。建议为 runtime 保存 generation：

```ts
runtime.generation += 1;
```

调度时捕获当前 generation，执行时再次比较：

```ts
if (runtime.generation !== scheduledGeneration) {
  return;
}
```

任何用户操作、Session 替换或 Runtime 停止都增加 generation。

## 9. 建议状态机

每个 runtime 可维护：

```ts
interface AutoContinueState {
  timer: NodeJS.Timeout | null;
  attempted: boolean;
  generation: number;
}
```

### 真实用户消息到达

```text
取消 timer
attempted = false
generation++
```

表示开始新的工作链，允许未来自动继续一次。

### 第一次收到 `agent.run.failed`

如果：

```text
autoContinueOnFailure = true
attempted = false
timer = null
```

则安排 60 秒后的自动继续。

### 定时器执行

```text
检查 runtime/session/generation
检查 Agent 不忙
attempted = true
发送普通 user.message
```

### 自动继续后再次失败

因为 `attempted = true`，不再调度。

### 自动继续成功

收到正常 `assistant.message` 后取消可能残留的 timer。`attempted` 可保持为 true，直到下一条真实用户消息到达，确保同一任务链最多自动继续一次。

## 10. 用户可见行为

原始错误不能因为启用了自动继续而被隐藏。建议显示：

```text
Agent 运行失败：<原始错误>

已启用自动继续，将在 60 秒后尝试继续一次。
```

执行时可显示：

```text
正在自动继续之前的任务……
```

如果自动继续后仍失败：

```text
自动继续后仍然失败，已停止自动尝试。
```

Agent 侧收到普通 `user.message`；客户端侧不应伪造用户本人发送了一条消息。客户端可以显示 system/assistant 风格的自动恢复提示，以便审计和理解会话行为。

## 11. 第一版建议规格

```text
配置：
  common.autoContinueOnFailure: boolean

触发：
  event.type === "error"
  event.kind === "agent.run.failed"

延迟：
  固定 60 秒

次数：
  每个失败链最多一次

消息：
  中文：继续之前的任务。请先检查当前状态，避免重复已经完成的操作。
  英文：Continue the previous task. Check the current state first and avoid repeating work that has already completed.

取消：
  用户输入、新建/停止 Session、管理命令、Runtime release、Session 变更、Channel stop

到期时 Agent busy：
  取消，不发送，不反复延期

第二次失败：
  不再自动继续，等待用户处理
```

## 12. 与 Provider 重试的关系

该机制不能完全替代 Provider 层重试：

- Provider retry 可以精确遵守 `Retry-After`；
- Provider retry 可以避免向会话增加新的用户消息；
- Provider retry 能处理 HTTP 建连前失败；
- 自动继续更适合处理 Agent run 已经终止、但 Session 和工作区仍可恢复的情况。

两者可以在未来共存，但第一版自动继续不需要理解 Provider 错误格式。

## 13. 结论

Core 层自动继续方案简单、跨 Agent Adapter，并且对临时限流和短暂模型错误有较高实用价值。它不是精确重试，而是一种通过新用户消息触发的 Agent 工作流恢复。

在不分析错误类型的前提下，无法避免所有无效调用。最合理的简单权衡是：

1. 只处理明确的 `agent.run.failed`；
2. 每个失败链最多自动继续一次；
3. 等待期间有任何用户活动就取消；
4. 发送前确认 Session 未变化且 Agent 不忙；
5. 自动消息要求 Agent 先检查状态，降低重复副作用风险。

本方案当前仅记录调研结论，暂不修改源码或配置。
