# T04: client adapter usage 分支 + 文档收尾

## 目标

三个 client adapter（feishu / wecom / weixin）处理 `command.session.resume.usage` 本地回复；`docs/command-system.md` 补充 `/resume` 文档；README 命令列表补充说明。

## 上下文

- 必读：`docs/plans/resume-command/context.md`（§2 决策 1/4/5、§3.4 已知坑第 3 条）。
- `src/modules/client/feishu/adapter/feishu-im-adapter.ts` 及其测试（`schedule.run.usage` 分支先例）。
- `src/modules/client/wecom/adapter/wecom-im-adapter.ts`、`src/modules/client/weixin/adapter/weixin-im-adapter.ts` 及其测试。
- `docs/command-system.md`、`README.md`。

## 边界

允许修改：上述三个 adapter 文件及其测试、`docs/command-system.md`、`README.md`。不得改动 core、agent 模块、types、i18n（均已完成）。

## 实现要求

1. 三个 adapter 在 `parseSlashCommand` 结果处理处，于调用 `resolveSlashCommandEvent` **之前**拦截 `command.session.resume.usage`（类型收窄需要，见 context §3.4 第 3 条），回复 `client.resumeUsage` 文案；仿照各自现有 `schedule.run.usage` 分支的写法与日志风格。
2. `docs/command-system.md`：命令表新增 `/resume <provider-session-id>` 与 `/r` 行；新增"Runtime behavior → `/resume`"小节：语义（接管 provider 会话、完全恢复上下文与工作目录）、ID 从 `/status` 获取、零验证透传（无效 ID 由 agent 后端报错）、失败不触碰原会话、`/new` 目录记忆不受影响、成功回复示例、allowlist 约束说明（接管目录按 user 来源检查）。
3. `README.md`：IM 命令相关段落提及 `/resume`（一两句 + 指向 command-system.md，不展开）。

## 验收

- `pnpm test` 全绿：三个 adapter 各新增 usage 测试（收到 usage 类型时回复本地文案、不发事件到 core）。
- `pnpm build` 通过。
- 文档检查：command-system.md 的有效/无效命令示例列表与解析器行为一致（`/resume`、`/R abc` 有效；裸 `/resume` 为 usage 回复而非普通消息——按解析器实际行为描述）。
