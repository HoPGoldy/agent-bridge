# /resume 命令（接管 provider 会话）

## 1. 背景与目标

用户平时在 PC 上用 pi / opencode 的 TUI 与 agent 交互，退出时得到一个 provider session ID。希望在 IM（飞书/企微/微信）里发送 `/resume <id>`（别名 `/r <id>`），让 bridge **接管**该会话：agent 上下文与工作目录完全恢复为被接管会话，之后 IM 里的消息续写同一个 provider 会话。ID 无效时返回标准错误回复，原会话不受影响。

非目标：

- 不做 CLI 形式的 resume；
- 不做 session 列表查询命令；
- 不改变 `/new`、`/status`、schedule/queue 等既有行为的任何语义；
- 不实现 provider session ID 的解析层校验（决策见下）。

## 2. 方案概要（已与用户逐条确认的决策）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 入口形态 | IM 斜杠命令 `/resume <id>`，短别名 `/r <id>` |
| 2 | 支持范围 | pi-coding-agent 与 opencode 两个 agent 模块都支持 |
| 3 | 旧会话处理 | 与 `/new` 完全相同的事务语义：新 runtime 创建成功才切绑定→停旧 runtime→旧记录无其他绑定时删除；任一步失败原会话原样保留 |
| 4 | ID 验证 | **零验证透传**：解析层与 core 不校验 ID 合法性，原始字符串（trim 后）直达 agent adapter，由 adapter 调 Agent API 解析/验证，失败以标准 error/失败回复返回 |
| 5 | 成功回复 | 回复确认文案并展示恢复出的工作目录；**聊天侧 `/new` 工作目录记忆保持不变、不做任何额外操作**（裸 `/new` 仍落回原记忆目录） |
| 6 | allowlist | 保持现有规则：接管出的工作目录按 `user` 来源对待，配置了 `defaults.allowedWorkingDirectoryRoots` 时受检查（未配置则放行） |
| 7 | 重复接管防护 | 同一 provider 会话不允许被两个**存活** adapter 同时驱动（进程内注册表防重；只拦"两个活进程写同一会话文件"） |

关键设计：

- **事件**：`ClientOutputEvent` 新增 `{ type: "command.session.resume", clientSessionId, providerSessionId }`；缺参数由解析层产出 adapter 本地的 usage 类型（沿用 `schedule.run.usage` 先例），本地回复、不产生事件。
- **module 契约**：`AgentModule.createAgentSession` 参数新增可选 `providerSessionId?: string`（只有 resume 命令携带；`/new`、隐式创建、调度任务都不携带）。不新增 module 方法。
- **adapter 契约**：`AgentAdapter` 新增可选 `getWorkingDirectory?(): Promise<string | undefined>`，供 core 在成功回复中展示目录；不可用时回复省略目录段。
- **core**：新增 `#handleSessionResume`，复用 `#createRuntimeForClient`（透传 `providerSessionId`）、`#switchClientToAgent`、`#cleanupNewRuntime` 等现有事务件，流程与 `#handleSessionNew` 同构。合成会话（`schedule:*`/`queue:*`）防御性忽略该命令。
- **pi 接管**：按原始字符串定位会话 jsonl 文件（见 §3 pi 事实），读文件头取真实 `cwd` 与 `id`，spawn 用 `--session <文件路径>` 且**绝不传 `--session-id`**（否则 pi 找不到时会静默创建同 ID 空会话）。状态记录新增可选 `sessionFile` 字段（保持 V1、可选字段向后兼容），普通 resume 命中该字段时同样用 `--session <path>` 恢复。
- **opencode 接管**：create 路径分支为 `session.get(<id>)` 验证存在（剥可选的 `opencode:` 前缀，兼容从 `/status` 原样复制），`openCodeSessionId` 直接采用。runtime 目录键用 channel `config.directory`，否则进程 cwd（opencode 会话自身目录记录在服务端，bridge 端目录只影响 runtime/SSE 缓存键，不影响会话延续）。

## 3. 公共上下文（开工前必读）

技术栈：TypeScript + ESM、vitest（测试与源码同目录 `*.test.ts`）、tsup 构建。包管理 pnpm。

### 3.1 术语

