/**
 * یافته‌های بازبینی مستقل PR #110 — مجوز محافظه‌کار (F-110-01)، تنظیمات شخصی
 * جدا از مدیریتی (F-110-02) و برگهٔ مودال «بیشتر» (F-110-04).
 *
 * بی زمان‌انتظار دلخواه: هر حالت «در حال بررسی» با نگه‌داشتن صریح پاسخ
 * `/auth/can` ساخته می‌شود و با رهاکردنش پایان می‌یابد. «هیچ فلشی» با
 * MutationObserver ثابت می‌شود که هر برچسبی را که **هرگز** در ناوبری ساخته
 * شده ثبت می‌کند، نه فقط وضعیت پایانی را.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { NAV_OPERATIONS } from "../src/lib/navigation";

type Decision = "allow" | "deny" | "fail";
const PROTECTED = ["صندوق", "فاکتورها", "مرجوعی", "کالا و قیمت", "انبار و خرید", "خزانه و چک", "مشتریان", "گزارش‌ها"];
const PERSONAL = ["نمایش و عملکرد", "PIN من — ساخت و تغییر", "ورود دومرحله‌ای", "برداشت‌های من"];
const ADMIN = ["تنظیمات", "سلامت سیستم", "اتصال ووکامرس", "پشتیبان‌گیری و بازیابی", "کدینگ حساب", "نگاشت حساب", "اسنپ‌پی", "دیجی‌پی", "پایانه‌ها", "افتتاحیه و تفصیلی", "پرسنل", "دفتر برداشت پرسنل", "مجوزها", "دستگاه‌ها"];

/** پاسخ‌های مجوز تا `release()` نگه داشته می‌شوند؛ تصمیم هر عملیات قابل عوض‌کردن است. */
function authorize(api: MockApi, decide: (operation: string) => Decision, held = false) {
  let release!: () => void;
  const gate = held ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  if (!held) release = () => {};
  const control = { decide, release: () => release() };
  api.handlers.set("GET /auth/can", async (route, url) => {
    await gate;
    const verdict = control.decide(url.searchParams.get("operation") ?? "");
    if (verdict === "fail") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "سرور در دسترس نیست" } } });
    else await route.fulfill({ json: { verdict, approver: null, reason: "" } });
  });
  return control;
}

/** هر برچسبی که هرگز در ناوبری اصلی یا برگهٔ «بیشتر» ساخته شود. */
async function recordNavigation(page: Page) {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __navSeen: Set<string> }).__navSeen = seen;
    const scan = () => {
      for (const node of document.querySelectorAll('[role="tablist"][aria-label="بخش‌ها"] [role="tab"], #more-sheet a')) seen.add(node.textContent?.trim() ?? "");
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  return () => page.evaluate(() => [...(window as unknown as { __navSeen: Set<string> }).__navSeen].sort());
}

const compact = (page: Page) => page.viewportSize()!.width < 900;
/**
 * ورود برگه با transform متحرک است؛ هندسه پس از پایان واقعی انیمیشن، نه پس از یک زمان دلخواه.
 * `getAnimations` گذارهای CSS زیردرخت را هم می‌دهد و گذارِ لغوشده (مثلاً hover زیر اشاره‌گرِ
 * ثابت هنگام بالاآمدن برگه) با `AbortError` رد می‌شود — آن «پایان» نیست؛ پس دوباره تا هیچ
 * پویانمایی در راهی نماند صبر می‌کنیم (CI run 36654199697، WebKit). سقف دور فقط برای گیر نکردن است.
 */
const settled = (target: Locator) => target.evaluate(async el => {
  for (let round = 0; round < 20; round++) {
    const results = await Promise.allSettled(el.getAnimations({ subtree: true }).map(a => a.finished));
    if (results.every(r => r.status === "fulfilled")) return;
  }
  throw new Error("پویانمایی برگه آرام نگرفت");
});
const mainList = (page: Page) => page.getByRole("tablist", { name: "بخش‌ها", exact: true });
const tabLabels = (page: Page) => mainList(page).getByRole("tab", { includeHidden: true }).allInnerTexts();
const settingsLabels = (page: Page) => page.locator(".settings-nav").evaluate(el =>
  [...el.querySelectorAll('[role="tab"], option:not([disabled])')].map(n => n.textContent!.trim()));

