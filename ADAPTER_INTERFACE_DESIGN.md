# Adapter Interface 设计讨论记录

## 目标

为新的 IM ↔ Agent 架构定义一套**双向 Adapter 接口**。

当前约束：

- **IM 侧先只做 Feishu**
- **Agent 侧先只做 Pi**
- Core 尽量保持薄，只负责：
  - 转发
  - 会话路由
  - 队列 / 缓冲
  - 生命周期管理
- Core **不负责**：
  - IM 平台展示策略
  - 什么时候调用哪个平台 API
  - agent 输出如何渲染成消息 / 卡片 / 进度条

---

## 关键设计原则

### 1. 双向 Adapter

采用对称结构：

- **IM Adapter 的输出 = Agent Adapter 的输入**
- **Agent Adapter 的输出 = IM Adapter 的输入**

也就是说，它们通过两套共享协议对接：

- `AgentIngressEvent`
- `AgentEgressEvent`

Core 只负责在这两个协议之间做路由和调度。

---

### 2. Core 不做表现层逻辑

以下逻辑不应该固化在 Core：

- 一条 agent 输出应该发成普通文本还是富文本卡片
- 应该调用 send 还是 update / edit
- 是否显示 typing
- slash command 的结果如何在 Feishu 里渲染
- 同样一条 agent 事件，在两个 Feishu adapter 里展示成不同样式

这些都应该放在 **IM Adapter** 里完成。

同理，IM 输入如何解释成 agent 协议，也应该放在 **IM Adapter** 里：

- 飞书按钮点击是否转成 approval / interaction
- 某种 message callback 是否翻译成 session control
- 某条消息是普通文本还是 command

---

### 3. 不做泛型父接口抽象

虽然 IM Adapter 和 Agent Adapter 目前都长得很像：

- `start()`
- `stop()`
- `input()`
- `isBusy()`

但**不建议先抽一个泛型 `DuplexAdapter<TInput, TOutput>` 父接口**。

原因：

- 现在相似，不代表以后职责相同
- 两者未来可能长出各自独有 API
- 过早抽象会限制演化

因此更推荐：

- **直接写两个独立接口**
- 形状相似即可
- 不强制通过继承 / 泛型统一

---

### 4. `isBusy()` 保持简单布尔语义

当前架构前提：

> **每一个 AgentAdapter 实例只绑定一个 session**

因此，`AgentAdapter.isBusy()` 不需要区分：

- global
- session-scoped
- channel-scoped

它只需要回答：

> 这个 adapter 现在是否忙。

同样，`IMAdapter.isBusy()` 也可以保持简单语义：

> 我现在是否适合继续消费下一个 `AgentEgressEvent`。

所以当前阶段不引入 `scope` 概念。

---

## 最终接口草案

## 1. IM Adapter

```ts
interface IMAdapter {
  start(
    onOutput: (event: AgentIngressEvent) => Promise<void> | void
  ): Promise<void>;

  stop(): Promise<void>;

  input(event: AgentEgressEvent): Promise<void>;

  isBusy(): Promise<boolean>;
}
```

### 语义

- `start(onOutput)`
  - 启动 IM 连接
  - 当 IM 收到输入后，将其转成 `AgentIngressEvent`
  - 通过 `onOutput(event)` 向 Core 发出

- `stop()`
  - 停止 IM 连接，释放资源

- `input(event)`
  - 接收来自 Core 的 `AgentEgressEvent`
  - 由 adapter 决定如何映射为 Feishu API 调用和展示效果

- `isBusy()`
  - 表示 IM adapter 当前是否繁忙，不适合立刻消费新的 output event

---

## 2. Agent Adapter

```ts
interface AgentAdapter {
  start(
    onOutput: (event: AgentEgressEvent) => Promise<void> | void
  ): Promise<void>;

  stop(): Promise<void>;

  input(event: AgentIngressEvent): Promise<void>;

  isBusy(): Promise<boolean>;
}
```

### 语义

- `start(onOutput)`
  - 启动 agent runtime / session
  - 当 agent 产生输出时，将其转成 `AgentEgressEvent`
  - 通过 `onOutput(event)` 发回 Core

- `stop()`
  - 停止该 agent runtime，释放资源

- `input(event)`
  - 接收来自 Core 的 `AgentIngressEvent`
  - 推进 agent 会话

