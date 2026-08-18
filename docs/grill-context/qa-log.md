# Grill 问答记录

问题：配完定时任务后，怎么立刻验证它工作（而不是等 schedule 到点）？

用户回答：采纳推荐方案——IM 侧手动触发命令，实现为 adapter-local 命令，调 scheduler.runNow 复用完整 fire 链路。但要求**不用子命令形式**：命令扁平化，如 `/schedule-run`、`/schedule-bind`，不用 `/schedule run` 这种"命令 + 子命令"结构。

---

问题：overlap 并发策略（skip/queue/restart 三选一）的设计是否合理？

用户回答：否决。改为更简单的超时模型：①配置时每任务指定最大超时时间；②执行超过超时时间就被杀掉；③每次触发都启动全新任务，任务之间互不影响，因此不需要 overlap 配置。一个任务的结束只有两个条件：完成，或超时。

---

问题：任务开始时要不要往绑定聊天发一条"开始执行"提示？

用户回答：不加，保持简单。绑定聊天里只出现三种消息：结果、失败通知、超时通知。

---

问题：要不要持久化任务运行记录（lastFiredAt/lastOutcome/lastError）到 channel 状态文件，供 CLI `schedule list` 展示？

用户回答：不做。任务完成/失败/超时自然会在绑定聊天里产生消息，用户那边就是一个直观的红点，这就是通知面。CLI 侧不做运行状态观测。另外补充：失败/超时必须发消息告诉用户，不能让用户干等（spec D2 已覆盖）。

---

问题：任务已绑定后想把投递地址挪到另一个聊天，怎么操作（remove+add 会删掉 prompt 文件，不合理）？

用户回答：不绑定码机制。改为：给 `/st` 状态输出加上当前聊天的会话 ID 展示，用户复制后粘贴到任务文件的 `target` 字段即可；绑定/改绑/解绑都是编辑文件，靠热加载生效。前提经核实成立：`/st` 的渲染事件里本就带有 clientSessionId，只是没展示。

---

问题：定时任务去 channel 化改造中，任务的触发权归属怎么判定（运行时绑定 map 匹配 vs 绑定时记录 channel vs 其他）？

用户回答：坚持运行时 map 匹配——每个 channel 遍历所有任务，target 在自己的会话绑定 map 里就触发。针对风险B（重复触发）：`/schedule-here` 时做全局校验，确保任务名全局唯一；且任务已绑定 chat 后再绑定要提示"已存在绑定，请先解绑"（不再静默覆盖）。风险C（channel 状态丢失导致不触发）太极端，不考虑，出问题让 AI 排查即可。

---

问题：Client Adapter 能看到会话绑定 map 吗？

（事实性回答，非用户决策）看不到：`#clientToAgentSession` 是 GatewayCore 私有字段且无公开 accessor。但做触发决策的是 Scheduler（channel-runner 层，与 Core 同侧），给 GatewayCore 加一个公开 `hasClientBinding` 方法、由 channel-runner 注入 Scheduler 即可，与现有 `validateTarget` 注入模式一致；adapter 侧无需改动。

---

问题：0 匹配场景（目标聊天不在任何 channel 的绑定 map 里）怎么处理？是否引入 knownChats 集合？

用户回答：否决 knownChats 方案（持久化数据分散成两处，手动迁移会出问题）。**推翻上一轮"运行时 map 匹配"的方案**，改为：所有任务文件放到同一个共享目录，不再按 channel 分目录；front matter 增加 `channel` 字段（由处理 `/schedule-here` 的 channel 在绑定时写入），channel 运行时扫描全部任务、只触发 `channel` 字段等于自己名字的任务。

---

问题：解绑怎么操作（新增 `/schedule-unbind` 命令 vs 手动编辑文件）？

用户回答：选项 2——不加命令，解绑 = 编辑任务文件删掉 `target`/`channel` 字段，靠热加载生效。理由：这类低频管理操作完全可以让 AI 来做（用户直接在聊天里让 agent 改文件）。

---

问题：`/schedule-run` 手动触发要不要做跨 channel 归属校验？

用户回答：同意推荐方案——任务文件 `channel` 字段与当前 channel 不匹配时拒绝执行，并提示"该任务归属于 channel X"（channel 名从任务文件读）；未绑定任务维持现状（无 target 拒绝）。

---

问题：存量 `schedules/<channel>/` 旧布局的迁移策略（自动迁移 vs 手动迁移文档 vs 双目录扫描兼容）？

用户回答：选项 3——双目录扫描兼容：scheduler 同时扫共享目录（按 `channel` 字段过滤）和自己 channel 的旧目录（归属该 channel），不做数据迁移。

---

问题：旧布局的冲突规则与生命周期（双扫时的同名遮蔽规则、永久支持还是兼容期）？

用户回答：**推翻上一轮"双目录扫描兼容"的决定**——直接忽视旧的 `schedules/<channel>/` 目录，不扫描、不迁移。

---

问题：要不要给"旧目录被忽视"加启动 warn 日志？

用户回答：不用。这个项目只有作者本人在用，存量任务失效后自己手动搬一下即可，不需要任何兼容/提示设施。

---

问题：解绑的判定依据（补充确认）？

用户回答：（本轮总结时提出）`/schedule-here` 判"已绑定"的依据是 `target` 或 `channel` 任一非空，拒绝并提示先解绑。
