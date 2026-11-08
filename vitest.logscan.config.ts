import { defineConfig } from "vitest/config";

// ログの個人情報スキャン用の設定（npm run test:integration の後に実行する）
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.logscan.test.ts"],
    environment: "node",
  },
});
