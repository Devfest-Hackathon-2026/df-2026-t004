import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// PWA の設定（Requirement 11.2, 12.4〜12.6）
// Service Worker は src/sw.ts（injectManifest）。キャッシュの方針は sw.ts に書く。
export default defineConfig(({ mode }) => {
  // 手元で API（packages/api）を動かすときだけ、/api/** をそこへ中継する。
  // API のルートは /api を含まないため、中継するときに取り除く
  const target = loadEnv(mode, process.cwd(), "").API_PROXY_TARGET;
  const proxy = target
    ? { "/api": { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") } }
    : undefined;
  return {
    plugins: [
      react(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        registerType: "prompt",
        injectRegister: false,
        injectManifest: { globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"] },
        devOptions: { enabled: false },
        manifest: {
          name: "hachioji-gov 子育て医療・福祉ナビ",
          short_name: "子育てナビ",
          description: "八王子市の子育て世帯むけ、医療・福祉の制度ナビ",
          lang: "ja",
          start_url: "/home",
          scope: "/",
          display: "standalone",
          orientation: "portrait",
          background_color: "#F7F8FA",
          theme_color: "#FFFFFF",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/icons/maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      }),
    ],
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  };
});
