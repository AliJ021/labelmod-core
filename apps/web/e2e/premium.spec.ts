import { test, expect, product, rule, customer, staff, openCatalog, settings, fontsReady } from "./fixtures";
import type { Page, Route, Locator } from "@playwright/test";

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function screenshot(page: Page, name: string) {
  await fontsReady(page);
  await page.screenshot({ path: test.info().outputPath(name + ".png"), fullPage: true, animations: "disabled" });
}
async function tabContract(list: Locator, vertical = false) {
  const tabs = list.getByRole("tab");
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();
  const selected = list.locator('[aria-selected="true"]');
  const original = await selected.getAttribute("id");
  await selected.focus();
  await selected.press("End");
  await expect(tabs.last()).toBeFocused();
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("id", original!);
  await tabs.last().press("Home");
  await expect(tabs.first()).toBeFocused();
  await tabs.first().press(vertical ? "ArrowDown" : "ArrowLeft");
  await expect(tabs.nth(1)).toBeFocused();
  await tabs.nth(1).press(vertical ? "ArrowUp" : "ArrowRight");
  await expect(tabs.first()).toBeFocused();
  expect(await tabs.evaluateAll(nodes => nodes.filter(n => n.getAttribute("tabindex") === "0").length)).toBe(1);
  expect(count).toBeGreaterThan(1);
  for (const tab of await tabs.all()) {
    const panel = await tab.getAttribute("aria-controls");
    expect(await tab.evaluate((el, id) => document.getElementById(id!)?.getAttribute("aria-labelledby") === el.id, panel)).toBe(true);
  }
}