- `isBusy()`
  - 表示该 session 对应的 agent 是否正在忙

---

## `input()` 的约定

建议约定：

> `input()` 表示“成功接收并开始处理这个事件”，而不是“整个处理流程已经完成”。

也就是说：

- `await adapter.input(event)` 只表示 adapter 已接住输入
- 后续结果通过 `onOutput(...)` 异步持续返回

这样与流式事件输出模型一致。

---

## Core 的职责

在当前设计下，Core 只负责：

1. 接收 IM Adapter 发出的 `AgentIngressEvent`
2. 根据 `sessionId` 找到 / 创建对应的 AgentAdapter
3. 将 ingress event 转发给 AgentAdapter
4. 接收 AgentAdapter 发出的 `AgentEgressEvent`
5. 转发给 IMAdapter
6. 通过 `isBusy()` + 队列处理缓冲与顺序
7. 管理 adapter 生命周期

Core **不负责**：

- 决定如何发送 Feishu 消息
- 决定是否编辑消息还是发新消息
- 决定进度条/富文本/按钮样式
- 决定 command 在平台上的最终呈现形式

---

## 队列 / 缓冲策略

当前讨论结论：

- Core 可以维护自己的缓冲队列
- 当某个 adapter `isBusy() === true` 时，暂缓向其发送下一个 event
- 可通过轮询方式继续重试，例如：
  1. 每隔固定时间轮询一次 `isBusy()`
  2. 如果为 `true`，继续等待
  3. 如果为 `false`，发送下一个 event

### 当前前提

- 1 个 IMAdapter
- 多个 AgentAdapter
- 每个 AgentAdapter 对应 1 个 session

所以：

- Agent 侧的 busy 判定天然是 session 级的
- IM 侧的 busy 判定天然是单 adapter 级的

> 备注：轮询间隔应作为可配置项，默认值后续再定（例如 300ms / 500ms / 1000ms）。

---

## 当前阶段明确不做的事情

- 不引入 `scope` 化的 `isBusy(scope)`
- 不引入泛型父接口抽象
- 不在 Core 中固化展示策略
- 不在接口层区分 global/session/channel 级 busy 语义
- 不把 IM 行为逻辑提前抽到 Core

---

## 当前达成的共识

1. **采用双向 Adapter 架构**
2. **IM Adapter 与 Agent Adapter 是两个独立接口，不抽泛型父类**
3. **两侧共享 ingress / egress 协议**
4. **Core 只做转发、路由、队列、生命周期管理**
5. **展示策略 / 平台 API 选择放在 IM Adapter 中**
6. **每个 AgentAdapter 只绑定一个 session，因此 `isBusy()` 只需要简单布尔值**
7. **Core 可以基于 `isBusy()` 做轮询和缓冲队列控制**

---

## MVP 事件集合（已确认）

当前确认采用**最小可用闭环**，只保留 2 个事件：

### 1. AgentIngressEvent

```ts
type AgentIngressEvent = {
  type: 'user.message';
  sessionId: string; // 由 IMAdapter 生成
  text: string;
};
```

### 2. AgentEgressEvent

```ts
type AgentEgressEvent = {
  type: 'assistant.message';
  sessionId: string;
  text: string;
};
```

### 当前明确不进入 MVP 的内容

先不进入协议：

- `session.control`
- streaming / delta
- typing
- progress / tool events
- artifact / file / image
- approval / interaction
- read receipt
- attachments

这些都等最小链路跑通后再扩展。

---

## 最新确认的 MVP 决策

### sessionId 生成

由 **IMAdapter 生成**。

当前 Feishu 规则固定为：

- 私聊：`feishu:dm:<chatId>`
- 群聊：`feishu:group:<chatId>`

说明：

- 群聊天然共享一个 session
- 如果用户不想和别人串上下文，应直接私聊 bot

### 队列策略

采用两条 FIFO 队列：

1. **IM -> Agent**
   - FIFO
   - busy 时只排队，不丢弃

2. **Agent -> IM**
   - FIFO
   - busy 时只排队，不丢弃

### 轮询间隔

- 默认 `500ms`
- 作为配置项暴露

### `input()` 语义

`input()` 返回时，只表示：

> 事件已被 adapter 接收并开始处理

