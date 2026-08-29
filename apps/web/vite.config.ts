import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // در توسعه، API روی ۳۰۰۰ است. Proxy یعنی مرورگر همه‌چیز را هم‌مبدأ
    // می‌بیند و کوکی نشستِ SameSite=Strict بدون تنظیم اضافه کار می‌کند.
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  build: { target: "es2022", sourcemap: true },
});
