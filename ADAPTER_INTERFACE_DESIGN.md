# Adapter Interface 设计讨论记录

## 目标

为 `agent-bridge` 定义一套清晰的 **Client ↔ Core ↔ Agent** 双侧适配架构。

当前范围：

- Client side v1: **Feishu**
- Agent side v1: **Pi RPC**
- 一个 channel = 一个 client side + 一个 agent side

核心原则：

- Core 尽量保持薄
- Core 负责：
  - 会话绑定
  - 生命周期管理
  - 事件转发
  - `/new` / `/compact` 这类控制语义
- Core 不负责：
  - IM 展示策略
  - 平台 API 选择
  - 队列合并/批处理/消息折叠
  - agent 平台特定的会话创建细节

---

## 总体架构

```text
Client Adapter -> Core -> Agent Adapter
Agent Adapter  -> Core -> Client Adapter
```

更准确地说：

- ClientAdapter 产出的是 **ClientIngressEvent**
- Core 路由后投递给 AgentAdapter 的是 **AgentInputEvent**
- AgentAdapter 产出的是 **AgentOutputEvent**
- Core 再反查并发给 ClientAdapter 的是 **ClientEgressEvent**

这四套边界事件语义不同，不再共用同一个 `sessionId` 字段。

---

## 命名规则

后续设计里不再使用模糊的 `sessionId` 命名。

统一显式命名为：

- `clientSessionId`
- `agentSessionId`

原因：

- client 侧的会话标识由 client adapter 决定
- agent 侧的会话标识由 agent module / agent runtime 决定
- 两者不是同一命名空间，不能再用一个同名字段假装对称

---

## 运行时接口

## IMAdapter

```ts
interface IMAdapter {
  start(onOutput: (event: ClientIngressEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  input(event: ClientEgressEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}
```

语义：

- `start(onOutput)`
  - 启动 client 连接
  - 收到外部输入后转成 `ClientIngressEvent`
  - 通过 `onOutput(event)` 发给 Core
- `input(event)`
  - 接收来自 Core 的 client 输出事件
  - 是否立即发送、是否编辑、是否合并、是否折叠，都由 adapter 自己决定
- `input()` 返回只表示：
  - adapter 已接收并纳入自己的内部处理流程
  - **不表示整个消息已经真正发出**

## AgentAdapter

```ts
interface AgentAdapter {
  start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  abort?(): Promise<void>;
  input(event: AgentInputEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}
```

语义：

- 一个 `AgentAdapter` 实例只绑定一个 `agentSessionId`
- `input(event)` 返回只表示：
  - adapter 已接收该事件并纳入自己的内部处理流程
- `abort()` 是可选能力
  - 主要用于 `/new` 之类的强控制操作
- `stop()` 停止该 session 对应的 runtime，并清理该实例内部状态

---

## 为什么不抽泛型父接口

虽然 `IMAdapter` 和 `AgentAdapter` 当前都长得像：

- `start()`
- `stop()`
- `input()`
- `isBusy()`

但当前仍然不建议抽一个统一的 `DuplexAdapter<TInput, TOutput>`：

- 两侧未来职责未必持续对称
- Agent 侧已经出现了 `abort?()` 这类特有能力
- Client 侧未来也可能出现自己的专属 API
- 过早抽象会限制演进

因此仍保留：

- `IMAdapter`
- `AgentAdapter`

两个独立接口。

---

## 模块层设计

配置能力不并入运行时 adapter instance，而是并入模块层。

## ConfigAdapter

```ts
interface ConfigAdapter<TConfig = unknown> {
  collect(ctx: ConfigCollectContext): Promise<TConfig>;
  validate(config: TConfig): Promise<void> | void;
  summarize?(config: TConfig): string;
}
```

## ClientModule

```ts
interface ClientModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createClientAdapter(config: TConfig): IMAdapter;
}
```

## AgentModule

```ts
interface AgentModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;

  createAgentSession(args: { config: TConfig }): Promise<{
    agentSessionId: string;
    agentAdapter: AgentAdapter;
  }>;

  resumeAgentSession?(args: { config: TConfig; agentSessionId: string }): Promise<AgentAdapter>;
}
```

### 设计说明

- `createAgentSession()` 由 agent module 自己创建新会话
- `agentSessionId` **由 agent module 决定并返回**
- Core **不负责生成** `agentSessionId`

原因：

- 不同 agent 对 session id 的规则不同
- 有的要求特定格式
- 有的会做归一化
- 有的甚至不支持由外部指定 session id

