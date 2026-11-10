import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "scripts/**/*.test.ts",
    ],
    // 統合テストは Emulator が必要なため、通常の npm test には含めない
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.logscan.test.ts",
    ],
    // fast-check の共通設定（numRuns 100 以上）を全テストで読み込む
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
  },
});
