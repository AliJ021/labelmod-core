import { test, expect, fontsReady } from "./fixtures";

test("Woo diagnostics is read-only, retries safely and presents the downloadable package", async ({ page, api }) => {
  api.defaults["GET /settings/woocommerce"] = { siteUrl: "https://shop.example.test", warehouseId: "w1", pushEnabled: true, signingConfigured: true, priceList: "default" };
  let calls = 0;
  api.handlers.set("POST /settings/woocommerce/test", async route => {
    expect(route.request().postDataJSON()).toEqual({ orderId: 42 });
    calls++;
    await route.fulfill({ json: calls === 1
      ? { ok: false, code: "network", message: "اتصال کامل نشد؛ دوباره تست کنید.", remote: null }
      : { ok: true, message: "امضا و هویت سایت تأیید شد؛ ثبت سفارش با این آزمون اثبات نمی‌شود.", remote: {
        pluginVersion: "1.2.0", wooVersion: "10.0.0", siteUrl: "https://shop.example.test", apiKeyConfigured: true,
        stockPolling: true, pricePolling: false, cronDisabled: true, stockScheduled: true,
        mapping: { linkedProducts: 3 }, order: { found: true, status: "processing", paymentConfirmed: false,
          eligible: false, recorded: false, scheduled: false, attempts: 0, hasError: false, missingSku: 1, missingMapping: 0 },
      } } });
  });
  await page.goto("/?page=settings&settings.tab=woocommerce");
  await expect(page.getByRole("heading", { name: "اتصال ووکامرس", exact: true })).toBeVisible();
  await page.getByLabel("شمارهٔ داخلی سفارش ووکامرس (اختیاری)").fill("۴۲");
  const button = page.getByRole("button", { name: "تست اتصال", exact: true });
  await button.click();
  await expect(page.getByText("اتصال کامل نشد؛ دوباره تست کنید.", { exact: true })).toBeVisible();
  await button.click();
  await expect(page.getByText(/امضا و هویت سایت تأیید شد/)).toBeVisible();
  await expect(page.getByText("کلید همگام‌سازی لحظه‌ای در افزونه آماده است: نامعلوم؛ این نسخهٔ افزونه وضعیت کلید را گزارش نمی‌کند.", { exact: true })).toBeVisible();
  await expect(page.getByText(/از نسخهٔ 1\.3\.5 در فرم محافظت‌شدهٔ/)).toBeVisible();
  await expect(page.getByText(/ثابت قدیمی LMC_PUSH_SECRET فقط تا پیش از ذخیره یا پاک‌کردن صریح/)).toBeVisible();
  await expect(page.getByRole("link", { name: "دانلود افزونه" })).toHaveAttribute("href", /\/downloads\/labelmod-connector-\d+\.\d+\.\d+\.zip$/);
  expect(calls).toBe(2);
  expect(api.calls.filter(path => /POST \/(?:web\/orders|invoices|returns)/.test(path))).toEqual([]);
  await fontsReady(page);
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.client);
  await page.screenshot({ path: test.info().outputPath("woo-diagnostics.png"), animations: "disabled" });
});

test("Woo diagnostics renders both explicit Push-key states without confusing them with API-key state", async ({ page, api }) => {
  api.defaults["GET /settings/woocommerce"] = { siteUrl: "https://shop.example.test", warehouseId: "w1", pushEnabled: true, signingConfigured: true, priceList: "default" };
  let pushConfigured = true;
  api.handlers.set("POST /settings/woocommerce/test", async route => {
    await route.fulfill({ json: { ok: true, message: "وضعیت افزونه دریافت شد.", remote: {
      pluginVersion: "1.3.5", wooVersion: "10.0.0", siteUrl: "https://shop.example.test", apiKeyConfigured: true,
      pushConfigured, stockPolling: true, pricePolling: false, cronDisabled: false, stockScheduled: true,
      mapping: { linkedProducts: 3 }, order: null,
    } } });
  });
  await page.goto("/?page=settings&settings.tab=woocommerce");
  const button = page.getByRole("button", { name: "تست اتصال", exact: true });
  await button.click();
  await expect(page.getByText("کلید همگام‌سازی لحظه‌ای در افزونه آماده است: بله", { exact: true })).toBeVisible();
  pushConfigured = false;
  await button.click();
  await expect(page.getByText("کلید همگام‌سازی لحظه‌ای در افزونه آماده است: خیر", { exact: true })).toBeVisible();
  await expect(page.getByText("کلید همگام‌سازی لحظه‌ای در افزونه آماده است: بله", { exact: true })).toBeHidden();
  await expect(page.getByText(/کلید API در افزونه موجود: بله/)).toBeVisible();
  expect(api.calls.filter(path => /POST \/(?:web\/orders|invoices|returns)/.test(path))).toEqual([]);
});

test("Woo deep link cannot mount without settings.view", async ({ page, api }) => {
  api.handlers.set("GET /auth/can", async route => { await route.fulfill({ json: { verdict: "deny", approver: null, reason: "" } }); });
  await page.goto("/?page=settings&settings.tab=woocommerce");
  await expect(page.getByRole("heading", { name: "دسترسی ندارید" })).toBeVisible();
  expect(api.calls.some(path => path.includes("/settings/woocommerce"))).toBe(false);
  await expect(page.getByRole("button", { name: "تست اتصال", exact: true })).toBeHidden();
});
