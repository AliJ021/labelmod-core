import { defineConfig } from "@playwright/test";

const widths = [320, 375, 768, 1024, 1440, 1920];
// Read/state/replay contracts retain both engines, themes and mobile/desktop.
// Every unlisted/new spec keeps the full responsive matrix by default.
const stateContracts = [
  "dashboard-freshness", "dashboard-period", "dashboard-sync",
  "instagram-orders-recovery", "settings-admin-actions", "site-orders",
].map(name => `**/${name}.spec.ts`);
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 4 : 3,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure", screenshot: "only-on-failure", serviceWorkers: "block" },
  // ترتیب پروژه‌ها مرورگر را **درونی‌ترین** حلقه می‌گذارد. `--shard` فهرست را به تکه‌های
  // پشت‌سرهم می‌بُرد؛ با مرورگر بیرونی، shard ۱ و ۲ تمام Chromium و ۳ و ۴ تمام WebKit بودند
  // (۱۶–۲۲ دقیقه در برابر ۳۵–۴۵+ و لغو با سقف ۴۵ دقیقهٔ job). حالا هر shard نیمی از هر موتور
  // را دارد. همان ۲۴ پروژه، همان نام‌ها، همان چهار shard — فقط ترتیب.
  projects: (["light", "dark"] as const).flatMap(colorScheme =>
    widths.flatMap(width =>
      (["chromium", "webkit"] as const).map(browserName => ({
        name: browserName + "-" + colorScheme + "-" + width,
        testIgnore: [375, 1440].includes(width) ? [] : stateContracts,
        // These cases set their own viewport before loading the application.
        // Repeating them at six nominal widths exercises identical geometry.
        ...(width === 1440 ? {} : { grepInvert: /@self-viewport/ }),
        use: { browserName, colorScheme, viewport: { width, height: 960 },
          ...(browserName === "chromium" && process.env.PLAYWRIGHT_EDGE === "1" ? { channel: "msedge" } : {}) },
      })))),
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI,
  },
});
