/**
 * گسترش نظام طراحی، دستهٔ ۱ — گزارش‌ها، تنظیمات، کارهای پرتکرار داشبورد.
 *
 * رفتار واقعی، نه تصویر: فیلتر در نشانی، نگه‌داشتن بازهٔ نامعتبر، حالت‌های
 * بی‌مجوز/خطا/خالی، «—» برای null، جدول پشته‌ای بی سرریز، فرم تنظیمات
 * (اعتبارسنجی، ذخیرهٔ تک‌ردیفی، ذخیره‌نشده، بازگردانی، دلیل اجباری)، و
 * کارهای داشبورد در allow/deny/loading/degraded. هیچ `sleep`؛ «در حال
 * بررسی» با نگه‌داشتن صریح پاسخ ساخته می‌شود.
 */
import { test, expect, fontsReady, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";
import { REPORT_DATA } from "./report-data";

const noPageOverflow = async (page: Page, what: string) => {
  await fontsReady(page);
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll, `${what}: page must not scroll horizontally`).toBeLessThanOrEqual(size.client);
};
const reportCalls = (api: MockApi, path: string) => api.calls.filter(c => c.startsWith(`GET ${path}`));

test.describe("گزارش‌ها", () => {
  test.beforeEach(({ api }) => { Object.assign(api.defaults, REPORT_DATA); });

  test("filters live in the URL, show the Jalali range, reset, and a malformed range is never sent", async ({ page, api }) => {
    await page.goto("/?page=reports&reports.tab=sales");
    await expect(page.getByRole("heading", { name: "گزارش‌ها", level: 1 })).toBeVisible();
    const filters = page.getByRole("region", { name: "فیلتر گزارش" });
    // پیش‌فرض از تاریخ کاری سرور (۲۰۲۶-۰۹-۱۶ در داده‌ی ساختگی)، نه ساعت مرورگر.
    await expect(filters).toContainText("۱۰ شهریور ۱۴۰۵ تا ۲۵ شهریور ۱۴۰۵");
    await expect(filters.getByRole("button", { name: "بازنشانی فیلترها" })).toHaveCount(0);
    // پرس‌وجو پس از mount در یک setTimeout(0) فرستاده می‌شود (use-latest-query)؛ پس poll، نه خواندن هم‌زمان.
    await expect.poll(() => reportCalls(api, "/reports/sales")[0]).toContain("from=2026-09-01&to=2026-09-16");

    const from = page.getByLabel("از تاریخ (میلادی)", { exact: true });
    await from.fill("2026-09-1");
    await expect(filters.getByText("تاریخ را به شکل ۲۰۲۶-۰۹-۰۱ کامل کنید.")).toBeVisible();
    await expect(from).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("بازهٔ تاریخ کامل نیست.")).toBeVisible();
    expect(reportCalls(api, "/reports/sales").some(c => c.includes("from=2026-09-1&")), "half-typed date never reaches the server").toBe(false);

    await from.fill("۲۰۲۶-۰۹-۱۰");
    await expect(page).toHaveURL(/reports\.from=2026-09-10/);
    await expect(filters).toContainText("۱۹ شهریور ۱۴۰۵ تا ۲۵ شهریور ۱۴۰۵");
    await expect.poll(() => reportCalls(api, "/reports/sales").some(c => c.includes("from=2026-09-10&to=2026-09-16"))).toBe(true);

    await page.reload();
    await expect(page.getByLabel("از تاریخ (میلادی)", { exact: true })).toHaveValue("2026-09-10");
    await page.getByRole("button", { name: "بازنشانی فیلترها" }).click();
    await expect(page).not.toHaveURL(/reports\.from/);
    await expect(page.getByLabel("از تاریخ (میلادی)", { exact: true })).toHaveValue("2026-09-01");
  });

  test("sales table: financial alignment, totals, CSV with the same filters, and no page overflow", async ({ page }) => {
    await page.goto("/?page=reports&reports.tab=sales");
    const table = page.getByRole("table", { name: "فروش به تفکیک روز و کانال" });
    await expect(table).toBeVisible();
    // هیچ ستونی برای زیبایی موبایل حذف نمی‌شود.
    for (const h of ["تاریخ", "کانال", "فاکتور", "ناخالص", "تخفیف", "خالص", "مرجوعی", "بهای تمام‌شده", "سود"])
      await expect(table.getByRole("columnheader", { name: h, exact: true })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "جمع بازه" })).toContainText("8,740,000".replace(/,/g, "٬"));
    const csv = page.getByRole("link", { name: "دانلود CSV" });
    await expect(csv).toHaveAttribute("href", "/api/reports/sales?from=2026-09-01&to=2026-09-16&format=csv");
    // عدد مالی: رقم لاتین مونو، هم‌تراز انتها.
    const net = table.getByRole("cell").filter({ hasText: "4٬700٬000" }).first();
    await expect(net).toHaveCSS("text-align", "end");
    await expect(net.locator(".money-digits")).toHaveCSS("font-variant-numeric", "tabular-nums");
    await noPageOverflow(page, "sales report");
  });

  test("unknown cost is «—» with a spoken reason, never zero; totals stay unknown", async ({ page, api }) => {
    api.defaults["GET /reports/sales"] = { rows: (REPORT_DATA["GET /reports/sales"] as { rows: Record<string, unknown>[] }).rows.map(r => ({ ...r, cogsAmount: null, profitAmount: null })) };
    await page.goto("/?page=reports&reports.tab=sales");
    const table = page.getByRole("table", { name: "فروش به تفکیک روز و کانال" });
    await expect(table.locator(".money--unknown").first()).toBeVisible();
    await expect(table.locator(".money--unknown").first()).toContainText("نامعلوم یا بدون دسترسی");
    const total = table.getByRole("row").filter({ hasText: "جمع بازه" });
    await expect(total.locator(".money--unknown")).toHaveCount(1);
  });

  test("403 is a permission state without retry; 5xx is an error with reference and a read-only retry", async ({ page, api }) => {
    api.handlers.set("GET /reports/compare", async r => { await r.fulfill({ status: 403, json: { error: { code: "forbidden", message: "این گزارش دسترسی بینش مشتری می‌خواهد." } } }); });
    let fail = true;
    api.handlers.set("GET /reports/hourly", async r => {
      if (fail) await r.fulfill({ status: 500, headers: { "x-correlation-id": "req-7f3a" }, json: { error: { code: "internal", message: "خطای سرور؛ دوباره تلاش کنید." } } });
      else await r.fulfill({ json: REPORT_DATA["GET /reports/hourly"] });
    });
    await page.goto("/?page=reports&reports.tab=manager");
    const compare = page.getByRole("region", { name: "فروش خالص در برابر دورهٔ مبنا" });
    await expect(compare.getByRole("status")).toContainText("این گزارش دسترسی بینش مشتری می‌خواهد.");
    await expect(compare.getByRole("button", { name: "تلاش دوباره" })).toHaveCount(0);
    const hourly = page.getByRole("region", { name: "فروش به تفکیک ساعت" }).first();
    await expect(hourly.getByRole("alert")).toContainText("خطای سرور");
    await expect(hourly.getByRole("link", { name: "دانلود CSV" }), "no CSV for a failed report").toHaveCount(0);
    fail = false;
    await hourly.getByRole("button", { name: "تلاش دوباره" }).click();
    await expect(hourly.getByRole("figure")).toBeVisible();
  });

  test("hourly chart sums real rows per hour in bigint, earlier hours first in reading order", async ({ page }) => {
    await page.goto("/?page=reports&reports.tab=manager");
    const chart = page.getByRole("figure", { name: /فروش خالص هر ساعت/ });
    await expect(chart).toBeVisible();
    // چهار ساعت متمایز در داده: ۱۰، ۱۲، ۱۸ (صندوق + سایت)، ۲۰.
    const rows = chart.locator("table.sr-only tbody tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("۱۰");
    await expect(rows.nth(2)).toContainText("2٬430٬000 تومان");
    await expect(chart).toContainText("بیشترین فروش: ساعت ۱۸");
    // RTL: ستون زودتر سمت راست.
    const cols = chart.locator(".bar-chart-col");
    const first = await cols.first().boundingBox(), last = await cols.last().boundingBox();
    expect(first!.x).toBeGreaterThan(last!.x);
  });

  test("empty report says so and offers no download", async ({ page, api }) => {
    api.defaults["GET /reports/trial-balance"] = { rows: [] };
    await page.goto("/?page=reports&reports.tab=trial");
    await expect(page.getByText("در این بازه سندی ثبت نشده است.")).toBeVisible();
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveCount(0);
  });

  test("trial balance states balance in text; cash variance is labelled, not colour-only", async ({ page }) => {
    await page.goto("/?page=reports&reports.tab=trial");
    await expect(page.getByRole("row").filter({ hasText: "جمع" }).getByText("متوازن")).toBeVisible();
    await page.goto("/?page=reports&reports.tab=cash");
    const table = page.getByRole("table", { name: "شمارش کشو در برابر انتظار" });
    await expect(table.getByText("شیفت باز")).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: "مغایرت" }).last()).toContainText("−5٬000");
    await noPageOverflow(page, "cash report");
  });

  test("report-specific filters persist in the URL (party type, account, warehouse)", async ({ page, api }) => {
    api.defaults["GET /reports/party-balances"] = { rows: [] };
    api.defaults["GET /reports/inventory-valuation"] = { rows: [] };
    api.defaults["GET /reports/account-ledger"] = { rows: [] };
    await page.goto("/?page=reports&reports.tab=parties");
    await page.getByLabel("نوع شخص", { exact: true }).selectOption("supplier");
    await expect(page).toHaveURL(/reports\.partyType=supplier/);
    await expect.poll(() => api.calls.some(c => c === "GET /reports/party-balances?partyType=supplier")).toBe(true);
    await page.goto("/?page=reports&reports.tab=ledger");
    await expect(page.getByText("کد حساب را وارد کنید تا گردش آن در این بازه نمایش داده شود.")).toBeVisible();
    expect(reportCalls(api, "/reports/account-ledger"), "no code, no query").toHaveLength(0);
    await page.getByLabel("کد حساب", { exact: true }).fill("۱۳۰۱");
    await page.getByRole("button", { name: "نمایش", exact: true }).click();
    await expect(page).toHaveURL(/reports\.account=1301/);
    await expect(page.getByText("این حساب در این بازه گردشی نداشته است.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("کد حساب", { exact: true })).toHaveValue("1301");
  });
});

