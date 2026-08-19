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

---

## 2026-08-18 定时任务支持 per-task 模型指定

问题：模型指定的作用范围——只做定时任务 per-task，还是通用 per-session 覆盖？

用户回答：只做定时任务 per-task（任务文件加 `model:` 字段，只影响任务创建的独立会话）。通用 per-session 已存在（聊天内 `/model` 命令），不需要重做。

---

问题：任务里写的模型无效/不可用时的表现？

用户回答：fail-fast——该次运行直接失败，把"模型不可用"作为失败通知投递到目标聊天，不做回落（不用静默 fallback，不在扫描阶段校验）。

---

问题：`schedule add` 交互向导是否加模型输入步骤？

用户回答：加一步可选输入，留空表示用 channel 默认模型。（CLI 不做模型有效性校验，写错靠 fire 时 fail-fast 兜底。）

---

问题：`schedule list` 是否加 Model 列？

用户回答：不加，想看模型就打开任务文件。（list 保持现状。）

---

问题：会话创建失败如何回传给 Scheduler（T6 设计讨论，含用户提问后澄清：inject === core.input 的直接 await，core 入口吞错误导致异常传播不可行）？

用户回答：不用异常。core 吞错误没问题，但 input/inject 的返回值从 `Promise<void>` 改为返回结果对象（`{ ok: true } | { ok: false; reason: string }`）：正常创建返回 ok:true；失败返回 ok:false + 原因。adapter 调用方忽略返回值（fire-and-forget 不变），scheduler 检查返回值决定是否继续注入 user.message、结束 run 并投递失败通知。另：`inject` 命名不佳，需改为更语义化的名字。

---

### Event 队列（Agent 任务队列，2026-08-19 开始 grill）

背景：新特性——Event/Agent 队列。队列有名字、Worker 数量、Worker 模型；可插入任务（结构体暂只有 prompt）；Controller 定期检查、FIFO 取任务、并发上限 = Worker 数。整体架构与定时任务同构。

问题：插任务的命令是什么形态（CLI / IM / 两者）？队列归属（全局 vs per-channel）？

用户回答：队列和 Schedule 一样绑定到指定 Channel——启用前必须先执行 `/queue-here` 命令绑定当前聊天为投递目标（任务完成总要有个地方告诉用户）。插入命令 CLI 和 IM 两个都要，命名统一为 queue insert 语义。

问题：队列创建命令形态？

用户回答：A——只有 CLI `agent-bridge queue add` 交互向导（队列名、channel、Worker 数量、Worker 模型），写入 queues/<name>.md（front matter 记 channel/workers/model）；创建后在对应 channel 执行 /queue-here 绑定目标聊天才启用；后续改配置靠 AI 编辑文件。**另外：队列 MD 文件的正文内容会附加到每个队列任务的 prompt 中**（作为共享上下文/指令）。

问题：任务执行失败语义？

用户回答：A——失败即弃：投递失败通知（带真实原因）到绑定聊天，任务出队，继续跑下一个。无重试、不阻塞队列；想重跑就重新 insert。与定时任务一致。

问题：重启时在途任务怎么办？

用户回答：A——重新入队重新执行（at-least-once）。用户补充设想：Controller 定时触发前先检查持久化状态里的 pending 任务，有就直接重启这些任务。

事实自查（用户提问）：定时任务无 pending 持久化——任务定义（schedules/*.md）持久化，但运行状态纯内存，重启时在途 run 静默消失、停机期错过的触发跳过。当前持久化：config.json（channel 配置）、schedules/*.md、session-bindings/<channel>.json v3（bindings 活跃聊天绑定 + agentSessions/clientSessions 记录）、pi-sessions/（pi 自己的会话历史）。Event 队列的 pending task 持久化是新能力。

问题：队列查看/管理命令？

用户回答：A——只加 CLI `agent-bridge queue list`（队列名、绑定状态、pending 数、在途数）；删除队列、清空 pending 等低频操作让 AI 直接操作文件，不加命令；IM 无 queue-list。

问题：IM `/queue-insert` 命令？

用户回答：本版本不做 IM 的 queue insert——只能通过 CLI（`agent-bridge queue insert <name> --prompt "..."`）插入任务。

问题：未绑定队列的行为？

用户回答：A——CLI 随时可 insert（任务落盘等待），Controller 只在已绑定（有 target）时才消费，绑定后自动消化积压；**但 CLI insert 时若队列未绑定聊天，CLI 要输出警告提醒调用者**。

问题：Worker 槽位释放后的补充时机（workers=2、4 个任务时一个 tick 立即 fire 2 个；跑完后等 tick 还是立刻补）？

用户回答：A——纯 tick 驱动，跑完等下次 tick（最坏 30s 空转）再取下一个。实现最简单，与 scheduler 完全同构。

## 2026-08-19（二）

背景：包含长期异步 subagent 的会话被 idle 回收器误杀（idle 回收 = 10min 无事件 + isBusy()==false；pi adapter 的 isBusy 只覆盖 turn 流式中，等异步回调期间会话无事件 → 误杀，pi 进程被杀导致后台工作陪葬）。另发现 schedule/queue 的完成信号缺陷：第一条 assistant.message 即结束 run，后续事件丢弃、超时计时器清除，session 被"放生"。

调查结论：pi RPC set_model 无 busy 检查、session.setModel 直接换模型下次调用生效（bridge 的 isBusy 门槛是双重画蛇添足）；异步 subagent 以 pi 子进程运行、完成经扩展内部事件总线 → pi.sendMessage(customType, triggerTurn) 注入自定义消息触发新 turn；pi core 不感知扩展的后台工作，agent_settled 不能当完成信号；子进程检测覆盖不了"触发外部系统异步"的场景（用户指出，撤回）。

决策：
1. isBusy 从 AgentAdapter 接口整个删除：core 纯转发零附加逻辑（/model 直接丢给 adapter）；防御收回 adapter 内部（abort 内部自行判断 activeRun）；idle 回收改为纯事件 idle 超时，默认 24h（agentIdleTimeoutMs 可配）。
2. schedule/queue 完成判定三层（用户两次修改后定稿）：
   - 第一层：agent 完成任务时在最终消息末尾输出 BRIDGE_TASK_STATUS_DONE（中间消息不带任何标记）；bridge 剥离标记。
   - 第二层（用户改）：静默 N 分钟且无 DONE → 主动向会话发探测消息（"如果结束请返回 DONE，没结束请继续"），不被动宣判；探测无回应不加重启逻辑，靠第三层兜底；探测问答也进累积文件。
   - 第三层：墙上时钟 run timeout 封顶，到点投递已有累积内容 + 超时通知。
3. 累积到本地文件：run 期间所有 assistant.message 写入本地文件，结束后统一投递全文（用户拍板）。
4. WAITING（等异步回调）期间占 worker 槽位（v1）。
5. N 默认 10 分钟，可在任务/队列定义里配置。
6. 根治长期路径：pi 上游扩展注册 pending-work 句柄 + RPC 暴露（本版不做）。
