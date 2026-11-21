import { test, expect, fontsReady } from "./fixtures";

test("manager retrieves the two Woo keys independently", async ({ page, api }) => {
  api.defaults["GET /settings/woocommerce"] = { siteUrl: "https://shop.example.test", warehouseId: "w1",
    pushEnabled: true, signingConfigured: false, priceList: "default", canManageKeys: true };
  api.handlers.set("POST /settings/woocommerce/credentials", async route => {
    const { kind, password } = route.request().postDataJSON();
    expect(password).toBe("fixture-only");
    await route.fulfill({ json: { key: "fixture-" + kind } });
  });
  await page.goto("/?page=settings&settings.tab=woocommerce");
  for (const [kind, label] of [["api", "کلید API برای افزونه"], ["push", "کلید امضا برای افزونه"]]) {
    await page.getByLabel("کلید مورد نیاز").selectOption(kind!);
    await page.getByLabel("رمز فعلی حساب").fill("fixture-only");
    await page.getByRole("button", { name: "ساخت یا نمایش کلید" }).click();
    await expect(page.getByLabel(label!, { exact: true })).toHaveValue("fixture-" + kind);
    await expect(page.getByLabel("رمز فعلی حساب")).toHaveValue("");
  }
});

test("reselecting a sidebar section returns to its home", async ({ page, api }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1000, "desktop sidebar");
  api.handlers.set("GET /invoices/fixture/overview", route => route.fulfill({ status: 404, json: { error: { code: "missing", message: "فاکتور موجود نیست" } } }));
  api.defaults["GET /settings/woocommerce"] = { siteUrl: "", warehouseId: "", pushEnabled: false, signingConfigured: false, priceList: "default" };
  await page.goto("/?page=invoices&invoices.id=fixture");
  const nav = page.getByRole("tablist", { name: "بخش‌ها", exact: true });
  await nav.getByRole("tab", { name: "فاکتورها", exact: true }).click();
  await expect(page).toHaveURL(/\/\?page=invoices$/);
  await page.goto("/?page=settings&settings.tab=woocommerce");
  await expect(page.getByRole("heading", { name: "اتصال ووکامرس", exact: true })).toBeVisible();
  await nav.getByRole("tab", { selected: true }).click();
  await expect(page).toHaveURL(/\/\?page=settings$/);
  await expect(page.getByRole("heading", { name: "اتصال ووکامرس", exact: true })).toHaveCount(0);
});

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