所以：

> Core 只保存和使用 `agentSessionId`，不生成它。

---

## ConfigCollectContext

```ts
interface ConfigCollectContext {
  input(
    label: string,
    opts?: {
      defaultValue?: string;
      required?: boolean;
      secret?: boolean;
      validate?: (value: string) => string | null;
    },
  ): Promise<string>;

  select(
    label: string,
    options: Array<{
      label: string;
      value: string;
    }>,
  ): Promise<string>;

  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
}
```

---

## 配置结构

一个 channel = 一个 client side + 一个 agent side。

```json
{
  "channels": {
    "my-feishu": {
      "client": {
        "type": "feishu",
        "config": {
          "appId": "cli_xxx",
          "appSecret": "xxx",
          "domain": "feishu"
        }
      },
      "agent": {
        "type": "pi-coding-agent",
        "config": {}
      }
    }
  },
  "defaults": {
    "agentIdleTimeoutMs": 600000
  }
}
```

说明：

- `pollIntervalMs` 已从 Core 配置中移除
- `maxQueueSize` 已从 Core 配置中移除
- 如果某个 adapter 需要这些能力，应由自己的 config / config collector 设计对应参数

---

## 事件模型

## Client -> Core

```ts
type ClientIngressEvent =
  | {
      type: "user.message";
      clientSessionId: string;
      text: string;
    }
  | {
      type: "command.session.new";
      clientSessionId: string;
    }
  | {
      type: "command.session.compact";
      clientSessionId: string;
    };
```

## Core -> Agent

```ts
type AgentInputEvent =
  | {
      type: "user.message";
      text: string;
    }
  | {
      type: "command.session.compact";
    };
```

说明：

- `command.session.new` 只在 Core 层处理
- 不会下发到 AgentAdapter

## Agent -> Core

```ts
type AgentOutputEvent = {
  type: "assistant.message";
  agentSessionId: string;
  text: string;
};
```

## Core -> Client

```ts
type ClientEgressEvent = {
  type: "assistant.message";
  clientSessionId: string;
  text: string;
};
```

---

## Core 的职责

Core 现在只负责：

1. 接收 `ClientIngressEvent`
2. 维护 `clientSessionId <-> agentSessionId` 绑定
3. 按需创建 / 恢复 / 停止 `AgentAdapter`
4. 处理 `command.session.new`
5. 将 `command.session.compact` 路由给当前 active agent session
6. 接收 `AgentOutputEvent`
7. 通过 `agentSessionId -> AgentRuntime -> clientSessionId` 反查目标 client
8. 丢弃 stale agent session 的晚到输出

Core 不负责：

- client queue 的批处理
- agent queue 的缓冲策略
- 平台展示优化
- 工具调用消息的聚合 / 折叠
- polling loop
- 全局统一 queue size

换句话说：

> Core 是 **binding manager + router**，不是统一 scheduler。

---

## Core 状态模型

Core 维护两类核心状态：

```ts
clientSessionId -> agentSessionId   // 持久化到磁盘（按 channel 一个 JSON 文件），重启后可 resume
agentSessionId -> AgentRuntime      // 仅内存
```

其中：

```ts
interface AgentRuntime {
  agentSessionId: string;
  clientSessionId: string; // 反向查找由 runtime 派生，不再单独维护 agentSessionId -> clientSessionId
  agentAdapter: AgentAdapter;
}
```

说明：

- 当前 active agent session 是按 `clientSessionId` 查到的
- agent 输出回流时，通过 `agentSessionId -> AgentRuntime` 找到 runtime，再从 `runtime.clientSessionId` 反查目标 client 会话；runtime 已释放的输出直接丢弃
- `clientSessionId -> agentSessionId` 绑定在变更时持久化，进程重启后重新加载，下一条消息走 `resumeAgentSession()` 恢复原会话

---

## 队列归属（最新决议）

队列尽量下沉到 adapter 内部。

### ClientAdapter

- ClientAdapter 可以拥有自己的内部发送队列
- 它可以对队列做平台相关优化：
  - 合并消息
  - 覆盖更新
  - 折叠工具调用状态
  - 批量发送

### AgentAdapter

- 每个 `AgentAdapter` 实例拥有自己的一条输入队列
- 该队列与该实例绑定的 `agentSessionId` 一起存在
- Core 不维护统一的 agent 输入总队列

可理解为：

```ts
agentSessionId -> {
  agentAdapter,
  queue,
  busy,
}
```

