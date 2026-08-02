# OpenCode Agent Adapter Spec

## 目标

为 `agent-bridge` 增加 `opencode` Agent Adapter，通过用户预先启动的 OpenCode Server 提供会话、消息、停止、压缩、状态、模型和进度能力。

本次实现包括：

- 连接用户配置的 OpenCode Server
- 可选 HTTP Basic Auth
- 创建和恢复 OpenCode session
- 普通消息和 busy 时 follow-up
- `/stop`
- `/compact`
- `/status`
- `/model` 列表和切换
- SSE 事件到 `AgentOutputEvent` 的转换
- 自动批准当前 session 的权限请求
- 自动拒绝当前 session 的 Question 请求
- 本地及远程 HTTP/HTTPS Server

本次实现不包括：

- 由 `agent-bridge` 启动、重启或关闭 OpenCode Server
- 自动扫描本机端口寻找 OpenCode Server
- 真正注入当前 LLM 请求的 in-flight steer
- 将 OpenCode 权限请求转发到 IM 让用户选择
- 将 OpenCode Question 请求转发到 IM 让用户回答
- 修改 `GatewayCore` 会话语义
- 为 OpenCode 单独修改 Client Adapter

## 核心决策

1. OpenCode Server 是外部依赖，创建 channel 时必须提供 `baseUrl`。
2. 一个 OpenCode Server 可以同时运行多个 OpenCode session；每个 `OpenCodeAgentAdapter` 对应一个 session，不对应一个 Server。
3. 同一 channel 下的 Adapter 共享 SDK Client 和 SSE 事件订阅。
4. channel 创建时必须验证 Server 可访问；验证失败时不保存 channel。
5. Server 不可访问时，CLI 显示一条推荐启动命令，并允许用户重试或取消。
6. 远程 HTTP 地址允许使用，只显示风险提示，不强制 HTTPS。
7. Basic Auth 可选；密码使用 secret 输入，禁止出现在摘要、日志和错误信息中。
8. 权限请求由 Adapter 自动回复 `once`；Question 请求由 Adapter 自动拒绝。
9. 推荐启动命令同时设置所有权限自动允许并禁用 `question`。

## 用户配置

在 `src/types.ts` 中增加：

```ts
export interface OpenCodeAgentConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  directory?: string;
  agent?: string;
  model?: string;
}
```

并将 `opencode` 加入 `AgentConfig`：

```ts
export type AgentConfig =
  | {
      type: "pi-coding-agent";
      config: PiCodingAgentConfig;
    }
  | {
      type: "opencode";
      config: OpenCodeAgentConfig;
    };
```

### 字段规则

#### `baseUrl`

- 必填。
- 必须是合法的 `http://` 或 `https://` URL。
- 删除末尾 `/` 后保存。
- 默认提示值为 `http://127.0.0.1:4096`。
- URL 中不得包含 username 或 password。

#### `username`

- 可选。
- 启用 Basic Auth 时默认使用 `opencode`。
- 未提供 `password` 时不发送 Authorization Header。

#### `password`

- 可选。
- 使用 `secret: true` 收集。
- 不在 `summarize`、日志、错误和测试快照中显示。

#### `directory`

- 可选。
- 默认使用 `process.cwd()`。
- 传给 OpenCode SDK Client，用于选择 workspace。

#### `agent`

- 可选。
- 作为 OpenCode prompt 的 agent 参数。
- 未配置时使用 OpenCode Server 默认 Agent。

#### `model`

- 可选。
- 格式为 `provider/modelID`。
- 未配置时使用 OpenCode Server 当前或默认模型。

## Channel 创建流程

配置收集器按下面顺序执行：

1. 输入 `baseUrl`。
2. 询问是否使用 Basic Auth。
3. 如果使用，输入 username 和 secret password。
4. 输入可选 directory。
5. 输入可选 agent。
6. 输入可选默认 model。
7. 创建临时 SDK Client。
8. 调用 OpenCode health API。
9. 验证 OpenCode Server 返回健康状态和版本。
10. 如果配置了 model，验证它属于已连接 Provider。
11. 成功后保存配置。

### Server 不可访问

不得保存不可用配置。CLI 显示：

- 失败类型：连接失败、超时、401、协议不兼容或其他错误
- 已脱敏的 `baseUrl`
- 推荐启动命令
- `Retry` 或 `Cancel` 选择

不得在错误中打印 Authorization Header 或 password。

### 推荐本地启动命令

```bash
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 127.0.0.1 --port 4096
```

### 推荐远程监听命令

```bash
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 0.0.0.0 --port 4096
```

### 推荐 Basic Auth 命令