- **provider session ID**：agent 应用原生会话标识。pi 为会话 jsonl 文件头中的 `id`（uuid；bridge 创建的会话为 `pi-coding-agent.<uuid>`），opencode 为 `ses_*`。可通过 `/status` 查看。
- **adopt（接管）**：`/resume` 的语义——bridge 创建新 bridge agent session 并在状态中记录 provider 会话标识，把一个可能由外部 TUI 创建的 provider 会话接入某个 IM 聊天。
- **bridge agentSessionId**：core 拥有的 `<moduleType>:<uuid>`（pi）或 `opencode:<ses_id>`（opencode）。

### 3.2 关键源码地图（相对 `src/`）

| 文件 | 作用 |
|---|---|
| `types.ts` | `ClientOutputEvent` / `AgentModule` / `AgentAdapter` 契约（T01 扩展） |
| `modules/client/utils/slash-commands.ts` | 三端共享的斜杠命令解析器 |
| `modules/client/{feishu,wecom,weixin}/adapter/*-im-adapter.ts` | 各端入站处理（usage 分支先例：`schedule.run.usage`） |
| `core/gateway-core.ts` | `#handleSessionNew`/`#createRuntimeForClient`/`#switchClientToAgent`/`#cleanupNewRuntime` —— resume 事务的全部复用件 |
| `modules/agent/pi-coding-agent/index.ts` | pi module + 状态 codec（`PiCodingAgentSessionStateV1`） |
| `modules/agent/pi-coding-agent/adapter/pi-coding-agent-adapter.ts` | `#prepareWorkingDirectory`（create/resume 目录解析）、spawn 参数组装 |
| `modules/agent/pi-coding-agent/adapter/pi-rpc-client.ts` | spawn pi 进程（当前固定 `--session-id`） |
| `modules/agent/pi-coding-agent/adapter/pi-session-id.ts` | `toPiSessionId` |
| `modules/agent/opencode/adapter/opencode-agent-adapter.ts` | `#startCreate` / `#startResume` |
| `i18n/index.ts` | 中英文案（en-US 与 zh-CN 必须成对添加）；`client.helpMessage` 需追加 resume 行 |

### 3.3 pi 会话事实（已实地查证，pi 0.84.2）

- 会话文件：`~/.pi/agent/sessions/--<cwd 编码>--/<timestamp>_<uuid>.jsonl`（`/`、`:` 等替换为 `-`，目录名形如 `--home-wesley-project-agent-bridge--`）；bridge 私有目录默认 `~/.config/agent-bridge/pi-sessions`（扁平）。bridge 的 `sessionDir` 解析优先级：config.sessionDir > `PI_SESSION_DIR` > 默认私有目录。
- 文件首行即头：`{"type":"session","version":3,"id":"<uuid>","cwd":"<绝对路径>",...}`；bridge 只解析首行，不依赖 version。
- pi CLI：`--session <path|id>`（支持精确/前缀匹配、显式路径）；`--session-id <id>` **不能**与 `--session` 同用且找不到时会静默建同 ID 空会话——**接管模式必须用 `--session <绝对路径>` 且不传 `--session-id`**。
- `--session <已有文件路径>` 会在原文件上续写（树结构追加），TUI 与 bridge 可先后操作同一会话（非并发）。

### 3.4 已知坑

- pi 接管目录来自会话头 `cwd`，必须 canonicalize（realpath）后做 allowlist 检查再持久化/启动；`cwd` 不存在时报错（pi 自己也起不来）。
- opencode 的 `OpenCodeRuntime` 已有 sessionID→adapter 注册表：接管前必须检查目标会话是否已被本进程存活 adapter 持有，是则失败而非覆盖。
- `resolveSlashCommandEvent` 只放行 `ClientOutputEvent` 形状的类型；adapter 本地类型（usage 等）必须在调用它**之前**拦截处理（先例见各 adapter 的 `schedule.run.usage` 分支）。
- i18n 资源对象两个语言成对出现，漏一个会导致 fallback 静默英文；`client.helpMessage` 有测试断言内容。
- core 对 adapter 状态不透明：占用防护只能放在 module/adapter 层，core 不可读 provider 会话标识。

## 4. 端到端验收

整体完成的定义：三个 client adapter 均可解析 `/resume`/`/r`；core 完成事务切换与回复；pi 能接管外部 TUI 会话（含前缀匹配与歧义报错）、接管后的会话经历 idle 释放/进程重启仍能续写同一 jsonl；opencode 能接管 `ses_*`；ID 无效时用户收到明确失败回复且原会话不变；全量测试与构建通过。

验证命令：

```bash
pnpm test     # vitest run 全量
pnpm build    # tsup 构建（含类型检查）
```
