import { defineConfig } from "@playwright/test";

const widths = [320, 375, 768, 1024, 1440, 1920];
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
  projects: (["chromium", "webkit"] as const).flatMap(browserName =>
    (["light", "dark"] as const).flatMap(colorScheme =>
      widths.map(width => ({
        name: browserName + "-" + colorScheme + "-" + width,
        use: { browserName, colorScheme, viewport: { width, height: 960 },
          ...(browserName === "chromium" && process.env.PLAYWRIGHT_EDGE === "1" ? { channel: "msedge" } : {}) },
      })))),
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI,
  },
});
