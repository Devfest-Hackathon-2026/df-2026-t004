import { defineConfig, devices } from "@playwright/test";

// E2E とアクセシビリティの検査（タスク 26.1）。
// ビルドした PWA を仮実装（mock）の API と仮のログインで動かす。`npm run test:e2e -w @hachioji-gov/web`
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "list" : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    // Service Worker のキャッシュが前の実行の画面を返さないようにする
    serviceWorkers: "block",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // 表示のアニメーションの途中（半透明）でコントラストを測らないよう、動きを減らす設定で開く
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    { name: "360px", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 } } },
    { name: "430px", use: { ...devices["Pixel 5"], viewport: { width: 430, height: 932 } } },
  ],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    // 手元の .env.local に Firebase の設定があっても、仮のログインで動かす
    env: { VITE_API_MODE: "mock", VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_PROJECT_ID: "" },
  },
});