test.describe("تنظیمات", () => {
  const setting = (over: Record<string, unknown>) => ({
    key: "return.window_hours", value: 48, kind: "int", label: "مهلت مرجوعی", description: "", help: "به ساعت، نه روز.", unit: "ساعت",
    min: 1, max: 720, options: null, requiresApproval: false, isEditable: true, canEdit: true, permission: "settings.edit", updatedAt: "2026-09-01T00:00:00Z", updatedBy: null, ...over,
  });
  test.beforeEach(({ api }) => {
    api.defaults["GET /settings"] = { groups: [
      { key: "sales", title: "فروش و مرجوعی", subtitle: null, settings: [
        setting({}),
        setting({ key: "discount.require_reason_above_percent", label: "سقف تخفیف بی‌دلیل", kind: "percent", value: 10, min: 0, max: 100, unit: "٪", requiresApproval: true, help: null }),
        setting({ key: "sales.auto_close_channel_day", label: "بستن خودکار دوره کانال", kind: "bool", value: true, unit: null, help: null }),
      ] },
      { key: "security", title: "امنیت", subtitle: "فقط مدیر", settings: [
        setting({ key: "auth.pin_forbidden_operations", label: "عملیات ممنوع با PIN", kind: "text", value: "refund.cash", canEdit: false, unit: null, help: null }),
      ] },
    ] };
  });

  test("keys form: inline validation, per-row save, unsaved state, revert, and required reason", async ({ page, api }) => {
    const bodies: Array<{ key: string; body: unknown }> = [];
    api.handlers.set("PATCH /settings/return.window_hours", async r => { bodies.push({ key: "return.window_hours", body: r.request().postDataJSON() }); await r.fulfill({ json: { value: 72, updatedAt: "2026-09-29T00:00:00Z" } }); });
    api.handlers.set("PATCH /settings/discount.require_reason_above_percent", async r => { bodies.push({ key: "discount", body: r.request().postDataJSON() }); await r.fulfill({ json: { value: 15, updatedAt: "2026-09-29T00:00:00Z" } }); });
    await page.goto("/?page=settings&settings.tab=keys");
    await expect(page.getByRole("heading", { name: "تنظیمات", level: 1 })).toBeVisible();
    const hours = page.getByLabel("مهلت مرجوعی", { exact: true });
    const row = page.locator('[data-setting="return.window_hours"]');
    const save = row.getByRole("button", { name: /^ذخیره/ });
    await expect(save).toBeDisabled();

    await hours.fill("۹۰۰"); await hours.blur();
    await expect(row.getByRole("alert")).toHaveText("نمی‌تواند بیشتر از 720 باشد");
    await expect(hours).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    expect(api.calls.some(c => c.startsWith("PATCH")), "invalid value is not sent").toBe(false);

    await hours.fill("۷۲");
    await expect(row.getByText("ذخیره‌نشده")).toBeVisible();
    await expect(page.getByRole("banner").or(page.locator(".page-header")).getByText("۱ تغییر ذخیره‌نشده")).toBeVisible();
    // بستن و بازکردن گروه پیش‌نویس را نگه می‌دارد.
    const head = page.getByRole("button", { name: /فروش و مرجوعی/ });
    await head.click(); await expect(head).toHaveAttribute("aria-expanded", "false");
    await head.click(); await expect(hours).toHaveValue("۷۲");
    await row.getByRole("button", { name: "بازگردانی" }).click();
    await expect(hours).toHaveValue("48");
    await expect(row.getByText("ذخیره‌نشده")).toHaveCount(0);

    await hours.fill("72");
    await save.click();
    await expect(row.getByRole("status")).toContainText("ذخیره شد");
    await expect(row).toContainText("مقدار فعلی: 72 ساعت");
    expect(bodies).toEqual([{ key: "return.window_hours", body: { value: 72 } }]);

    const pct = page.getByLabel("سقف تخفیف بی‌دلیل", { exact: true });
    const pctRow = page.locator('[data-setting="discount.require_reason_above_percent"]');
    await pct.fill("15");
    await pctRow.getByRole("button", { name: /^ذخیره/ }).click();
    await expect(pctRow.getByRole("alert")).toHaveText("برای این تنظیم، نوشتن دلیل اجباری است");
    await pctRow.getByLabel("دلیل تغییر — اجباری، در سابقه ثبت می‌شود").fill("مصوبهٔ مالک");
    await pctRow.getByRole("button", { name: /^ذخیره/ }).click();
    await expect(pctRow.getByRole("status")).toContainText("ذخیره شد");
    expect(bodies[1]).toEqual({ key: "discount", body: { value: 15, reason: "مصوبهٔ مالک" } });
  });

  test("a switch states its value in text; a read-only setting has no save and says why", async ({ page }) => {
    await page.goto("/?page=settings&settings.tab=keys");
    const sw = page.getByRole("switch", { name: /بستن خودکار دوره کانال/ });
    await expect(sw).toBeChecked();
    await expect(page.locator('[data-setting="sales.auto_close_channel_day"]')).toContainText("فعال");
    await page.getByRole("button", { name: /امنیت/ }).click();
    const locked = page.locator('[data-setting="auth.pin_forbidden_operations"]');
    await expect(locked).toContainText("دسترسی ندارید");
    await expect(locked.getByRole("button", { name: /^ذخیره/ })).toHaveCount(0);
    await expect(page.getByLabel("عملیات ممنوع با PIN", { exact: true })).toBeDisabled();
    await noPageOverflow(page, "settings keys");
  });

  test("keys load failure shows the server message with a reference and a read-only retry", async ({ page, api }) => {
    let fail = true;
    api.handlers.set("GET /settings", async r => {
      if (fail) await r.fulfill({ status: 500, headers: { "x-correlation-id": "req-set-1" }, json: { error: { code: "internal", message: "تنظیمات خوانده نشد." } } });
      else await r.fulfill({ json: { groups: [] } });
    });
    await page.goto("/?page=settings&settings.tab=keys");
    await expect(page.getByRole("alert")).toContainText("تنظیمات خوانده نشد.");
    fail = false;
    await page.getByRole("button", { name: "تلاش دوباره" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("personal PIN validates length and repeat inline before any request", async ({ page, api }) => {
    await page.goto("/?page=settings&settings.tab=pin");
    await page.getByLabel("PIN جدید", { exact: true }).fill("12");
    await expect(page.getByText("PIN باید دقیقاً ۴ رقم باشد.")).toBeVisible();
    await page.getByLabel("PIN جدید", { exact: true }).fill("1234");
    await page.getByLabel("تکرار PIN جدید", { exact: true }).fill("1235");
    await expect(page.getByText("تکرار با PIN جدید یکی نیست.")).toBeVisible();
    await expect(page.getByRole("button", { name: "ساخت PIN" })).toBeDisabled();
    expect(api.calls.some(c => c.startsWith("POST /auth/pin"))).toBe(false);
  });
});

test.describe("کارهای پرتکرار داشبورد", () => {
  const ACTIONS = ["فروش جدید", "رسیدگی به پیش‌نویس‌ها", "چاپ لیبل بارکد", "فاکتورها و چاپ رسید"];
  const quick = (page: Page) => page.getByRole("navigation", { name: "کارهای پرتکرار" });

  test("allowed: every action; low privilege: only what the role can open", async ({ page, api }) => {
    await page.goto("/");
    await expect(quick(page).getByRole("link")).toHaveText(ACTIONS);
    const allowed = new Set(["sale.create", "return.same_day"]);
    api.handlers.set("GET /auth/can", async (route, url) => { await route.fulfill({ json: { verdict: allowed.has(url.searchParams.get("operation") ?? "") ? "allow" : "deny", approver: null, reason: "" } }); });
    await page.reload();
    await expect(quick(page).getByRole("link")).toHaveText(["فروش جدید", "رسیدگی به پیش‌نویس‌ها", "فاکتورها و چاپ رسید"]);
    await expect(page.getByText("چاپ لیبل بارکد", { exact: true })).toHaveCount(0);
  });

  test("no permission at all: no quick-action row", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async route => { await route.fulfill({ json: { verdict: "deny", approver: null, reason: "" } }); });
    await page.goto("/");
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    await expect(quick(page)).toHaveCount(0);
  });

  test("loading never renders a privileged label; degraded hides it and retries only what failed", async ({ page, api }) => {
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __quickSeen: Set<string> }).__quickSeen = seen;
      new MutationObserver(() => { for (const a of document.querySelectorAll(".quick-actions a")) seen.add(a.textContent?.trim() ?? ""); })
        .observe(document, { subtree: true, childList: true, characterData: true });
    });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let failCatalog = true;
    api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      if (op !== "period.close") await gate;
      if (op === "catalog.manage" && failCatalog) { await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "سرور در دسترس نیست" } } }); return; }
      await route.fulfill({ json: { verdict: "allow", approver: null, reason: "" } });
    });
    await page.goto("/");
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    await expect(quick(page).locator(".quick-action--pending")).toHaveCount(4);
    await expect(quick(page).getByRole("link")).toHaveCount(0);
    release();
    await expect(quick(page).getByRole("link")).toHaveText(["فروش جدید", "رسیدگی به پیش‌نویس‌ها", "فاکتورها و چاپ رسید"]);
    await expect(quick(page).locator(".quick-action--pending"), "no permanent placeholder after failure").toHaveCount(0);
    const note = quick(page).getByRole("status");
    await expect(note).toContainText("دسترسی بعضی کارها بررسی نشد.");
    const seen = await page.evaluate(() => [...(window as unknown as { __quickSeen: Set<string> }).__quickSeen]);
    expect(seen, "the unchecked action was never rendered").not.toContain("چاپ لیبل بارکد");
    failCatalog = false;
    await quick(page).getByRole("button", { name: "بررسی دوباره" }).click();
    await expect(quick(page).getByRole("link")).toHaveText(ACTIONS);
    await expect(note).toHaveCount(0);
  });
});

