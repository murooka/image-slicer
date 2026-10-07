import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages のサブパス配下でも動くよう相対パスで出力する
  base: "./",
  worker: { format: "es" },
});
