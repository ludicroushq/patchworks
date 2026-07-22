import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: workspaceRoot,
  test: {
    clearMocks: true,
    environment: "node",
    include: ["packages/patchworks/test/**/*.{test,spec}.ts"],
    mockReset: true,
    restoreMocks: true,
    coverage: {
      exclude: [
        "**/*.d.ts",
        "packages/patchworks/src/commands/**",
        "packages/patchworks/src/index.ts",
      ],
      include: ["packages/patchworks/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage/patchworks",
      thresholds: {
        branches: 80,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
