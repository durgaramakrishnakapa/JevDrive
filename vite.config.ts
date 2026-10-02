import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      // Full path so /api/drive/decide → /drive/decide
      "/api/drive/decide": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: () => "/drive/decide",
      },
      "/api/health": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: () => "/health",
      },
    },
  },
});
