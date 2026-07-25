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
          "Available commands:\n\n- `/new` (`/n`) - Start a new agent session\n- `/compact` (`/c`) - Compact the current session context\n- `/stop` (`/s`) - Stop the active agent run\n- `/status` (`/st`) - Show the current agent session status\n- `/model` (`/m`) - List available models, or switch with `/model provider/modelId`\n- `/help` (`/h`) - Show this help message",
        messageDeliveryFailedTitle: "[agent-bridge error] Message delivery failed",
        weixinCooldown: "Weixin send is cooling down after rate limiting. Please try again shortly.",
        statusTitle: "Current session status",
        statusSessionId: "Session ID",
        statusModel: "Model",
        statusThinkingLevel: "Thinking level",
        statusContext: "Context",
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
      },
      gateway: {
        noActiveSessionToCompact: "No active agent session to compact.",
        noActiveSessionToStop: "No active agent session to stop.",
        sessionCannotBeStopped: "This agent session cannot be stopped right now.",
        noActiveRunToStop: "No active agent run to stop.",
        startedNewSession: "Started a new session.",
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
          "可用命令：\n\n- `/new` (`/n`) - 开始一个新会话\n- `/compact` (`/c`) - 压缩当前会话上下文\n- `/stop` (`/s`) - 停止当前正在运行的任务\n- `/status` (`/st`) - 查看当前智能体会话状态\n- `/model` (`/m`) - 查看可用模型，或使用 `/model provider/modelId` 切换模型\n- `/help` (`/h`) - 查看这条帮助信息",
        messageDeliveryFailedTitle: "[agent-bridge 错误] 消息发送失败",
        weixinCooldown: "微信发送因限流已进入冷却，请稍后再试。",
        statusTitle: "当前会话状态",
        statusSessionId: "Session ID",
        statusModel: "模型",
        statusThinkingLevel: "思考等级",
        statusContext: "上下文",
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
      },
      gateway: {
        noActiveSessionToCompact: "当前没有可压缩的智能体会话。",
        noActiveSessionToStop: "当前没有可停止的智能体会话。",
        sessionCannotBeStopped: "当前无法停止这个智能体会话。",
        noActiveRunToStop: "当前没有正在运行的智能体任务可停止。",
        startedNewSession: "已开始新会话。",
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
  initImmediate: false,
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
