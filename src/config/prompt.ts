import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ConfigCollectContext, ConfigInputOptions, ConfigSelectOption } from "../types";

function normalize(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function createPromptContext(): ConfigCollectContext {
  const rl = createInterface({ input, output });

  return {
    async input(label: string, opts: ConfigInputOptions = {}) {
      const { defaultValue, required = false, secret = false, validate } = opts;

      while (true) {
        const suffix = defaultValue ? ` (${defaultValue})` : "";
        const raw = await rl.question(`${label}${suffix}: `);
        const value = normalize(raw) || normalize(defaultValue);

        if (required && !value) {
          output.write("This field is required.\n");
          continue;
        }

        if (validate) {
          const message = validate(value);
          if (message) {
            output.write(`${message}\n`);
            continue;
          }
        }

        if (secret && value) {
          output.write("(secret captured)\n");
        }

        return value;
      }
    },

    async select(label: string, options: ConfigSelectOption[]) {
      if (options.length === 0) {
        throw new Error("select() requires at least one option");
      }

      output.write(`${label}\n`);
      options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${option.label}\n`);
      });

      while (true) {
        const raw = await rl.question("Select an option by number: ");
        const index = Number.parseInt(raw, 10);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          return options[index - 1]!.value;
        }
        output.write("Invalid selection.\n");
      }
    },

    async confirm(label: string, defaultValue = false) {
      const defaultHint = defaultValue ? "Y/n" : "y/N";
      while (true) {
        const raw = normalize(await rl.question(`${label} (${defaultHint}): `)).toLowerCase();
        if (!raw) return defaultValue;
        if (["y", "yes"].includes(raw)) return true;
        if (["n", "no"].includes(raw)) return false;
        output.write("Please answer yes or no.\n");
      }
    },

    close() {
      rl.close();
    },
  };
}