命令中只显示占位符，不回显用户已输入的密码：

```bash
OPENCODE_SERVER_USERNAME='opencode' \
OPENCODE_SERVER_PASSWORD='<password>' \
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 0.0.0.0 --port 4096
```

### HTTP 风险提示

当 `baseUrl` 满足以下条件时显示一次确认提示：

- 协议为 `http:`
- hostname 不是 `localhost`、`127.0.0.1` 或 `::1`

提示内容应说明：

- HTTP 不加密传输
- Basic Auth 只是 Base64 编码
- 用户应自行通过可信网络、VPN、防火墙或反向代理保证安全

用户确认后允许继续，不强制 HTTPS，也不强制远程 Server 配置密码。

## SDK Client 和认证

使用官方 `@opencode-ai/sdk` 的 v2 Client，因为该 Client 同时暴露 session、provider、event、permission 和 question API。

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
```

Basic Auth Header 在 Client 创建时统一配置：

```ts
function buildAuthorization(config: OpenCodeAgentConfig): string | undefined {
  if (config.password === undefined) return undefined;
  const username = config.username || "opencode";
  return `Basic ${Buffer.from(`${username}:${config.password}`).toString("base64")}`;
}
```

Header 必须自动用于：

- health
- session API
- provider API
- SSE event subscription
- permission reply
- question reject

禁止把密码嵌入 `baseUrl`。

## Runtime 结构

同一 channel 使用一个共享 Runtime：

```text
OpenCodeAgentModule
└── OpenCodeChannelRuntime
    ├── SDK Client
    ├── SSE subscription
    ├── sessionID -> OpenCodeAgentAdapter
    └── reconnect state
