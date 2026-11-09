import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// PWA の設定（Requirement 11.2, 12.4〜12.6）
// Service Worker は src/sw.ts（injectManifest）。キャッシュの方針は sw.ts に書く。
export default defineConfig({
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
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
