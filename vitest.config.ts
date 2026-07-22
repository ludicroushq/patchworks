import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  test: {
    clearMocks: true,
    environment: "node",
    include: [
      "action/**/*.{test,spec}.mjs",
      "packages/*/test/**/*.{test,spec}.ts",
    ],
    mockReset: true,
    restoreMocks: true,
    coverage: {
      exclude: [
        "**/*.d.ts",
        "packages/*/src/commands/**",
        "packages/*/src/index.ts",
      ],
      include: ["action/runtime.mjs", "packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        branches: 80,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