test("visual, local fonts, contrast, targets, long names and 200% text", async ({ page, api }) => {
  await openCatalog(page);
  await expect(page.getByRole("cell", { name: product.nameInternal, exact: true })).toBeVisible();
  await fontsReady(page);
  expect(api.fonts.some(x => x.includes("Vazirmatn"))).toBe(true);
  expect(api.fonts.filter(x => x.includes("IBMPlexMono")).length).toBe(4);
  expect(await page.evaluate(() => [...document.fonts].every(f => f.status === "loaded"))).toBe(true);
  const ratios = await page.locator(".search-field").evaluate(el => {
    const s = getComputedStyle(el);
    const input = getComputedStyle(el.querySelector("input")!);
    const luminance = (v: string) => {
      const c = v.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722;
    };
    const contrast = (a: string, b: string) => { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    return { border: contrast(s.borderColor, s.backgroundColor), text: contrast(input.color, s.backgroundColor) };
  });
  expect(ratios.border).toBeGreaterThanOrEqual(3);
  expect(ratios.text).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("searchbox").focus();
  await expect(page.locator(".search-field")).toHaveCSS("outline-style", "solid");
  for (const button of await page.locator(".tools button").all()) {
    const box = await button.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await noOverflow(page);
  await screenshot(page, "catalog");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect((await page.getByRole("searchbox").boundingBox())!.height).toBeGreaterThanOrEqual(68);
  await noOverflow(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await page.getByRole("button", { name: "باز کردن", exact: true }).click();
  await expect(page.getByRole("button", { name: "بایگانی‌کردن کالا" })).toBeVisible();
  await expect(page.locator(".catalog-detail")).toHaveCSS("gap", (page.viewportSize()!.width < 768 ? 16 : 24) + "px");
  for (const name of ["تاریخچه قیمت", "بایگانی‌کردن کالا"]) {
    const b = page.getByRole("button", { name, exact: true }); const box = await b.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await noOverflow(page);
  await screenshot(page, "product-detail");
  await settings(page, "appearance", "نمایش و عملکرد");
  await noOverflow(page);
  await screenshot(page, "settings");
  await page.getByRole("tab", { name: "داشبورد", exact: true }).click();
  await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
  await expect(page.locator("main .glass")).toHaveCount(0);
  await screenshot(page, "dashboard");
});

test("search debounce, Enter, stale response after latest response", async ({ page, api }) => {
  // انتقال ناسازگار عمداً سیگنال را نادیده می‌گیرد تا محافظ نسل نیز سنجیده شود.
  await page.addInitScript(() => {
    const native = window.fetch;
    window.fetch = (input, init) => { const options = { ...init }; delete options.signal; return native(input, options); };
  });
  let old: Route | undefined;
  api.handlers.set("GET /products", async (route, url) => {
    const q = url.searchParams.get("search");
    if (q === "A") { old = route; return; }
    await route.fulfill({ json: { products: [{ ...product, nameInternal: q || product.nameInternal }] } });
  });
  await openCatalog(page);
  const search = page.getByRole("searchbox");
  await expect(page.getByRole("cell", { name: product.nameInternal, exact: true })).toBeVisible();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
  const before = api.calls.filter(x => x.startsWith("GET /products")).length;
  await search.fill("A");
  await expect(page.getByRole("cell", { name: product.nameInternal, exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await page.clock.runFor(249);
  expect(api.calls.filter(x => x.startsWith("GET /products")).length).toBe(before);
  await page.clock.runFor(1);
  await expect.poll(() => !!old).toBe(true);
  await search.fill("AB"); await search.press("Enter"); await page.clock.runFor(1);
  await expect(page.getByRole("cell", { name: "AB", exact: true })).toBeVisible();
  await old!.fulfill({ json: { products: [{ ...product, nameInternal: "OLD" }] } });
  await expect(page.getByRole("cell", { name: "OLD", exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "AB", exact: true })).toBeVisible();
});

test("clear, filter and unmount cancel pending searches; error retry and empty states", async ({ page, api }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const held: Route[] = [];
  let fail = false;
  api.handlers.set("GET /products", async (route, url) => {
    if (url.searchParams.get("search") === "pending") { held.push(route); return; }
    if (fail) { await route.fulfill({ status: 503, json: { error: { code: "network", message: "خطای آزمایشی شبکه" } } }); return; }
    await route.fulfill({ json: { products: url.searchParams.has("search") ? [] : [product] } });
  });
  await openCatalog(page);
  const search = page.getByRole("searchbox");
  await search.fill("pending"); await search.press("Enter");
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "پاک‌کردن جست‌وجوی کد یا نام کالا", exact: true }).click();
  await expect(page.getByRole("cell", { name: product.nameInternal, exact: true })).toBeVisible();
  const firstCount = held.length;
  await search.fill("pending"); await search.press("Enter");
  await expect.poll(() => held.length).toBeGreaterThan(firstCount);
  const nextCount = held.length;
  await page.getByRole("checkbox", { name: "بایگانی‌شده‌ها هم" }).check();
  await expect.poll(() => held.length).toBeGreaterThan(nextCount);
  await page.getByRole("tab", { name: "داشبورد", exact: true }).click();
  for (const route of held) await route.fulfill({ json: { products: [{ ...product, nameInternal: "OLD" }] } }).catch(() => {});
  await page.getByRole("tab", { name: "کالا و قیمت", exact: true }).click();
  await expect(page.getByRole("cell", { name: "OLD", exact: true })).toHaveCount(0);
  fail = true;
  await search.fill("error"); await search.press("Enter");
  await expect(page.getByRole("alert")).toContainText("خطای آزمایشی شبکه");
  fail = false;
  await page.getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(page.getByText("برای این جست‌وجو کالایی پیدا نشد.")).toBeVisible();
  api.productRows = [];
  api.handlers.delete("GET /products");
  await page.getByRole("button", { name: "پاک‌کردن جست‌وجو", exact: true }).last().click();
  await expect(page.getByText("کالایی برای نمایش در این فهرست نیست.")).toBeVisible();
  await expect(page.getByRole("button", { name: "افزودن کالا", exact: true })).toBeVisible();
});

test("customers keep manual search; permissions keep local filtering; retry states", async ({ page, api }) => {
  api.handlers.set("GET /customers", async route => { await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای مشتریان" } } }); });
  await page.goto("/");
  await page.getByRole("tab", { name: "مشتریان", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("خطای مشتریان");
  api.handlers.delete("GET /customers");
  await page.getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(page.getByText("فهرست مشتریان خالی است.")).toBeVisible();
  const before = api.calls.filter(x => x.startsWith("GET /customers")).length;
  await page.getByRole("searchbox").fill("نام ناموجود");
  await page.waitForTimeout(300);
  expect(api.calls.filter(x => x.startsWith("GET /customers")).length).toBe(before);
  await page.getByRole("button", { name: "جست‌وجو", exact: true }).click();
  await expect(page.getByText("برای این جست‌وجو مشتری‌ای پیدا نشد.")).toBeVisible();
  api.handlers.set("GET /permission-rules", async route => { await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای مجوزها" } } }); });
  await settings(page, "permissions", "مجوزها");
  await expect(page.getByRole("alert")).toContainText("خطای مجوزها");
  api.handlers.delete("GET /permission-rules");
  await page.getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(page.getByText(rule.operation, { exact: true })).toBeVisible();
  const requests = api.calls.length;
  await page.getByRole("searchbox").fill("missing");
  await expect(page.getByText("برای این جست‌وجو مجوزی پیدا نشد.")).toBeVisible();
  expect(api.calls.length).toBe(requests);
  await page.getByRole("button", { name: "پاک‌کردن جست‌وجو", exact: true }).last().click();
  await expect(page.getByText(rule.operation, { exact: true })).toBeVisible();
});

test("RTL keyboard tabs, activation, one tab stop and responsive settings focus", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("tablist", { name: "بخش‌ها", exact: true });
  await tabContract(main);
  await main.getByRole("tab").first().press("End");
  await expect(main.getByRole("tab").last()).toBeFocused();
  await main.getByRole("tab").last().press("Enter");
  await expect(main.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
  if (page.viewportSize()!.width >= 768) {
    await tabContract(page.getByRole("tablist", { name: "بخش‌های تنظیمات" }), true);
    await page.getByRole("tab", { name: "نمایش و عملکرد", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("tab", { name: "نمایش و عملکرد", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.setViewportSize({ width: 375, height: 960 });
    await expect(page.getByRole("combobox", { name: "بخش تنظیمات" })).toBeFocused();
  }
  const picker = page.getByRole("combobox", { name: "بخش تنظیمات" });
  await picker.selectOption("appearance");
  await picker.focus();
  await page.setViewportSize({ width: 1024, height: 960 });
  await expect(page.getByRole("tab", { name: "نمایش و عملکرد", exact: true })).toBeFocused();
  for (const [name, list] of [["گزارش‌ها", "گزارش‌ها"], ["خزانه و چک", "بخش‌های خزانه"], ["انبار و خرید", "انبار و خرید"]] as const) {
    await main.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tablist", { name: list, exact: true })).toBeVisible();
    await tabContract(page.getByRole("tablist", { name: list, exact: true }));
    await screenshot(page, name);
  }
});

test("live reduced motion, transparency and persisted performance mode", async ({ page, browserName }) => {
  await page.goto("/");
  await settings(page, "appearance", "نمایش و عملکرد");
  const perf = page.getByRole("combobox", { name: /حالت عملکرد/ });
  await perf.selectOption("on");
  await expect(page.locator(".mesh")).toHaveCSS("display", "none");
  await expect(page.locator(".topbar")).toHaveCSS("backdrop-filter", "none");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-perf", "on");
  await settings(page, "appearance", "نمایش و عملکرد");
  await perf.selectOption("off");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".mesh i").first()).toHaveCSS("animation-name", "none");
  const angle = await page.locator(".topbar").getAttribute("style");
  await page.locator(".topbar").dispatchEvent("pointermove", { clientX: 120, clientY: 40 });
  expect(await page.locator(".topbar").getAttribute("style")).toBe(angle);
  await page.getByRole("tab", { name: "کالا و قیمت", exact: true }).click();
  await expect(page.locator(".zone-panel:not([hidden])")).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.effect instanceof KeyframeEffect && a.effect.pseudoElement?.startsWith("::view-transition")).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".mesh i").first()).not.toHaveCSS("animation-name", "none");
  await settings(page, "appearance", "نمایش و عملکرد");
  await perf.selectOption("system");
  await transparency(page, browserName, true);
  await expect(page.locator(".topbar")).toHaveCSS("backdrop-filter", "none");
  await transparency(page, browserName, false);
  await expect(page.locator(".topbar")).not.toHaveCSS("backdrop-filter", "none");
});

test("password suggestion, cancellation, server error, duplicate submit and success", async ({ page, api }) => {
  await page.goto("/");
  const account = page.getByRole("button", { name: "حساب مدیر آزمایشی" });
  const open = async () => { await account.click(); await page.getByRole("button", { name: "تغییر رمز من" }).click(); };
  await open();
  await page.getByRole("button", { name: "پیشنهاد رمز امن" }).click();
  expect(api.calls.some(x => x.startsWith("POST"))).toBe(false);
  await page.getByRole("button", { name: "انصراف", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(account).toBeFocused();
  await open();
  await page.getByLabel("رمز فعلی", { exact: true }).fill("Current-test-only-123");
  await page.getByRole("button", { name: "پیشنهاد رمز امن" }).click();
  await page.getByRole("button", { name: "بررسی و ادامه" }).click();
  await expect(page.getByRole("button", { name: "تأیید نهایی و تغییر رمز" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  let pending: Route | undefined;
  api.handlers.set("POST /auth/change-password", async route => { pending = route; });
  await page.getByRole("button", { name: "تأیید نهایی و تغییر رمز" }).click();
  await expect.poll(() => !!pending).toBe(true);
  await page.locator("dialog form").evaluate(form => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await expect(page.getByRole("button", { name: "در حال تغییر رمز…" })).toBeDisabled();
  expect(api.calls.filter(x => x === "POST /auth/change-password")).toHaveLength(1);
  await pending!.fulfill({ status: 500, json: { error: { code: "test", message: "ثبت رمز انجام نشد" } } });
  await expect(page.getByRole("alert")).toContainText("ثبت رمز انجام نشد");
  api.handlers.delete("POST /auth/change-password");
  await page.getByRole("button", { name: "تأیید نهایی و تغییر رمز" }).click();
  await expect(page.getByLabel("نام کاربری", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("همهٔ نشست‌ها بسته شدند");
});

test("header lock and logout keep their independent behavior", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "قفل صفحه", exact: true }).click();
  await expect(page.getByRole("heading", { name: "صفحه قفل است" })).toBeVisible();
  expect(api.calls).toContain("POST /auth/lock");
  await page.reload();
  await page.getByRole("button", { name: "خروج", exact: true }).click();
  await expect(page.getByLabel("نام کاربری", { exact: true })).toBeVisible();
  expect(api.calls).toContain("POST /auth/logout");
});

const sessions = new WeakMap<Page, import("@playwright/test").CDPSession>();
async function transparency(page: Page, engine: string, reduce: boolean) {
  if (engine === "chromium") {
    let cdp = sessions.get(page);
    if (!cdp) { cdp = await page.context().newCDPSession(page); sessions.set(page, cdp); }
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: reduce ? "reduce" : "no-preference" }] });
    return;
  }
  // Playwright در WebKit امکان تقلید این ترجیح سیستم را ندارد؛ خودِ قواعد CSS سنجیده می‌شوند.
  await page.evaluate(enabled => {
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && (rule.media.mediaText.includes("prefers-reduced-transparency") || rule.media.mediaText === "all")) {
        rule.media.mediaText = enabled ? "all" : "(prefers-reduced-transparency: reduce)";
      }
    }
  }, reduce);
}

test("populated customers, empty permissions and clear actions", async ({ page, api }) => {
  api.defaults["GET /customers"] = { customers: [customer] };
  api.permissionRows = [];
  await page.goto("/");
  await page.getByRole("tab", { name: "مشتریان", exact: true }).click();
  await expect(page.getByRole("cell", { name: customer.fullName!, exact: true })).toBeVisible();
  await noOverflow(page);
  await screenshot(page, "customers");
  await settings(page, "permissions", "مجوزها");
  await expect(page.getByText("مجوزی برای نمایش وجود ندارد.")).toBeVisible();
  await screenshot(page, "permissions-empty");
});

test("staff password reset needs review; current user gets personal flow", async ({ page, api }) => {
  await page.goto("/");
  await settings(page, "staff", "پرسنل");
  const ownRow = page.getByRole("row").filter({ hasText: "synthetic_admin" });
  await ownRow.getByRole("button", { name: "رمز تازه" }).click();
  await expect(page.getByLabel("رمز فعلی", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "انصراف", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: staff.username });
  await row.getByRole("button", { name: "رمز تازه" }).click();
  await expect(page.getByLabel("رمز فعلی", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "پیشنهاد رمز امن" }).click();
  expect(api.calls.filter(x => x.startsWith("POST"))).toHaveLength(0);
  await page.getByRole("button", { name: "بررسی و ادامه" }).click();
  await expect(page.getByRole("button", { name: "تأیید نهایی و تغییر رمز" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /رمز تازه را نگه داشته‌ام/ }).check();
  await screenshot(page, "password-review");
  let submitted: unknown;
  api.handlers.set("POST /users/" + staff.id + "/reset-password", async route => {
    const body = route.request().postDataJSON() as { password: string };
    submitted = body; await route.fulfill({ json: { password: body.password, note: "test" } });
  });
  await page.getByRole("button", { name: "تأیید نهایی و تغییر رمز" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted).toEqual({ password: expect.stringMatching(/.{12,}/) });
  await expect(page.getByRole("status")).toContainText("همهٔ نشست‌های او بسته شدند");
  expect(api.calls.filter(x => x.startsWith("POST"))).toHaveLength(1);
});
