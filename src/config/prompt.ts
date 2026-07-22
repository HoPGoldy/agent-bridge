import { cancel, confirm as clackConfirm, isCancel, password, select as clackSelect, text } from "@clack/prompts";
import type { ConfigCollectContext, ConfigInputOptions, ConfigSelectOption } from "../types";

function normalize(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function throwIfCancelled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new Error("Setup cancelled");
  }
}

export function createPromptContext(): ConfigCollectContext {
  return {
    async input(label: string, opts: ConfigInputOptions = {}) {
      const { defaultValue, required = false, secret = false, validate } = opts;

      const validateInput = (raw: unknown): string | undefined => {
        const value = normalize(raw) || normalize(defaultValue);
        if (required && !value) {
          return "This field is required.";
        }
        if (validate) {
          return validate(value) ?? undefined;
        }
        return undefined;
      };

      const raw = secret
        ? await password({ message: label, validate: validateInput })
        : await text({
            message: label,
            defaultValue: defaultValue || undefined,
            placeholder: defaultValue,
            validate: validateInput,
          });
      throwIfCancelled(raw);

      return normalize(raw) || normalize(defaultValue);
    },

    async select(label: string, options: ConfigSelectOption[]) {
      if (options.length === 0) {
        throw new Error("select() requires at least one option");
      }

      const value = await clackSelect<string>({
        message: label,
        options: options.map((option) => ({ value: option.value, label: option.label })),
      });
      throwIfCancelled(value);

      return value;
    },

    async confirm(label: string, defaultValue = false) {
      const value = await clackConfirm({ message: label, initialValue: defaultValue });
      throwIfCancelled(value);

      return value;
    },

    close() {
      // @clack/prompts manages the terminal per prompt; nothing to release.
    },
  };
}