```

Runtime 以 channel 和连接配置隔离。不同 `baseUrl`、directory 或认证配置不得共享 Runtime。

Runtime 不拥有 OpenCode Server，因此停止时只关闭：

- SSE 订阅
- AbortController
- 重连任务
- Adapter 注册表

不得调用 OpenCode Server dispose，也不得终止外部进程。

## Session 创建和恢复

### 创建

`createAgentSession`：

1. 获取对应 channel Runtime。
2. 调用 OpenCode `session.create()`。
3. 取得 OpenCode session ID。
4. 返回 bridge session ID：

   ```text
   opencode:<openCodeSessionId>
   ```

5. 创建绑定该 OpenCode session 的 Adapter。

### 恢复

`resumeAgentSession`：

1. 验证 bridge session ID 以 `opencode:` 开头。
2. 提取 OpenCode session ID。
3. 调用 `session.get()` 验证 session 存在。
4. 使用相同 directory 恢复 Adapter。
5. 读取最近消息，恢复当前 provider 和 model。

如果 Server 中不存在该 session，恢复失败并交给现有 Core 错误流程处理；不得静默创建一个同 ID 的新 session。

## Adapter 生命周期

### `start(onOutput)`

- 保存输出回调。
- 注册到共享 Runtime 的 session map。
- 确保 SSE 已连接。
- SSE 就绪后才完成。

### `stop()`

- 从 Runtime 注销当前 session。
- 清理当前 Adapter 的文本、工具和 pending 状态。
- 不删除 OpenCode session。
- 不关闭 OpenCode Server。
- 当 Runtime 已没有 Adapter 时可以关闭 SSE。
- 必须支持重复调用。

### `isBusy()`

优先使用最近的 `session.status` SSE 事件维护状态；状态未知或 SSE 重连后调用 `session.status()` 校准。

以下状态视为 busy：

- `busy`
- `retry`

`idle` 视为不忙。

## 普通消息和 follow-up

普通消息使用 `session.promptAsync()`，由 SSE 接收后续事件。

Prompt 参数包括：

- 当前 OpenCode session ID
- 文本 Part
- 可选 agent
- 当前选择的 model
- 共享的 `MEDIA_CONVENTION_PROMPT`，通过当前 User Message 的 `system` 字段注入

OpenCode 只把当前 User Message 的 `system` 合并到本轮模型请求，不把历史消息的该字段重复转换为上下文，因此每条消息都应传入同一约定而不会累积。不得修改用户的 `AGENTS.md`、OpenCode 配置或 Agent Prompt 来实现该注入。

当 session 已 busy 时仍提交 `promptAsync()`，使用 OpenCode follow-up 行为。不得把它描述为真正的 in-flight steer，也不得在 Adapter 中静默丢弃或覆盖消息。

## `/stop`

`abort()` 调用 OpenCode `session.abort()`。

要求：

- 只中止当前 OpenCode session。
- 中止后等待或接收 idle 状态。
- 清理当前工具和文本累积状态。
- 不删除 session。
- 不关闭 Server。

## `/compact`

收到 `command.session.compact`：

1. 确定当前 provider 和 model。
2. 输出 `session.compacting`。
3. 调用 `session.summarize()`。
4. 等待 `session.compacted` 或 `session.error`。
5. 完成、失败或中止后正确复位 busy 状态。

如果无法确定模型，返回结构化错误，不猜测不存在的 provider/model。

## `/status`

`getStatus()` 返回：

- bridge session ID
- 当前 provider
- 当前 model ID
- 最近 Assistant Message 可提供的 token 数
- 当前模型可提供的 context window

OpenCode 没有对应值时省略 `thinkingLevel`。

状态来源：

- session status API
- 最近 User Message 的 model
- 最近 Assistant Message 的 token usage
- Provider Model 的 context limit

## `/model`

### 无参数

`getAvailableModels()` 调用 Provider List API。

OpenCode 返回：

- `all`：当前模型目录和已启用 Provider 的模型
- `connected`：实际已连接的 Provider ID
- `default`：Provider 默认模型

`agent-bridge` 只把 `connected` Provider 下的模型作为可用模型返回：

```text
all.filter(provider => connected.includes(provider.id))
```

不得把未配置凭据的 Provider 模型标记为可用。

### 指定模型

`setModel(target)`：

1. 按第一个 `/` 拆分 provider 和 model ID。
2. 从 connected Provider 模型列表中验证目标。
3. 保存为 Adapter 当前模型。
4. 下一条 prompt 显式传入该模型。
5. 返回 provider 和 model ID。

OpenCode 没有独立的立即切换模型 API，因此切换在下一条消息生效。恢复 session 时从最近 User Message 恢复当前模型。

## SSE 事件处理

Runtime 只建立一条 SSE 订阅，并按事件中的 `sessionID` 分发到对应 Adapter。

### 事件映射

- `session.status`：更新 busy 状态
- `session.idle`：完成当前回复并复位 busy
- `session.compacted`：结束 compact 状态
- `session.error`：输出 `error`
- `message.part.updated` text：累积最终文本
- `message.part.updated` reasoning：输出 `assistant.thinking`
- `message.part.updated` tool pending/running：输出 `assistant.tool.running`
- `message.part.updated` tool running 更新：输出 `assistant.tool.update`
- `message.part.updated` tool completed：输出 `assistant.tool.done`
- `message.part.updated` tool error：输出 `assistant.tool.error`
- File Part：在可解析为本地文件时转换成 `OutboundAttachment`

工具事件以 `callID` 去重。最终文本按 message ID 累积，在对应 session idle 后只发送一次。发送前使用共享 `extractMediaMarkers()` 解析文本中的 `MEDIA:<absolute_path>`，移除已成功解析的 marker，并与 File Part、Tool attachments 按本地路径去重后合并。

本地路径附件要求 OpenCode Server 与 `agent-bridge` 运行在同一文件系统，或共享相同路径。远程 Server 返回的路径在 bridge 主机上不可访问时必须保留原始 marker 文本，不得声称附件已发送。

### SSE 重连

SSE 断开时：

1. 标记连接不可用。
2. 使用有上限的退避策略重连。
3. 重连后调用 session status API 校准 busy 状态。
4. 调用 permission list 和 question list 恢复 pending 请求。
5. 使用 request ID 去重。

不得因为 SSE 暂时断开而删除 OpenCode session。

## 权限策略

推荐 Server 配置：

```json
{
  "permission": {
    "*": "allow",
    "question": "deny"
  }
}
```

Adapter 仍必须防御性处理意外的 `permission.asked`：

1. 检查事件 `sessionID` 属于当前 Adapter。
2. 调用 `permission.reply()`。
3. 固定回复 `once`。
4. 不批准其他 session 的请求。
5. 不把 permission metadata 原样写入日志。

SSE 重连后，对 permission list 中属于当前 session 的 pending 请求执行相同处理。

显式 `deny` 不会产生请求，Adapter 不得绕过 Server 的 deny 结果。

## Question 策略

推荐配置通过 `question: deny` 禁用 Question Tool。

Adapter 仍必须处理意外的 pending Question：

1. 检查 Question 属于当前 OpenCode session。
2. 调用 question reject API。
3. 输出明确错误，说明当前 bridge 不支持 Agent 主动提问。
4. 确保 session 不会永久停留在 busy。

不得自动构造或猜测用户回答。

## 错误处理

至少区分：

- Server 不可达
- 请求超时
- 401 认证失败
- OpenCode API 版本不兼容
- session 不存在
- model 不存在或 Provider 未连接
- SSE 中断
- prompt、abort 或 summarize 失败

错误中允许出现：

- 已脱敏的 base URL
- HTTP status
- OpenCode error kind
- 不含凭据的 detail

错误中禁止出现：

- password
- Authorization Header
- 完整敏感请求头
- Provider Token

## 建议目录

```text
src/modules/agent/opencode/
├── index.ts
├── index.test.ts
└── adapter/
    ├── opencode-agent-adapter.ts
    ├── opencode-agent-adapter.test.ts
    ├── opencode-runtime.ts
    └── opencode-runtime.test.ts
