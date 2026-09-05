# T02: pi-coding-agent 接管

## 目标

pi 模块实现 `providerSessionId` 接管：按原始字符串定位会话 jsonl 文件，读取文件头得到真实 cwd 与 id，以 `--session <绝对路径>` 启动 pi 进程续写该会话；状态记录新增可选 `sessionFile` 字段，使接管后的会话在 idle 释放/进程重启后的普通 resume 仍续写同一文件。

## 上下文

- 必读：`docs/plans/resume-command/context.md` 全文（尤其 §3.3 pi 会话事实、§2 决策 4/5/6/7）。
- `src/modules/agent/pi-coding-agent/index.ts`（module + codec `PiCodingAgentSessionStateV1`）及其测试。
- `src/modules/agent/pi-coding-agent/adapter/pi-coding-agent-adapter.ts`（`#prepareWorkingDirectory`、options、mode 机制）及其测试。
- `src/modules/agent/pi-coding-agent/adapter/pi-rpc-client.ts`（spawn 参数组装）及其测试。
- `src/modules/agent/pi-coding-agent/adapter/pi-session-id.ts`。
- 既有测试基建：`gateway-composition.test.ts` / `index.test.ts` 中对 spawn 参数与状态初始化的断言方式。

## 边界

允许修改：仅 `src/modules/agent/pi-coding-agent/` 目录内文件。不得改动 core、client、opencode 及 `src/types.ts`（契约已由 T01 完成）。

## 实现要求

1. **会话文件解析**（新文件如 `session-locator.ts` 或等价物）：
   - 输入原始字符串（trim 后），依序尝试：① 以 `.jsonl` 结尾或含路径分隔符→按文件路径（`~` 展开，相对路径对进程 cwd 解析）；② 在 bridge `sessionDir`（与 spawn 同一解析优先级 config.sessionDir > PI_SESSION_DIR > 默认私有目录）扫描文件名 `*_<id>.jsonl` 精确匹配；③ 同目录前缀匹配（多个命中→报歧义错误并列出候选 id）；④ 扫描 pi 默认会话根 `~/.pi/agent/sessions/<项目目录>/`（目录布局见 context §3.3；仅在该目录存在时扫描）。全部未命中→明确错误。
   - 命中后解析文件**首行** JSON：取 `id`（优先文件头 id）、`cwd`；首行解析失败→明确错误。
2. **接管路径（create + providerSessionId）**：
   - 定位文件→canonicalize（realpath）会话头 `cwd`；该目录视为 `user` 来源，走既有 allowlist 检查；目录不存在→报错（错误信息含原始 providerSessionId）。
   - 状态初始化：在既有 V1 状态上增加可选字段 `sessionFile: string`（绝对路径）。encode 保持可选（不写 undefined），decode 对旧记录（无该字段）完全兼容——**codec currentVersion 保持 1，不改版本号**。
   - 进程内活跃注册表（module 级 Map：sessionFile→agentSessionId）：接管已被本进程存活 adapter 持有的会话→失败（决策 7）；adapter stop 时注销。
   - spawn：`--session <sessionFile 绝对路径>`，**不传** `--session-id`（context §3.3 的坑）；piSessionId 派生规则不变。
3. **普通 resume 增强**：resume 模式读到 `sessionFile` 字段时同样用 `--session <path>`（不传 `--session-id`）续写原文件；无该字段保持现状（`--session-id <toPiSessionId>`），保证既有会话行为不变。
4. `getWorkingDirectory`：adapter 在 start 时已解析并持有 canonical cwd，实现该契约方法返回之。

## 验收

- `pnpm test` 全绿，新增测试至少覆盖：
  - locator：精确 id、前缀唯一命中、前缀歧义（报候选）、文件路径输入、未找到报错、坏首行报错。
  - 接管 spawn 参数：含 `--session <path>`、不含 `--session-id`；allowlist 拒绝路径（配置 roots 时）；目录不存在报错。
  - 状态：接管初始化含 `sessionFile`；旧格式记录（无字段）decode 兼容；普通 resume 带/不带字段两种 spawn 形态。
  - 占用防护：同一 sessionFile 二次接管失败；stop 后可再接管。
  - `getWorkingDirectory` 返回 canonical cwd。
- 既有 pi 测试全部不回归。
