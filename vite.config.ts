import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // Android 8/9 可更新至兼容此基线的 WebView；不要随 Vite 默认目标漂移。
    target: ["chrome111", "edge88", "firefox78", "safari14"],
    cssTarget: ["chrome111", "edge88", "firefox78", "safari14"],
    rollupOptions: {
      output: {
        // 稳定的框架与组件库分别缓存，页面继续按路由懒加载。
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (!path.includes("/node_modules/")) return;
          if (/\/(?:primevue|@primevue)\//.test(path)) return "primevue";
          if (/\/(?:vue|@vue|vue-router|pinia)\//.test(path)) return "vue-runtime";
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