```

具体文件可根据实现调整，但模块入口、Adapter 和共享 Runtime 的职责必须分开。

## 注册

在 `src/modules/agent/index.ts` 中注册 `opencode` 模块。CLI 应通过现有 registry 自动列出它，不在 CLI 中增加硬编码 Agent 列表。

## 测试要求

### 配置

- [ ] `baseUrl` 必填并规范化。
- [ ] 拒绝 URL 中的 username/password。
- [ ] Basic Auth password 使用 secret 输入。
- [ ] 摘要不包含 password。
- [ ] 本地 HTTP 不显示远程风险提示。
- [ ] 远程 HTTP 显示提示但允许继续。
- [ ] HTTPS 不显示 HTTP 风险提示。
- [ ] health 成功后保存配置。
- [ ] health 失败时显示命令并支持重试或取消。
- [ ] 401 与普通连接失败可区分。

### Runtime

- [ ] 同一 channel 多个 Adapter 共享 Client 和 SSE。
- [ ] 不同连接配置不共享 Runtime。
- [ ] SSE 事件按 session ID 隔离。
- [ ] stop 最后一个 Adapter 后关闭 SSE，不关闭 Server。
- [ ] SSE 重连恢复 status、permission 和 question pending 状态。

### Session

- [ ] 创建 session 返回 `opencode:` 前缀 ID。
- [ ] 恢复指定 session。
- [ ] 不存在的 session 恢复失败。
- [ ] 普通消息调用 prompt async。
- [ ] busy 时新消息作为 follow-up，不丢失。

### 命令

- [ ] `/stop` 只 abort 当前 session。
- [ ] `/compact` 使用当前 provider/model。
- [ ] `/status` 返回可获得的结构化状态。
- [ ] `/model` 只返回 connected Provider 模型。
- [ ] `/model provider/model` 在下一条 prompt 生效。
- [ ] busy 时模型切换由现有 Core 拒绝。

### 事件

- [ ] 文本只在完成后输出一次。
- [ ] reasoning、tool running/update/done/error 正确映射。
- [ ] 不同 session 的文本和工具事件不串线。
- [ ] error 和 abort 后 busy 状态复位。
- [ ] permission 只自动批准当前 session，固定使用 `once`。
- [ ] question 只拒绝当前 session，并产生明确错误。

### 安全

- [ ] Authorization Header 用于 HTTP 和 SSE。
- [ ] password 不出现在日志、摘要、错误和快照中。
- [ ] 远程 HTTP 不被强制拒绝。
- [ ] Adapter 不启动、关闭或 dispose OpenCode Server。

## 人工验收

1. 使用推荐命令启动本地 OpenCode Server。
2. 创建使用 `opencode` Agent 的 channel。
3. 发送普通消息并观察文本与工具进度。
4. 连续发送消息，确认 follow-up 不丢失。
5. 执行 `/status`。
6. 执行 `/model` 并确认只显示已连接 Provider。
7. 切换模型后发送新消息，确认新模型生效。
8. 在长任务中执行 `/stop`。
9. 执行 `/compact`。
10. 重启 `agent-bridge`，确认原 session 能恢复。
11. 使用 Basic Auth Server 重复 health、消息和 SSE 测试。
12. 使用远程 HTTP URL，确认只提示风险但不阻止创建。
13. 使用会产生权限请求的 Server 配置，确认 Adapter 自动回复 `once`。
14. 触发 Question Tool，确认请求被拒绝且会话不挂起。

## 实现顺序

1. 添加 OpenCode SDK 依赖和配置类型。
2. 实现配置收集、health 验证、Basic Auth 和启动命令提示。
3. 实现共享 Runtime、SSE 分发和重连。
4. 实现创建与恢复 session。
5. 实现普通消息、follow-up 和输出事件映射。
6. 实现 stop 和 compact。
7. 实现 status 和 model。
8. 实现 permission 自动批准和 question 自动拒绝。
9. 注册模块并补充测试。
10. 更新 README Agent 支持列表。
11. 运行相关测试、完整测试和 build。
