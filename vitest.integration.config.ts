import { defineConfig } from "vitest/config";

// 統合テスト用の設定（Firebase Emulator 上で実行する）
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
    // すべてのファイルが同じ Emulator（同じ Firestore と Auth）を使い、各テストの前にデータを
    // 消して入れ直すため、ファイルを並列に動かすとお互いのデータを壊す。1ファイルずつ実行する。
    fileParallelism: false,
  },
});
