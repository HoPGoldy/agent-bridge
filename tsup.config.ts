import { defineConfig } from "tsup";

export default defineConfig({
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
});
