import i18next, { type TFunction } from "i18next";
import type { ChannelCommonContext, LocaleCode } from "../types";

export const DEFAULT_LOCALE: LocaleCode = "en-US";

const resources = {
  "en-US": {
    translation: {
      progress: {
        noProgress: "No progress yet.",
        collapsed: "Collapsed {{count}} earlier updates.",
        running: "⏳ {{subject}}",
        finished: "✅ {{subject}}",
        failed: "❌ {{subject}}",
        failedWithDetail: "❌ {{subject}}: {{detail}}",
        compacting: "Compacting session",
        compactingWithDetail: "Compacting session: {{detail}}",
      },
      client: {
        processing: "Processing...",
        helpMessage:
          "Available commands:\n\n- `/new [path]` (`/n [path]`) - Start a new agent session; optionally start it in a specific directory, e.g. `/new /path/to/project`. A directory given once is remembered and reused by later `/new` without a path\n- `/compact` (`/c`) - Compact the current session context\n- `/stop` (`/s`) - Stop the active agent run\n- `/status` (`/st`) - Show the current agent session status\n- `/model` (`/m`) - List available models, or switch with `/model provider/modelId`\n- `/schedule-run <task-name>` - Run a scheduled task once now (the result is sent to the task's target chat)\n- `/schedule-here <task-name>` - Bind this chat as a task's result destination and set the task's owning channel (send this in the chat that should receive the results; an already-bound task must be unbound first)\n- `/queue-here <queue-name>` - Bind this chat as a queue's result destination (send this in the chat that should receive the results; an already-bound queue must be unbound by editing its file with AI)\n- `/help` (`/h`) - Show this help message",
        messageDeliveryFailedTitle: "[agent-bridge error] Message delivery failed",
        invalidNewWorkingDirectory:
          "Cannot start a new session: the working directory `{{workingDirectory}}` is invalid ({{detail}}).",
        invalidRememberedWorkingDirectory:
          "Cannot start a new session: the remembered default working directory `{{workingDirectory}}` is no longer valid ({{detail}}). Use `/new <path>` to choose a new one.",
        weixinCooldown: "Weixin send is cooling down after rate limiting. Please try again shortly.",
        scheduleRunTriggered:
          'Task "{{name}}" has been triggered. The result will be sent to its target chat.',
        scheduleRunTaskNotFound: 'Scheduled task "{{name}}" was not found.',
        scheduleRunTaskDisabled: 'Scheduled task "{{name}}" is disabled.',
        scheduleRunNoTarget: 'Scheduled task "{{name}}" has no valid target chat configured.',
        scheduleRunFailed: 'Failed to trigger scheduled task "{{name}}": {{reason}}',
        scheduleRunWrongChannel:
          'Scheduled task "{{name}}" belongs to channel "{{channel}}". Please run it from that channel.',
        scheduleRunUsage: 'Usage: `/schedule-run <task-name>` (task names match `[a-z0-9-]+`).',
        scheduleHereBound: 'Task "{{name}}" will send its results to this chat.',
        scheduleHereTaskNotFound: 'Scheduled task "{{name}}" was not found.',
        scheduleHereFailed: 'Failed to bind task "{{name}}": {{reason}}',
        scheduleHereAlreadyBound:
          'Task "{{name}}" is already bound to a chat. To rebind it, remove the `target`/`channel` lines from its task file (ask the AI in its current bound chat, or edit the file manually).',
        scheduleHereUsage: 'Usage: `/schedule-here <task-name>` (task names match `[a-z0-9-]+`).',
        queueHereBound: 'Queue "{{name}}" is now bound to this chat.',
        queueHereQueueNotFound: 'Queue "{{name}}" was not found.',
        queueHereAlreadyBound:
          'Queue "{{name}}" is already bound to a chat. To rebind, edit the queue file with AI.',
        queueHereFailed: 'Failed to bind queue "{{name}}": {{reason}}',
        queueHereUsage: 'Usage: `/queue-here <queue-name>` (queue names match `[a-z0-9-]+`).',
        statusTitle: "Current session status",
        statusSessionId: "Session ID",
        statusModel: "Model",
        statusThinkingLevel: "Thinking level",
        statusContext: "Context",
        statusChatSessionId: "Chat session ID",
        statusUnavailable: "Current session status is unavailable.",
        statusUnavailableValue: "Unavailable",
        modelListTitle: "Available models",
        modelListCurrent: "current",
        modelListUsage: "Use `/model provider/modelId` to switch.",
        modelListUnavailable: "Available models are unavailable for the current session.",
        modelSetUnavailable: "Current session model switching is unavailable.",
        modelInvalid: "The requested model is invalid or unavailable.",
        modelBusy: "Current session is busy, so the model cannot be switched. Please use `/stop` first.",
        modelUpdated: "Switched current model to `{{model}}`.",
        agentRunFailed: "The agent run failed.",
      },
      gateway: {
        noActiveSessionToCompact: "No active agent session to compact.",
        noActiveSessionToStop: "No active agent session to stop.",
        sessionCannotBeStopped: "This agent session cannot be stopped right now.",
        noActiveRunToStop: "No active agent run to stop.",
        startedNewSession: "Started a new session (working directory: {{workingDirectory}}).",
        failedToStartNewSession: "Failed to start a new session: {{detail}}",
        failedToResumeSession:
          "Failed to resume the agent session: {{detail}}\nStart a new session with `/new`.",
      },
      cli: {
        examplePrompt:
          "Tell me what time it is right now, in one sentence. (This is the example prompt — replace it.)",
        queueNamePrompt: "Queue name",
        queueNameInvalid:
          "Queue name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)",
        queueNameExists: 'A queue named "{{name}}" already exists.',
        workersPrompt: "Workers (default 1)",
        workersInvalid: "Workers must be a positive integer (>= 1).",
        modelPrompt: "Model (optional, blank = channel default)",
        queueCreated: "Created successfully!",
        queueCreatedGuideFile: "Edit {{filePath}} to set the shared context.",
        queueCreatedGuideBind: "Send `/queue-here {{name}}` in chat app to bind a chat.",
        queueCreatedGuideInsert:
          'Insert tasks with `agent-bridge queue insert {{name}} --prompt "..."`.',
        queueInserted: 'Inserted task {{taskId}} into queue "{{name}}".',
        queueInsertPromptRequired: "--prompt is required and must be a non-empty string.",
        queueInsertUnboundWarning:
          "Warning: the queue has no target yet — tasks wait until `/queue-here` binds a chat.",
        queueNotFound: 'Queue "{{name}}" not found.',
        noQueues: "No queues found. Add one with `agent-bridge queue add`.",
      },
      schedule: {
        taskCompletedSuffix: '*Scheduled task "{{name}}" completed · full output: {{path}}*',
        taskFailedSuffix: '*Scheduled task "{{name}}" failed · full output: {{path}}*',
        taskTimedOutSuffix: '*Scheduled task "{{name}}" timed out · full output: {{path}}*',
        taskNoOutputSuffix: '*Scheduled task "{{name}}" finished with no output · full output: {{path}}*',
        fireError: '❌ Scheduled task "{{name}}" could not start: {{detail}}',
      },
      queue: {
        taskCompletedSuffix: '*Queue "{{queue}}" task completed · full output: {{path}}*',
        taskFailedSuffix: '*Queue "{{queue}}" task failed · full output: {{path}}*',
        taskTimedOutSuffix: '*Queue "{{queue}}" task timed out · full output: {{path}}*',
      },
    },
  },
  "zh-CN": {
    translation: {
      progress: {
        noProgress: "暂无进度。",
        collapsed: "已折叠 {{count}} 条较早更新。",
        running: "⏳ {{subject}}",
        finished: "✅ {{subject}}",
        failed: "❌ {{subject}}",
        failedWithDetail: "❌ {{subject}}: {{detail}}",
        compacting: "正在压缩会话",
        compactingWithDetail: "正在压缩会话: {{detail}}",
      },
      client: {
        processing: "正在处理中...",
        helpMessage:
          "可用命令：\n\n- `/new [path]` (`/n [path]`) - 开始一个新会话；可选指定工作目录，例如 `/new /path/to/project`。指定过的目录会被记住，之后不带路径的 `/new` 会继续使用它\n- `/compact` (`/c`) - 压缩当前会话上下文\n- `/stop` (`/s`) - 停止当前正在运行的任务\n- `/status` (`/st`) - 查看当前智能体会话状态\n- `/model` (`/m`) - 查看可用模型，或使用 `/model provider/modelId` 切换模型\n- `/schedule-run <任务名>` - 立即运行一次定时任务（结果会发送到该任务的目标聊天）\n- `/schedule-here <任务名>` - 把本会话设为该任务结果的发送目标并确定其归属 channel（请在希望接收结果的聊天里发送；已绑定的任务需先解绑）\n- `/queue-here <队列名>` - 把本会话设为队列结果的发送目标（请在希望接收结果的聊天里发送；已绑定的队列需编辑文件解绑）\n- `/help` (`/h`) - 查看这条帮助信息",
        messageDeliveryFailedTitle: "[agent-bridge 错误] 消息发送失败",
        invalidNewWorkingDirectory:
          "无法开始新会话：工作目录 `{{workingDirectory}}` 无效（{{detail}}）。",
        invalidRememberedWorkingDirectory:
          "无法开始新会话：记住的默认工作目录 `{{workingDirectory}}` 已失效（{{detail}}）。请使用 `/new <路径>` 指定新目录。",
        weixinCooldown: "微信发送因限流已进入冷却，请稍后再试。",
        scheduleRunTriggered: '任务 "{{name}}" 已触发，结果将发送到其目标聊天。',
        scheduleRunTaskNotFound: '未找到定时任务 "{{name}}"。',
        scheduleRunTaskDisabled: '定时任务 "{{name}}" 已禁用。',
        scheduleRunNoTarget: '定时任务 "{{name}}" 未配置有效的目标聊天。',
        scheduleRunFailed: '无法触发定时任务 "{{name}}"：{{reason}}',
        scheduleRunWrongChannel:
          '定时任务 "{{name}}" 归属于 channel "{{channel}}"。请在该 channel 中运行它。',
        scheduleRunUsage: '用法：`/schedule-run <任务名>`（任务名需匹配 `[a-z0-9-]+`）。',
        scheduleHereBound: '任务 "{{name}}" 的结果将发送到本会话。',
        scheduleHereTaskNotFound: '未找到定时任务 "{{name}}"。',
        scheduleHereFailed: '无法绑定任务 "{{name}}"：{{reason}}',
        scheduleHereAlreadyBound:
          '任务 "{{name}}" 已绑定到某聊天。要重新绑定，请删除其任务文件中的 `target`/`channel` 行（可在它当前绑定的聊天里让 AI 处理，或手动编辑文件）。',
        scheduleHereUsage: '用法：`/schedule-here <任务名>`（任务名需匹配 `[a-z0-9-]+`）。',
        queueHereBound: '队列 "{{name}}" 已绑定到本会话。',
        queueHereQueueNotFound: '未找到队列 "{{name}}"。',
        queueHereAlreadyBound: '队列 "{{name}}" 已绑定到某个会话。如需重新绑定，请用 AI 编辑队列文件。',
        queueHereFailed: '无法绑定队列 "{{name}}"：{{reason}}',
        queueHereUsage: '用法：`/queue-here <队列名>`（队列名需匹配 `[a-z0-9-]+`）。',
        statusTitle: "当前会话状态",
        statusSessionId: "Session ID",
        statusModel: "模型",
        statusThinkingLevel: "思考等级",
        statusContext: "上下文",
        statusChatSessionId: "聊天会话 ID",
        statusUnavailable: "当前无法获取会话状态。",
        statusUnavailableValue: "暂不可用",
        modelListTitle: "可用模型",
        modelListCurrent: "当前",
        modelListUsage: "使用 `/model provider/modelId` 切换模型。",
        modelListUnavailable: "当前会话暂时无法获取可用模型列表。",
        modelSetUnavailable: "当前会话暂时无法切换模型。",
        modelInvalid: "请求的模型无效或当前不可用。",
        modelBusy: "当前正在运行，无法切换模型。请先使用 `/stop`。",
        modelUpdated: "当前模型已切换至 `{{model}}`。",
        agentRunFailed: "智能体任务执行失败。"
      },
      gateway: {
        noActiveSessionToCompact: "当前没有可压缩的智能体会话。",
        noActiveSessionToStop: "当前没有可停止的智能体会话。",
        sessionCannotBeStopped: "当前无法停止这个智能体会话。",
        noActiveRunToStop: "当前没有正在运行的智能体任务可停止。",
        startedNewSession: "已开始新会话（工作目录：{{workingDirectory}}）。",
        failedToStartNewSession: "无法开启新会话：{{detail}}",
        failedToResumeSession: "恢复智能体会话失败：{{detail}}\n请使用 `/new` 开始新会话。",
      },
      cli: {
        examplePrompt: "告诉我现在几点了，一句话就好。（这是示例 prompt，请替换成你自己的任务。）",
        queueNamePrompt: "队列名称",
        queueNameInvalid: "队列名称只能由小写字母、数字和连字符组成（[a-z0-9-]+）",
        queueNameExists: '已存在名为 "{{name}}" 的队列。',
        workersPrompt: "并发数（默认 1）",
        workersInvalid: "并发数必须是大于等于 1 的整数。",
        modelPrompt: "模型（可选，留空使用 channel 默认模型）",
        queueCreated: "创建成功！",
        queueCreatedGuideFile: "编辑 {{filePath}} 设置共享上下文。",
        queueCreatedGuideBind: "在聊天应用中发送 `/queue-here {{name}}` 绑定聊天。",
        queueCreatedGuideInsert: '使用 `agent-bridge queue insert {{name}} --prompt "..."` 插入任务。',
        queueInserted: '已向队列 "{{name}}" 插入任务 {{taskId}}。',
        queueInsertPromptRequired: "--prompt 为必填项，且不能为空。",
        queueInsertUnboundWarning:
          "警告：该队列尚未绑定目标聊天——任务将一直等待，直到通过 `/queue-here` 绑定。",
        queueNotFound: '未找到队列 "{{name}}"。',
        noQueues: "尚未创建任何队列。请使用 `agent-bridge queue add` 创建。",
      },
      schedule: {
        taskCompletedSuffix: '*定时任务 "{{name}}" 执行完成 · 完整内容见 {{path}}*',
        taskFailedSuffix: '*定时任务 "{{name}}" 执行失败 · 完整内容见 {{path}}*',
        taskTimedOutSuffix: '*定时任务 "{{name}}" 超时 · 完整内容见 {{path}}*',
        taskNoOutputSuffix: '*定时任务 "{{name}}" 执行完成，无输出 · 完整内容见 {{path}}*',
        fireError: '❌ 定时任务 "{{name}}" 无法启动：{{detail}}',
      },
      queue: {
        taskCompletedSuffix: '*队列 "{{queue}}" 任务执行完成 · 完整内容见 {{path}}*',
        taskFailedSuffix: '*队列 "{{queue}}" 任务执行失败 · 完整内容见 {{path}}*',
        taskTimedOutSuffix: '*队列 "{{queue}}" 任务超时 · 完整内容见 {{path}}*',
      },
    },
  },
} as const;

const instance = i18next.createInstance();
void instance.init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  resources,
  interpolation: { escapeValue: false },
  initAsync: false,
});

export type Translator = TFunction;

export function getTranslator(locale: LocaleCode): Translator {
  return instance.getFixedT(locale);
}

export function getTranslatorForCommon(common?: Pick<ChannelCommonContext, "language">): Translator {
  return getTranslator(common?.language ?? DEFAULT_LOCALE);
}

export function formatSendFailureNotice(t: Translator, detail: string): string {
  return `${t("client.messageDeliveryFailedTitle")}\n\n${detail}`;
}
