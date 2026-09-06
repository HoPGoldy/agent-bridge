# T01: 共享 front-matter 存储工具模块（纯重构）

## 目标

把 `task-file.ts` 与 `queue-file.ts` 各自复制的 front-matter 解析/编辑/原子写工具抽到
`src/modules/shared/front-matter.ts`，两个模块改为消费共享实现。行为零变化——这是后续所有
ticket 的工程地基，消除两份实现漂移的风险。不抽业务逻辑（解析 schema、校验规则留在原模块）。

## 上下文

- context.md §2 D8、§3「关键文件」「坑」
- `src/modules/schedule/task-file.ts`（splitFrontMatter / parseFrontMatter / stripQuotes /
  nonEmptyString / applyFrontMatterField / writeFileAtomic）
- `src/modules/queue/queue-file.ts`（同名复制版 + expandHome）
- 两者的测试文件（现有断言即回归基线，不得删改语义）

## 边界

只允许修改：

- `src/modules/shared/front-matter.ts`（新建）
- `src/modules/schedule/task-file.ts`
- `src/modules/queue/queue-file.ts`
- `src/modules/schedule/task-file.test.ts` / `src/modules/queue/queue-file.test.ts`
  （仅允许因 import 路径调整的必要改动，断言语义不变）
- `src/modules/index.ts` 或相关 barrel（如有导出需求）

要点：

- 共享模块导出：`splitFrontMatter`、`parseFrontMatter`、`stripQuotes`、`nonEmptyString`、
  `applyFrontMatterField`、`writeFileAtomic`、`expandHome`（queue 独有但属通用工具）。
  类型 `ParsedFrontMatter = { fields: Record<string, string>; warnings: string[] }` 一并导出。
- 原模块内同名函数删除，改 import；对外导出的函数签名（如 `parseTaskFile`、`bindTask`）
  不变，调用方零改动。
- 两个 applyFrontMatterField 实现有细微差异（task-file 版无 filePath dir 处理差异已对齐？
  逐行 diff 后以行为等价为准，测试兜底）。
- 不改任何行为：异常语义、warning 文案、原子写临时文件命名模式全部保持。

## 验收

```bash
npx vitest run            # 919 全绿（无新增用例要求，现有测试即回归）
npx tsc --noEmit
npm run build
```

且 `grep -n "function splitFrontMatter\|function parseFrontMatter" src/modules/schedule/task-file.ts src/modules/queue/queue-file.ts` 无输出（实现已上移）。

## 依赖

无。
