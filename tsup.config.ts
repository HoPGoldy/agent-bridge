import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "agent-bridge": "bin/agent-bridge.ts",
      cli: "src/cli.ts",
      index: "src/index.ts",
    },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: true,
    dts: {
      entry: { index: "src/index.ts" },
    },
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    // media-prompt.ts is loaded by an external `pi` process as a module
    // (via `--extension`), never executed directly as a script. It must
    // NOT get the CLI shebang banner the entries above need — an external
    // loader isn't guaranteed to tolerate a leading `#!` line the way
    // Node's own module loader does. `clean: false` so this doesn't wipe
    // the output the first config just produced.
    entry: {
      "media-prompt": "src/modules/agent/pi-coding-agent/adapter/media-prompt.ts",
    },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: false,
  },
]);
