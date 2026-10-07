import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // GitHub Pages のサブパス配下でも動くよう相対パスで出力する
  base: "./",
  worker: { format: "es" },
  plugins: [
    VitePWA({
      // 作業中に勝手に再読み込みされると分割線の編集が失われるため、更新は利用者に確認してから行う
      registerType: "prompt",
      injectRegister: false,
      // アイコンは globPatterns でプリキャッシュされるため二重登録しない
      includeManifestIcons: false,
      manifest: {
        name: "LP Image Slicer",
        short_name: "LP Slicer",
        description: "画像で作った LP を楽天向けに自動スライスするツール",
        lang: "ja",
        start_url: "./",
        scope: "./",
        display: "standalone",
        theme_color: "#bf0000",
        background_color: "#f6f7f9",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Web Worker のチャンクも含め、ビルド成果物をすべてプリキャッシュしてオフラインで動かす
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
