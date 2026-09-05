# Tasks

| 编号 | 名称 | 依赖 | 验证方式 |
| ---- | ---- | ---- | -------- |
| 01   | 契约与事件：types + slash 解析 + core resume 事务 | -    | `pnpm test`（slash-commands / gateway-core / i18n 测试） |
| 02   | pi-coding-agent 接管 | 01   | `pnpm test`（pi module/adapter 新测试） |
| 03   | opencode 接管 | 01   | `pnpm test`（opencode adapter 新测试） |
| 04   | i18n 文案 + 三个 client adapter usage 分支 + 文档 | 01   | `pnpm test`（adapter/i18n 测试）+ `pnpm build` |