test("DigiPay manual configuration is read-only without write permission and saves a valid account explicitly", async ({ page, api }) => {
  api.defaults["GET /digipay/config"] = { accountId: "", enabled: false,
    accounts: [{ id: "a1", name: "واسط دیجی‌پی", bankName: "بانک آزمون" }] };
  const auth = authorize(api, op => op === "settings.security" ? "deny" : "allow");
  await page.goto("/?page=settings&settings.tab=digipay");
  const section = page.getByRole("region", { name: "تنظیم دیجی‌پی", exact: true });
  await expect(section).toContainText("فقط مشاهده");
  await expect(section.getByRole("combobox")).toHaveCount(0);
  expect(api.calls.filter(c => c.startsWith("PUT /digipay"))).toHaveLength(0);
  auth.decide = () => "allow";
  let writes = 0;
  api.handlers.set("PUT /digipay/config", async route => {
    writes++; expect(route.request().postDataJSON()).toEqual({ accountId: "a1" });
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await section.getByRole("combobox").selectOption("a1");
  await section.getByRole("button", { name: "ذخیرهٔ تنظیم دیجی‌پی", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("تنظیم دیجی‌پی ذخیره شد.");
  expect(writes).toBe(1);
});

test.describe("F-110-01 — conservative permission loading", () => {
  test("while loading only unconditional destinations exist; the protected taxonomy never flashes", async ({ page, api }) => {
    const seen = await recordNavigation(page);
    // نقش صندوق‌دار: فروش و مرجوعی همان روز؛ بقیه رد.
    const allowed = new Set(["sale.create", "return.same_day"]);
    const auth = authorize(api, op => allowed.has(op) ? "allow" : "deny", true);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "امروز", exact: true })).toBeVisible();
    // در حال بررسی: فقط داشبورد و تنظیمات (شخصی) — به‌علاوهٔ جای‌نگهدارِ بی‌برچسب.
    expect((await tabLabels(page)).sort()).toEqual(["تنظیمات", "داشبورد"].sort());
    await expect(mainList(page).locator(".tab-pending")).toHaveCount(PROTECTED.length);
    expect(await mainList(page).locator(".tab-pending").evaluateAll(nodes => nodes.every(n => n.textContent === "" && n.getAttribute("aria-hidden") === "true"))).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "در حال بررسی دسترسی بخش‌ها…" }).first()).toBeAttached();
    auth.release();
    await expect(mainList(page).getByRole("tab", { name: "مرجوعی", includeHidden: true })).toHaveCount(1);
    await expect(mainList(page).locator(".tab-pending")).toHaveCount(0);
    expect(await tabLabels(page)).toEqual(["داشبورد", "صندوق", "فاکتورها", "مرجوعی", "تنظیمات"]);
    expect(await seen(), "no protected label was ever rendered before an allow verdict").toEqual(["تنظیمات", "داشبورد", "صندوق", "فاکتورها", "مرجوعی"].sort());
  });

  test("placeholders hold the navigation in place until every destination is allowed", async ({ page, api }) => {
    const auth = authorize(api, () => "allow", true);
    await page.goto("/");
    const dashboard = mainList(page).getByRole("tab", { name: "داشبورد", exact: true });
    await expect(dashboard).toBeVisible();
    const before = { tab: (await dashboard.boundingBox())!, nav: (await page.locator(".workspace-nav").boundingBox())! };
    auth.release();
    await expect(mainList(page).getByRole("tab", { includeHidden: true })).toHaveCount(10);
    const after = { tab: (await dashboard.boundingBox())!, nav: (await page.locator(".workspace-nav").boundingBox())! };
    // زیر ۳۶۰ پیکسل برچسب «کالا و قیمت» پس از رسیدن دو خط می‌شود و نوار بلندتر؛
    // جای‌نگهدار طول برچسب را نمی‌داند و نباید بداند (برچسب در DOM یعنی همان افشا).
    // پس آنجا فقط جای افقی سنجیده می‌شود.
    const wraps = compact(page) && page.viewportSize()!.width < 360;
    for (const k of wraps ? ["x", "width"] as const : ["x", "y", "width", "height"] as const) {
      expect(Math.abs(after.tab[k] - before.tab[k]), `dashboard tab ${k} stays put`).toBeLessThanOrEqual(1);
    }
    // نوار پایین همان چهار خانه را پیش و پس از پاسخ دارد؛ نوار کناری فقط سرعنوان گروه می‌گیرد.
    if (compact(page) && !wraps) expect(Math.abs(after.nav.height - before.nav.height), "bottom bar height stable").toBeLessThanOrEqual(1);
  });

  test("a failed check stays hidden and offers a calm retry that asks only what failed", async ({ page, api }) => {
    const seen = await recordNavigation(page);
    const auth = authorize(api, op => op === "treasury.manage" ? "fail" : "allow");
    await page.goto("/");
    await expect(mainList(page).getByRole("tab", { name: "گزارش‌ها", includeHidden: true })).toHaveCount(1);
    await expect(mainList(page).getByRole("tab", { name: "خزانه و چک", includeHidden: true }), "unknown is never allow").toHaveCount(0);
    await expect(mainList(page).locator(".tab-pending"), "a failure leaves no permanent placeholder").toHaveCount(0);
    expect(await seen(), "the unchecked destination was never rendered").not.toContain("خزانه و چک");
    let where = page.locator(".workspace-nav");
    if (compact(page)) {
      await expect(page.getByRole("button", { name: "بخش‌های بیشتر", exact: true })).toHaveAttribute("aria-description", "دسترسی بعضی بخش‌ها بررسی نشد");
      await page.getByRole("button", { name: "بخش‌های بیشتر", exact: true }).click();
      where = page.locator("#more-sheet");
      await expect(where.getByRole("link", { name: "خزانه و چک", exact: true })).toHaveCount(0);
    }
    await expect(where.getByRole("status").filter({ hasText: "بررسی نشد" })).toBeVisible();
    const before = api.calls.length;
    auth.decide = () => "allow";
    await where.getByRole("button", { name: "بررسی دوباره", exact: true }).click();
    const destination = compact(page) ? where.getByRole("link", { name: "خزانه و چک", exact: true }) : mainList(page).getByRole("tab", { name: "خزانه و چک", exact: true });
    await expect(destination).toBeVisible();
    await expect(where.getByRole("status").filter({ hasText: "بررسی نشد" })).toHaveCount(0);
    // فقط پرسش‌های ناوبری؛ داشبورد مجوز «بستن دوره» را جداگانه و مستقل از این قلاب می‌پرسد.
    const asked = api.calls.slice(before).filter(c => c.startsWith("GET /auth/can"))
      .map(c => new URLSearchParams(c.split("?")[1]).get("operation")!).filter(op => NAV_OPERATIONS.includes(op));
    expect(asked, "retry re-asks only the operation that failed").toEqual(["treasury.manage"]);
  });

  test("a deep link to a protected section while loading shows that section only, not the taxonomy", async ({ page, api }) => {
    const seen = await recordNavigation(page);
    const auth = authorize(api, () => "deny", true);
    await page.goto("/?page=treasury");
    const current = mainList(page).getByRole("tab", { name: "خزانه و چک", includeHidden: true });
    await expect(current).toHaveAttribute("aria-selected", "true");
    expect((await tabLabels(page)).sort()).toEqual(["تنظیمات", "خزانه و چک", "داشبورد"].sort());
    auth.release();
    await expect(mainList(page).locator(".tab-pending")).toHaveCount(0);
    // رد شد: بخش باز همچنان همان است (سرور دادهٔ پشتش را می‌سنجد)؛ بقیه هرگز ساخته نشدند.
    await expect(current).toHaveAttribute("aria-selected", "true");
    expect(await seen()).toEqual(["تنظیمات", "خزانه و چک", "داشبورد"].sort());
    await page.waitForLoadState("networkidle");
  });
});

