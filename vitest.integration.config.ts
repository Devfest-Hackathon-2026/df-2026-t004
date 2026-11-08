import { defineConfig } from "vitest/config";

// 統合テスト用の設定（Firebase Emulator 上で実行する）
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
  },
});
