/**
 * پیکربندی جدای ابزار اندازه‌گیری صندوق — عمداً بیرون از CI.
 *
 * پرونده‌ها `*.perf.ts`اند و الگوی پیش‌فرض Playwright در `playwright.config.ts` (`*.spec.ts`)
 * آن‌ها را نمی‌گیرد؛ پس هیچ آزمون زمان‌دار و ناپایداری وارد CI نمی‌شود. اجرا فقط دستی:
 *
 *   VITE_LMC_UI_KIT=1 pnpm --filter @labelmod/web build
 *   pnpm --filter @labelmod/web exec playwright test -c e2e/perf/playwright.perf.config.ts
 *
 * `PERF_CHROMIUM=/path/to/chromium` مرورگر نصب‌شده را جایگزین می‌کند (بی دانلود تازه).
 * `PERF_OUT=file.json` نتیجهٔ خام را می‌نویسد.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.perf.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173", browserName: "chromium", viewport: { width: 1366, height: 900 },
    serviceWorkers: "block", colorScheme: "light",
    ...(process.env.PERF_CHROMIUM ? { launchOptions: { executablePath: process.env.PERF_CHROMIUM } } : {}),
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    cwd: "../..", url: "http://127.0.0.1:4173", reuseExistingServer: true,
  },
});
