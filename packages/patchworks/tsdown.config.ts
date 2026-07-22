import { defineConfig } from "tsdown";

export default defineConfig({
  attw: {
    level: "error",
  },
  clean: true,
  deps: {
    // Chalk is ESM-only; bundling it keeps the advertised CommonJS export usable.
    alwaysBundle: ["chalk"],
    onlyBundle: false,
  },
  dts: {
    sourcemap: true,
  },
  entry: [
    "src/index.ts",
    "src/commands/create.ts",
    "src/commands/update.ts",
    "src/update/index.ts",
  ],
  failOnWarn: true,
  format: ["esm", "cjs"],
  platform: "node",
  publint: true,
  sourcemap: true,
  target: "es2022",
});