test.describe("F-110-02 — personal settings apart from administrative settings", () => {
  test("cashier-style user sees only personal sections; admin deep links never mount", async ({ page, api }) => {
    authorize(api, () => "deny");
    await page.goto("/?page=settings");
    await expect(page.getByRole("heading", { name: "نمایش و عملکرد", exact: true })).toBeVisible();
    expect(await settingsLabels(page)).toEqual(PERSONAL);
    expect(api.calls.some(c => c.startsWith("GET /settings")), "administrative settings were not requested").toBe(false);
    for (const [tab, call] of [["staff", "GET /users"], ["withdrawal-log", "GET /withdrawals?"], ["devices", "GET /devices"], ["permissions", "GET /permission-rules"], ["keys", "GET /settings"], ["woocommerce", "GET /settings/woocommerce"], ["digipay", "GET /digipay/config"]] as const) {
      await page.goto(`/?page=settings&settings.tab=${tab}`);
      await expect(page.getByRole("heading", { name: "دسترسی ندارید" })).toBeVisible();
      expect(await settingsLabels(page), `${tab} label stays hidden`).toEqual(PERSONAL);
      expect(api.calls.some(c => c.startsWith(call)), `${tab} screen never mounted`).toBe(false);
    }
    await page.goto("/?page=settings&settings.tab=pin");
    await expect(page.getByRole("heading", { name: "ساخت و تغییر PIN من" })).toBeVisible();
  });

  test("full administrator sees every section and lands on the settings keys", async ({ page, api }) => {
    await page.goto("/?page=settings");
    await expect(page.getByRole("heading", { name: "تنظیمات", level: 1 })).toBeVisible();
    await expect.poll(() => settingsLabels(page)).toEqual([...PERSONAL, ...ADMIN]);
    expect(api.calls.some(c => c.startsWith("GET /settings"))).toBe(true);
    const picker = page.getByRole("combobox", { name: "بخش تنظیمات" });
    if (await picker.isVisible()) await picker.selectOption("staff");
    else await page.getByRole("tab", { name: "پرسنل", exact: true }).click();
    await expect(page.getByRole("heading", { name: "پرسنل", exact: true })).toBeVisible();
    await expect.poll(() => api.calls.some(c => c.startsWith("GET /users"))).toBe(true);
  });

  test("partial administrative permission shows exactly the sections that permission reads", async ({ page, api }) => {
    authorize(api, op => op === "settings.view" ? "allow" : "deny");
    await page.goto("/?page=settings");
    await expect(page.getByRole("heading", { name: "تنظیمات", level: 1 })).toBeVisible();
    await expect.poll(() => settingsLabels(page)).toEqual([...PERSONAL, "تنظیمات", "سلامت سیستم", "اتصال ووکامرس", "کدینگ حساب", "نگاشت حساب", "اسنپ‌پی", "دیجی‌پی", "پایانه‌ها", "افتتاحیه و تفصیلی"]);
    await page.goto("/?page=settings&settings.tab=devices");
    await expect(page.getByRole("heading", { name: "دسترسی ندارید" })).toBeVisible();
    expect(api.calls.some(c => c.startsWith("GET /devices") || c.startsWith("GET /sessions"))).toBe(false);
  });

  test("a deep link waits for the check, then mounts only on allow; a failed check offers retry", async ({ page, api }) => {
    const auth = authorize(api, op => op === "user.manage" ? "fail" : "deny", true);
    await page.goto("/?page=settings&settings.tab=staff");
    await expect(page.getByRole("status").filter({ hasText: "در حال بررسی دسترسی…" })).toBeVisible();
    expect(await settingsLabels(page), "personal sections do not wait").toEqual(PERSONAL);
    await expect(page.locator(".settings-nav .tab-pending")).toHaveCount(page.viewportSize()!.width < 768 ? 0 : ADMIN.length);
    expect(api.calls.some(c => c.startsWith("GET /users"))).toBe(false);
    auth.release();
    await expect(page.getByRole("heading", { name: "دسترسی این بخش بررسی نشد" })).toBeVisible();
    expect(await settingsLabels(page)).toEqual(PERSONAL);
    expect(api.calls.some(c => c.startsWith("GET /users"))).toBe(false);
    auth.decide = op => op === "user.manage" ? "allow" : "deny";
    await page.locator("main").getByRole("button", { name: "بررسی دوباره", exact: true }).click();
    await expect(page.getByRole("heading", { name: "پرسنل", exact: true })).toBeVisible();
    expect(await settingsLabels(page)).toEqual([...PERSONAL, "پرسنل"]);
    await expect.poll(() => api.calls.some(c => c.startsWith("GET /users"))).toBe(true);
  });
});