但该 `queue` 是 adapter 的内部实现细节，不属于 Core 的职责。

### 结果

- `input()` 的语义统一为：
  - event 已被 adapter 接收并进入其内部处理流程
- `isBusy()` 保留，但更偏向：
  - 观测状态
  - 停机/回收判断
  - 调试用途
- Core 不再依赖 polling + queue 作为主流程控制方式

---

## `/new` 与 `/compact`

## `command.session.new`

行为定义：

- 为当前 `clientSessionId` 创建一个全新的 agent session
- 创建一个全新的 `AgentAdapter` 实例
- 更新 `clientSessionId -> agentSessionId` 绑定关系

处理规则：

1. 找到该 `clientSessionId` 当前绑定的 active `agentSessionId`
2. 如果旧 adapter 正在运行，可先尝试 `abort`，再 `stop`
3. 调用 `AgentModule.createAgentSession()` 创建新会话
4. 更新双向映射与 runtime 表
5. 向 client 返回确认消息

说明：

- 如果旧 adapter 内部有 pending queue，则随 `stop()` 一并销毁
- Core 不再负责清理 adapter 内部队列

## `command.session.compact`

行为定义：

- 对当前 active agent session 执行一次 compact

处理规则：

1. 通过 `clientSessionId` 找当前 active `agentSessionId`
2. 找到对应 `AgentAdapter`
3. 向该 adapter 发送 `command.session.compact`
4. 由 agent 输出结果，再经 Core 反查回 client

如果当前没有 active agent session：

- 不自动创建 agent session
- 直接向 client 返回提示消息

---

## 旧会话晚到输出

如果旧 agent session 在 `/new` 之后仍晚到输出：

- Core 必须检查该 `agentSessionId` 是否仍是该 `clientSessionId` 的 active 绑定
- 如果不是，则丢弃这条输出

否则会导致：

- 用户已经 `/new`
- 旧会话回复却又发回原 chat

这是必须避免的。

---

## 命令解析规则（MVP）

目前仅支持两条文本命令：

- `/new`
- `/compact`

解析规则：

- 只做**精确匹配**
- 其他文本一律按普通 `user.message` 处理

---

## idle 清理规则

当某个 agent runtime 因 idle timeout 被回收时：

- 删除 `agentSessionId -> AgentRuntime`
- 保留 `clientSessionId -> agentSessionId` 映射

后续如果该 `clientSessionId` 再收到新消息：

- 若对应 agent module 支持 `resumeAgentSession()`，则按既有 `agentSessionId` 重建 runtime
- 若不支持 `resumeAgentSession()`，则 Core 退化为调用 `createAgentSession()` 创建一个**新的** agent session

如果发生退化创建，则 Core 必须：

1. 更新 `clientSessionId -> newAgentSessionId`（旧 agent 的 runtime 已不存在，反向查找随之自动失效）
2. 用新的 runtime 替换旧绑定

这意味着：

- “保留映射、删除 runtime” 仍然是默认策略
- 但对**不支持 resume 的 agent**，idle 回收后下一次恢复本质上会退化为“重新开一个新的 agent session”
- 这是 agent 能力边界带来的限制，Core 只能接受这个缺陷，不能凭空恢复原 agent 会话上下文

---

## MVP 范围

当前保留的核心事件：

- `user.message`
- `assistant.message`
- `command.session.new`
- `command.session.compact`

当前明确不进入协议：

- streaming / delta
- typing
- progress / tool events
- artifact / file / image
- approval / interaction
- attachments
- read receipt
- richer session control families

这些都等最小链路稳定后再扩展。

---

## 当前结论总结

1. 采用双侧 adapter 架构，不抽泛型父接口
2. 一个 channel = 一个 client side + 一个 agent side
3. 配置能力挂在模块层：`ClientModule` / `AgentModule`
4. Core 不生成 `agentSessionId`，而由 `AgentModule.createAgentSession()` 返回
5. 不再使用模糊的 `sessionId` 命名，统一拆成 `clientSessionId` / `agentSessionId`
6. `/new` 与 `/compact` 是两个独立事件类型：
   - `command.session.new`
   - `command.session.compact`
7. Core 负责绑定、路由、生命周期与 stale output 过滤
8. 队列尽量下沉到 adapter 内部，Core 不做统一 queue/poll scheduler
9. `pollIntervalMs` 与 `maxQueueSize` 已从 Core 级配置中移除
10. 不支持 resume 的 agent 在 runtime 丢失后，只能接受退化为新建 agent session