不表示整个流程已经完成。

### AgentAdapter 生命周期

- 每个 AgentAdapter 对应一个 session
- 按需创建
- 空闲超时后释放
- 收到同一 `sessionId` 的后续消息时允许重建

### 队列上限

- 默认每条队列上限为 **10**

### 输出策略

- 一轮 agent 处理，最终只发一条 `assistant.message`
- MVP 只做纯文本
- 不做卡片、不做编辑、不做 typing

---

## CLI 设计（MVP）

命令行工具名称：

```bash
agent-bridge
```

### 命令集合

#### 1. `agent-bridge add`

交互式创建一个渠道配置。

行为：

- 选择 IM adapter 类型（当前只支持 `feishu`）
- 输入 channel 名称
- 调用对应 adapter 的配置交互逻辑，填写必要配置
- 将结果写入本地配置文件

#### 2. `agent-bridge ls`

列出所有已创建的渠道配置。

#### 3. `agent-bridge remove <channel-name>`

删除指定渠道配置。

#### 4. `agent-bridge start <channel-name>`

启动指定渠道。

说明：

- 前台运行
- 一个启动实例只包含：
  - 一个 Core
  - 一个 IMAdapter
  - 多个 AgentAdapter
- 用户 `Ctrl+C` 即停止该实例

---

## 配置文件位置

固定为：

```text
~/.config/agent-bridge/config.json
```

---

## 配置文件结构（当前草案）

```json
{
  "channels": {
    "my-feishu": {
      "type": "feishu",
      "appId": "cli_xxx",
      "appSecret": "xxx"
    }
  },
  "defaults": {
    "pollIntervalMs": 500,
    "maxQueueSize": 10,
    "agentIdleTimeoutMs": 600000
  }
}
```

说明：

- `add`：向 `channels` 增加条目
- `ls`：读取 `channels`
- `remove`：删除 `channels[name]`
- `start <name>`：读取 `channels[name]` 并启动

---

## ConfigAdapter 概念

除了 IMAdapter 和 AgentAdapter 之外，补充一个 **ConfigAdapter** 概念。

### 作用

用于 `agent-bridge add` 阶段，负责：

- 根据 adapter 类型交互式采集必要配置
- 输出可持久化的配置对象
- 对采集出的配置做最小校验
- （可选）输出简短摘要供 `ls` 命令展示

### 设计动机

不同 IM adapter 所需配置不同：

- Feishu 需要 `appId` / `appSecret`
- 未来 Telegram / Slack / Discord 会有不同字段

如果把这些交互式问题都固化在 CLI 主逻辑里，会导致 `add` 命令越来越重。

因此引入：

> **每种 IM adapter 自带自己的配置采集逻辑**

这样 `agent-bridge add` 只负责：

1. 选择 adapter 类型
2. 调用对应 `ConfigAdapter`
3. 获取配置对象
4. 写入 `~/.config/agent-bridge/config.json`

### 最小接口草案

```ts
interface ConfigAdapter<TConfig = unknown> {
  readonly type: string;

  collect(ctx: ConfigCollectContext): Promise<TConfig>;

  validate(config: TConfig): Promise<void> | void;

  summarize?(config: TConfig): string;
}
```

### `ConfigCollectContext` 草案

```ts
interface ConfigCollectContext {
  input(label: string, opts?: {
    defaultValue?: string;
    required?: boolean;
    secret?: boolean;
    validate?: (value: string) => string | null;
  }): Promise<string>;

  select(label: string, options: Array<{
    label: string;
    value: string;
  }>): Promise<string>;

  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
}
```

### 设计说明

- `collect()`：负责交互式提问并返回配置对象
- `validate()`：负责最小合法性检查
- `summarize()`：可选，用于 `ls` 输出摘要
- 当前阶段不做 JSON Schema / 表单 DSL / 通用配置向导系统
- 当前阶段不把 AgentAdapter 纳入 ConfigAdapter 体系

### Feishu 的最小配置对象（MVP）

```ts
interface FeishuChannelConfig {
  type: 'feishu';
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
}
```

### 当前定位

MVP 阶段：

- 只需要 **FeishuConfigAdapter**
- 先服务于 `add` 命令
- AgentAdapter(Pi) 通过 RPC 连接，不纳入当前 `add` 的交互配置范围
