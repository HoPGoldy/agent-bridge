# T03: opencode 接管

## 目标

opencode 模块实现 `providerSessionId` 接管：create 路径分支为 `session.get(<id>)` 验证存在后直接采用该 provider 会话（不调 `session.create`），实现 `getWorkingDirectory` 契约。

## 上下文

- 必读：`docs/plans/resume-command/context.md` 全文（尤其 §2 决策 4/5/7、opencode 相关行）。
- `src/modules/agent/opencode/index.ts`（module 组装、`createAgentSession`）。
- `src/modules/agent/opencode/adapter/opencode-agent-adapter.ts`（`#startCreate` / `#startResume` / runtime 注册表）及其测试。
- `src/modules/agent/opencode/adapter/opencode-api.ts`（`getSession` 等接口形状）。

## 边界

允许修改：仅 `src/modules/agent/opencode/` 目录内文件。不得改动 core、client、pi 及 `src/types.ts`。

## 实现要求

1. **接管路径**：`createAgentSession` 收到 `providerSessionId` 时，adapter 以 create 生命周期启动，但 `#startCreate` 分支为：
   - 剥可选的 `opencode:` 前缀（兼容用户从 `/status` 原样复制的 bridge agentSessionId）；
   - 调 `session.get(<id>)` 验证存在；不存在/网络失败→抛明确错误（含原始输入，core 已有失败回复链路承接）；
   - 不创建新 provider 会话；状态 initialize 时 `openCodeSessionId` 采用该 id；workingDirectory 用既有 `#resolveCreateDirectory` 的结果（channel 配置目录 > 进程 cwd；不写会话状态目录）。
2. **占用防护**：`OpenCodeRuntime` 已有 sessionID→adapter 注册表——接管目标已被本进程存活 adapter 持有时失败（决策 7），不得覆盖注册。
3. **runtime 目录键**：接管会话使用 channel `config.directory`（缺省进程 cwd）作为 effective directory 选 runtime；bridge 端目录仅影响 runtime/SSE 缓存键，不影响服务端会话延续（context §2 已说明）。
4. **`getWorkingDirectory`**：返回 adapter 持有的 effective working directory（create/resume 均已解析）。

## 验收

- `pnpm test` 全绿，新增测试至少覆盖：
  - 接管成功：不调 createSession、`getSession(id)` 被调、状态 initialize 记录该 id、注册进 runtime。
  - 前缀剥离：`opencode:ses_x` 与裸 `ses_x` 等价。
  - 不存在的 session：抛错且不注册 runtime。
  - 占用防护：已被持有（runtime map 中存在）→ 失败。
  - `getWorkingDirectory` 返回 effective directory。
- 既有 opencode 测试全部不回归。