/**
 * بازبینی مستقل دستهٔ ۱ (Astra، B1-01…B1-05). پرسش «دور ریخته شود؟» یک
 * `confirm` بومی است؛ هر پرسش شمرده می‌شود تا «پرسشی نیامد» هم ادعا باشد، نه
 * حدس. هیچ `sleep`: هر انتظار روی وضعیت واقعی صفحه یا درخواست واقعی است.
 */
test.describe("بازبینی دستهٔ ۱ — پیش‌نویس، اسنپ‌پی، موجودی", () => {
  const LEAVE = "تغییرات ذخیره‌نشدهٔ تنظیمات دور ریخته شود؟ برای ماندن و ذخیره، «لغو» را بزنید.";
  const zoneTab = (page: Page, name: string) => page.getByRole("tablist", { name: "بخش‌ها", exact: true }).getByRole("tab", { name, exact: true });
  /** ناحیه از نوار اصلی، یا در عرض کم از برگهٔ «بیشتر» — همان مسیری که کاربر می‌رود. */
  async function openZone(page: Page, name: string) {
    const tab = zoneTab(page, name);
    if (await tab.isVisible()) { await tab.click(); return; }
    await page.getByRole("button", { name: "بخش‌های بیشتر" }).click();
    await page.getByRole("dialog").getByRole("link", { name, exact: true }).click();
  }
  /** پاسخ به پرسش ترک صفحه: «لغو» یا «تأیید»، و فهرست همهٔ پرسش‌ها. */
  function prompts(page: Page) {
    const seen: string[] = [];
    let answer: "dismiss" | "accept" = "dismiss";
    page.on("dialog", d => { seen.push(`${d.type()}: ${d.message()}`); void (answer === "accept" ? d.accept() : d.dismiss()); });
    return { seen, answer: (next: "dismiss" | "accept") => { answer = next; } };
  }
  /** آیا `beforeunload` هنوز جلوی ترک را می‌گیرد؟ همان رویدادی که مرورگر پیش از بارگذاری دوباره می‌فرستد. */
  const unloadBlocked = (page: Page) => page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  const setting = (over: Record<string, unknown>) => ({
    key: "return.window_hours", value: 48, kind: "int", label: "مهلت مرجوعی", description: "", help: "به ساعت، نه روز.", unit: "ساعت",
    min: 1, max: 720, options: null, requiresApproval: false, isEditable: true, canEdit: true, permission: "settings.edit", updatedAt: "2026-09-01T00:00:00Z", updatedBy: null, ...over,
  });
  test.beforeEach(({ api }) => {
    api.defaults["GET /settings"] = { groups: [
      { key: "sales", title: "فروش و مرجوعی", subtitle: null, settings: [
        setting({}),
        setting({ key: "discount.require_reason_above_percent", label: "سقف تخفیف بی‌دلیل", kind: "percent", value: 10, min: 0, max: 100, unit: "٪", requiresApproval: true, help: null }),
        setting({ key: "sales.auto_close_channel_day", label: "بستن خودکار دوره کانال", kind: "bool", value: true, unit: null, help: "دوره‌ی دیروز را شبانه می‌بندد، هرگز امروز را." }),
      ] },
    ] };
    api.defaults["GET /settlement-terms"] = { terms: [{ id: "t1", name: "کارت‌خوان فروشگاه", code: "POS1", feePercent: "0.5", settlementDays: 1, canEdit: true }] };
    api.defaults["GET /snappay/config"] = { accountId: "a1", enabled: true, accounts: [{ id: "a1", name: "واسط اسنپ‌پی", bankName: "بانک آزمون" }] };
  });

  test("B1-01 unsaved draft: every in-app exit asks first; cancel keeps value, reason and state; confirm leaves and leaves no guard behind", async ({ page, api }) => {
    const dialog = prompts(page);
    // ورود به تنظیمات از داخل برنامه، تا «بازگشت» مرورگر یک جابه‌جایی همان سند باشد.
    await page.goto("/");
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    await openZone(page, "تنظیمات");
    const hours = page.getByLabel("مهلت مرجوعی", { exact: true });
    await expect(hours).toHaveValue("48");
    // بارگذاری اولیه پیش‌نویس نیست: ترک صفحه هیچ پرسشی ندارد.
    await expect.poll(() => unloadBlocked(page), "hydration is not a draft").toBe(false);

    await hours.fill("72");
    const pctRow = page.locator('[data-setting="discount.require_reason_above_percent"]');
    await page.getByLabel("سقف تخفیف بی‌دلیل", { exact: true }).fill("15");
    const reason = pctRow.getByLabel("دلیل تغییر — اجباری، در سابقه ثبت می‌شود");
    await reason.fill("مصوبهٔ مالک");
    const pending = page.locator(".page-header").getByText("۲ تغییر ذخیره‌نشده");
    await expect(pending).toBeVisible();
    await expect.poll(() => unloadBlocked(page), "reload/close stays protected").toBe(true);

    const kept = async (what: string) => {
      await expect(page, what).toHaveURL(/page=settings/);
      await expect(hours, what).toHaveValue("72");
      await expect(reason, what).toHaveValue("مصوبهٔ مالک");
      await expect(pending, what).toBeVisible();
    };
    // ۱) بخش دیگر تنظیمات (از داخل صفحه، مستقل از چیدمان ناوبری).
    await page.getByRole("button", { name: /کارمزد و دوره تسویه/ }).click();
    await page.getByRole("button", { name: "تغییر در زبانه پایانه‌ها" }).click();
    await expect.poll(() => dialog.seen.length).toBe(1);
    await kept("settings section change cancelled");
    // ۲) ناحیهٔ دیگر برنامه.
    await zoneTab(page, "داشبورد").click();
    await expect.poll(() => dialog.seen.length).toBe(2);
    await kept("zone change cancelled");
    // ۳) بازگشت مرورگر (همان سند؛ popstate).
    await page.evaluate(() => { history.back(); });
    await expect.poll(() => dialog.seen.length).toBe(3);
    await kept("history back cancelled");
    expect(dialog.seen).toEqual([`confirm: ${LEAVE}`, `confirm: ${LEAVE}`, `confirm: ${LEAVE}`]);
    expect(api.calls.some(c => c.startsWith("PATCH")), "nothing was saved behind the user's back").toBe(false);

    // تأیید: جابه‌جایی انجام می‌شود و پیش‌نویس عمداً دور ریخته می‌شود.
    dialog.answer("accept");
    await zoneTab(page, "داشبورد").click();
    await expect.poll(() => dialog.seen.length).toBe(4);
    await expect(page).not.toHaveURL(/page=settings/);
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    // هیچ نگهبان یا شنونده‌ای پس از Unmount نمی‌ماند.
    await expect.poll(() => unloadBlocked(page), "no stale beforeunload listener").toBe(false);
    await openZone(page, "تنظیمات");
    await expect(page.getByLabel("مهلت مرجوعی", { exact: true })).toHaveValue("48");
    await zoneTab(page, "داشبورد").click();
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    expect(dialog.seen, "no prompt after the draft was discarded").toHaveLength(4);
  });

  test("B1-01 save clears the guard; a failed save keeps it; revert clears that row", async ({ page, api }) => {
    const dialog = prompts(page);
    let fail = true;
    api.handlers.set("PATCH /settings/return.window_hours", async r => {
      if (fail) await r.fulfill({ status: 409, json: { error: { code: "rule_violation", message: "مقدار با قاعدهٔ دیتابیس سازگار نیست." } } });
      else await r.fulfill({ json: { value: 72, updatedAt: "2026-09-30T00:00:00Z" } });
    });
    await page.goto("/?page=settings&settings.tab=keys");
    const hours = page.getByLabel("مهلت مرجوعی", { exact: true });
    const row = page.locator('[data-setting="return.window_hours"]');
    await hours.fill("72");
    await row.getByRole("button", { name: /^ذخیره/ }).click();
    await expect(row.getByRole("alert")).toHaveText("مقدار با قاعدهٔ دیتابیس سازگار نیست.");
    await expect.poll(() => unloadBlocked(page), "failed save keeps the draft protected").toBe(true);
    await zoneTab(page, "داشبورد").click();
    await expect.poll(() => dialog.seen.length).toBe(1);
    await expect(hours).toHaveValue("72");

    fail = false;
    await row.getByRole("button", { name: /^ذخیره/ }).click();
    await expect(row.getByRole("status")).toContainText("ذخیره شد");
    await expect.poll(() => unloadBlocked(page), "saved: nothing left to protect").toBe(false);

    // بازگردانی: همان ردیف دیگر پیش‌نویس نیست.
    const sw = page.getByRole("switch", { name: "بستن خودکار دوره کانال" });
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).not.toBeChecked();
    await expect.poll(() => unloadBlocked(page)).toBe(true);
    await page.locator('[data-setting="sales.auto_close_channel_day"]').getByRole("button", { name: "بازگردانی" }).click();
    await expect(sw).toBeChecked();
    await expect.poll(() => unloadBlocked(page), "revert clears the row's draft").toBe(false);

    await zoneTab(page, "داشبورد").click();
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    expect(dialog.seen, "only the failed-save exit asked").toHaveLength(1);
  });

  test("B1-05 boolean help is a description of the switch, not part of its name", async ({ page }) => {
    await page.goto("/?page=settings&settings.tab=keys");
    const sw = page.getByRole("switch", { name: "بستن خودکار دوره کانال", exact: true });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAccessibleName("بستن خودکار دوره کانال");
    await expect(sw).toHaveAccessibleDescription("دوره‌ی دیروز را شبانه می‌بندد، هرگز امروز را.");
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).not.toBeChecked();
    await expect(page.locator('[data-setting="sales.auto_close_channel_day"]')).toContainText("غیرفعال");
  });

  test("B1-02 settings.view only: SnapPay is readable, has no editable control and never sends PUT", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "settings.security" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=settings&settings.tab=snappay");
    const section = page.getByRole("region", { name: "تنظیم اسنپ‌پی" });
    await expect(section).toContainText("واسط اسنپ‌پی ← بانک آزمون");
    await expect(section.getByRole("status")).toHaveText(/فقط مشاهده — تغییر این تنظیم به مجوز «تنظیمات امنیتی» نیاز دارد./);
    await expect(section.getByRole("combobox")).toHaveCount(0);
    await expect(section.getByRole("button", { name: "ذخیرهٔ تنظیم اسنپ‌پی" })).toHaveCount(0);
    expect(api.calls.filter(c => c.startsWith("PUT /snappay"))).toEqual([]);
  });

  test("B1-02 explicit settings.security allow keeps the edit and save flow", async ({ page, api }) => {
    api.handlers.set("PUT /snappay/config", async r => { await r.fulfill({ json: { ok: true } }); });
    await page.goto("/?page=settings&settings.tab=snappay");
    const account = page.getByRole("combobox", { name: "حساب واسط و بانک تسویه" });
    await expect(account).toHaveValue("a1");
    await account.selectOption("");
    await page.getByRole("button", { name: "ذخیرهٔ تنظیم اسنپ‌پی" }).click();
    await expect(page.getByRole("status").filter({ hasText: "تنظیم اسنپ‌پی ذخیره شد." })).toBeVisible();
    expect(api.calls.filter(c => c.startsWith("PUT /snappay"))).toEqual(["PUT /snappay/config"]);
  });

  test("B1-02 unknown write permission never renders a writable control: loading, degraded, re-check, deny", async ({ page, api }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __snappayWritable: boolean };
      w.__snappayWritable = false;
      new MutationObserver(() => { if (document.querySelector('[aria-label="تنظیم اسنپ‌پی"] select, [aria-label="تنظیم اسنپ‌پی"] .btn--primary')) w.__snappayWritable = true; })
        .observe(document, { subtree: true, childList: true });
    });
    let release!: () => void;
    let gate = new Promise<void>(r => { release = r; });
    let security: "fail" | "deny" = "fail";
    api.handlers.set("GET /auth/can", async (route, url) => {
      if (url.searchParams.get("operation") === "settings.security") {
        await gate;
        if (security === "fail") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "سرور در دسترس نیست" } } });
        else await route.fulfill({ json: { verdict: "deny", approver: null, reason: "" } });
        return;
      }
      await route.fulfill({ json: { verdict: "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=settings&settings.tab=snappay");
    // loading: بخش هنوز mount نشده؛ فقط «در حال بررسی دسترسی».
    await expect(page.getByText("در حال بررسی دسترسی…", { exact: true })).toBeVisible();
    const section = page.getByRole("region", { name: "تنظیم اسنپ‌پی" });
    await expect(section).toHaveCount(0);
    release();
    // degraded: خواندن مجاز، نوشتن بررسی‌نشده → فقط‌خواندنی.
    await expect(section.getByRole("status")).toHaveText(/مجوز تغییر بررسی نشد/);
    await expect(section).toContainText("واسط اسنپ‌پی ← بانک آزمون");
    await expect(section.getByRole("combobox")).toHaveCount(0);
    // بررسی دوباره: در حال پرسش، هنوز فقط‌خواندنی؛ پاسخ «رد» همان می‌ماند.
    gate = new Promise<void>(r => { release = r; });
    security = "deny";
    const retry = page.getByRole("button", { name: "بررسی دوباره", exact: true });
    if (!(await retry.first().isVisible())) await page.getByRole("button", { name: "بخش‌های بیشتر" }).click();
    await retry.first().click();
    await expect(section.getByRole("status")).toHaveText(/در حال بررسی مجوز تغییر…/);
    release();
    await expect(section.getByRole("status")).toHaveText(/فقط مشاهده/);
    await expect(section.getByRole("combobox")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __snappayWritable: boolean }).__snappayWritable), "never writable before an explicit allow").toBe(false);
    expect(api.calls.filter(c => c.startsWith("PUT /snappay"))).toEqual([]);
  });

  test("B1-04 leaving SnapPay aborts its read; the late answer never surfaces as an error", async ({ page, api }) => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    api.handlers.set("GET /snappay/config", async r => {
      await gate;
      // درخواستِ لغوشده پاسخ را نمی‌پذیرد؛ Playwright آن را بی‌صدا دور می‌اندازد یا خطا می‌دهد.
      await r.fulfill({ json: { accountId: "", enabled: false, accounts: [] } }).catch(() => undefined);
    });
    const aborted = page.waitForEvent("requestfailed", req => req.url().includes("/api/snappay/config"));
    await page.goto("/?page=settings&settings.tab=snappay");
    await expect.poll(() => api.calls.includes("GET /snappay/config")).toBe(true);
    await zoneTab(page, "داشبورد").click();
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    const failed = await aborted;
    expect(failed.failure()?.errorText, "cancelled by the page, not by the network").toMatch(/ERR_ABORTED|cancel/i);
    release();
    await expect(page.getByText("نیاز به رسیدگی", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert"), "an aborted read is not a user error").toHaveCount(0);
  });

  test("B1-03 half-typed range keeps stock valuation visible; only the kardex waits and no invalid date is sent", async ({ page, api }) => {
    Object.assign(api.defaults, REPORT_DATA);
    api.defaults["GET /reports/inventory-valuation"] = { rows: [
      { warehouseId: "w1", warehouseName: "انبار آزمایشی", variationId: "v1", sku: "LM-1", productName: "پیراهن", color: "آبی", size: "M", onHand: "3", totalValue: "3000000", unitCost: "1000000" },
    ] };
    api.defaults["GET /reports/stock-movements"] = { rows: [] };
    await page.goto("/?page=reports&reports.tab=stock");
    const table = page.getByRole("table", { name: "موجودی و ارزش دفتری" });
    await expect(table).toContainText("پیراهن");
    await page.getByRole("button", { name: /^کاردکس/ }).click();
    await expect.poll(() => reportCalls(api, "/reports/stock-movements").length).toBe(1);

    await page.getByLabel("از تاریخ (میلادی)", { exact: true }).fill("2026-09");
    await expect(table, "valuation is point-in-time and stays").toContainText("پیراهن");
    await expect(page.getByText(/کاردکس — پیراهن · آبی M: بازهٔ تاریخ کامل نیست\./)).toBeVisible();
    await expect(page.getByText("بازهٔ تاریخ کامل نیست.", { exact: true })).toHaveCount(0);
    expect(reportCalls(api, "/reports/stock-movements").some(c => c.includes("from=2026-09&")), "half-typed date never reaches the server").toBe(false);
    expect(reportCalls(api, "/reports/stock-movements")).toHaveLength(1);

    await page.getByLabel("از تاریخ (میلادی)", { exact: true }).fill("2026-09-05");
    await expect.poll(() => reportCalls(api, "/reports/stock-movements").some(c => c.includes("from=2026-09-05&"))).toBe(true);
    await expect(page.getByText("در این بازه حرکتی برای این کالا ثبت نشده است.")).toBeVisible();
  });
});