test.describe("F-110-04 — the More sheet is a real modal", () => {
  test.beforeEach(async ({ page }) => {
    // برگه فقط زیر ۹۰۰ پیکسل است؛ پروژهٔ دسکتاپ همین را در نمایشگر گوشی می‌سنجد، نه Skip.
    if (!compact(page)) await page.setViewportSize({ width: 390, height: 844 });
  });

  test("focus enters, stays inside, and every close path returns it to the More button", async ({ page }) => {
    await page.goto("/");
    await expect(mainList(page).getByRole("tab", { name: "کالا و قیمت", exact: true })).toBeVisible();
    const more = page.getByRole("button", { name: "بخش‌های بیشتر", exact: true });
    const sheet = page.getByRole("dialog", { name: "همهٔ بخش‌ها" });
    await expect(more).toHaveAttribute("aria-haspopup", "dialog");
    await more.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(await sheet.evaluate(el => el.matches(":modal")), "opened with showModal").toBe(true);
    // ورود پیش‌بینی‌پذیر: بخش باز.
    await expect(sheet.getByRole("link", { name: "داشبورد", exact: true })).toBeFocused();
    const order = await sheet.evaluate(el => [...el.querySelectorAll<HTMLElement>("a[href], button")].map(n => n.textContent!.trim()));
    // Tab و Shift+Tab داخل برگه می‌چرخند، در همان ترتیب، در هر موتور.
    for (let i = 1; i <= order.length; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(order[i % order.length]);
    }
    await expect(sheet.getByRole("link", { name: "داشبورد", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: "بستن بخش‌های بیشتر" }), "Shift+Tab wraps to the last control").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(sheet.getByRole("link", { name: "داشبورد", exact: true })).toBeFocused();
    // پشت برگه inert است: نه فوکوس می‌گیرد، نه کلیک به آن می‌رسد.
    expect(await page.evaluate(() => {
      for (const selector of ["#workspace-content", '.workspace-header input[type="search"]', '.workspace-zones [role="tab"]']) document.querySelector<HTMLElement>(selector)?.focus();
      return document.activeElement?.closest("#more-sheet") !== null;
    }), "background cannot take focus").toBe(true);
    expect(await page.evaluate(() => document.elementFromPoint(20, 20)?.closest("#more-sheet, .workspace-header")?.id), "backdrop covers the page").toBe("more-sheet");
    // مسیر ۱: Esc
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // مسیر ۲: پس‌زمینه — این بار از کیبورد باز شده.
    await more.press("Enter");
    await expect(sheet).toBeVisible();
    await page.mouse.click(page.viewportSize()!.width / 2, 8);
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    // مسیر ۳: دکمهٔ «بستن»
    await more.click();
    await sheet.getByRole("button", { name: "بستن بخش‌های بیشتر" }).click();
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    // انتخاب مقصد «رفتن» است نه «بستن»: فوکوس به محتوای بخش تازه.
    await more.click();
    await sheet.getByRole("link", { name: "خزانه و چک", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("tablist", { name: "بخش‌های خزانه", exact: true })).toBeVisible();
    await expect(page.locator("main#workspace-content")).toBeFocused();
    await expect(more).toHaveAttribute("data-current", "");
    await page.waitForLoadState("networkidle");
  });

  test("a short phone scrolls inside the sheet and keeps it within the safe area", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 460 });
    await page.goto("/");
    await expect(mainList(page).getByRole("tab", { name: "کالا و قیمت", exact: true })).toBeVisible();
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.getByRole("button", { name: "بخش‌های بیشتر", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "همهٔ بخش‌ها" });
    await expect(sheet).toBeVisible();
    await settled(sheet);
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(460 + 1);
    expect(await sheet.evaluate(el => el.scrollHeight > el.clientHeight), "content longer than the sheet").toBe(true);
    await sheet.getByRole("button", { name: "بستن بخش‌های بیشتر" }).focus();
    await expect(sheet.getByRole("button", { name: "بستن بخش‌های بیشتر" })).toBeInViewport();
    expect(await sheet.evaluate(el => el.scrollTop), "the sheet scrolled, not the page").toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
