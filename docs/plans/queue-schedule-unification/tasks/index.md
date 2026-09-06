# Tasks

| 编号 | 名称 | 依赖 | 验证方式 |
| ---- | ---- | ---- | -------- |
| 01 | 共享 front-matter 存储工具模块（纯重构） | - | `npx vitest run` |
| 02 | queue dead-letter 失败终态 + `queue retry` | 01 | `npx vitest run src/modules/queue/` |
| 03 | queue 任务级 model/timeout/silence 覆盖 | 01 | `npx vitest run src/modules/queue/ src/cli.test.ts` |
| 04 | silence 默认 30m + 文档同步 | 01 | `npx vitest run src/modules/` |
| 05 | `/queue-here` 迁移为 adapter-local 命令 | - | `npx vitest run src/core/ src/modules/client/` |
| 06 | add 向导统一 + schedule run CLI | 03, 05 | `npx vitest run src/cli.test.ts` |
