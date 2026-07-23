import i18next, { type TFunction } from "i18next";
import type { ChannelCommonContext, LocaleCode } from "../types";

export const DEFAULT_LOCALE: LocaleCode = "en-US";

const resources = {
  "en-US": {
    translation: {
      progress: {
        noProgress: "No progress yet.",
        collapsed: "Collapsed {{count}} earlier updates.",
        running: "Running {{subject}}",
        finished: "Finished {{subject}}",
        failed: "Failed {{subject}}",
        failedWithDetail: "Failed {{subject}}: {{detail}}",
        compacting: "Compacting session",
        compactingWithDetail: "Compacting session: {{detail}}",
      },
      client: {
        processing: "Processing...",
        messageDeliveryFailedTitle: "[agent-bridge error] Message delivery failed",
        weixinCooldown: "Weixin send is cooling down after rate limiting. Please try again shortly.",
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
        running: "正在执行 {{subject}}",
        finished: "已完成 {{subject}}",
        failed: "{{subject}} 执行失败",
        failedWithDetail: "{{subject}} 执行失败：{{detail}}",
        compacting: "正在压缩会话",
        compactingWithDetail: "正在压缩会话: {{detail}}",
      },
      client: {
        processing: "正在处理中...",
        messageDeliveryFailedTitle: "[agent-bridge 错误] 消息发送失败",
        weixinCooldown: "微信发送因限流已进入冷却，请稍后再试。",
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
