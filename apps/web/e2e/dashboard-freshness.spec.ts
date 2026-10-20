/**
 * تازگی داشبورد (دستهٔ A، مصوب مالک): «داده‌ها از کی‌اند»، به‌روزرسانی دستی، خودکار فقط وقتی صفحه
 * دیده می‌شود و شبکه هست، Backoff پس از شکست، بی هم‌پوشانی، و هیچ پاسخ کهنه‌ای نتیجهٔ تازه‌تر را
 * بازنویسی نمی‌کند. ساعت با `page.clock` کنترل می‌شود — هیچ sleep دلخواهی نیست.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { DailyBucket, DailyReport } from "../src/lib/pos";

test.use({ timezoneId: "Asia/Tehran" });

/** ۱۰:۴۰ به وقت تهران. */
const T0 = new Date("2026-09-16T07:10:00Z");
const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  businessDate: "2026-09-16", salesAmount: "12340000", receivedAmount: "11000000", profitAmount: "2340000",
  invoiceCount: 12, returnCount: 1, ...over,
});
const dailyCalls = (api: MockApi) => api.calls.filter(c => /^GET \/reports\/daily\?/.test(c)).length;
const hourlyCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /reports/daily/hourly")).length;
const freshness = (page: Page) => page.locator(".freshness");
const refreshButton = (page: Page) => page.getByRole("button", { name: /به‌روزرسانی|در حال به‌روزرسانی/ });
const salesKpi = (page: Page) => page.getByRole("tab", { name: /فروش/ }).first();

async function open(page: Page) {
  await page.clock.install({ time: T0 });
  await page.goto("/");
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");
  await expect(freshness(page)).toContainText("به‌روزشده ساعت ۱۰:۴۰");
}

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate(s => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** پاسخ‌های پیاپی `/reports/daily`؛ `hold` همان شمارهٔ فراخوان را تا آزادسازی نگه می‌دارد. */
function serveDaily(api: MockApi, answer: (n: number) => Partial<DailyReport> | "fail", hold?: { n: number; until: Promise<void> }) {
  let n = 0;
  api.handlers.set("GET /reports/daily", async (route: Route) => {
    const mine = ++n;
    if (hold && mine === hold.n) await hold.until;
    const a = answer(mine);
    if (a === "fail") await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-9a1" } } });
    else await route.fulfill({ json: report(a) });
  });
}

test("manual refresh: one chain at a time, old numbers stay until the new ones land, then the time moves", async ({ page, api }) => {
  let release!: () => void;
  serveDaily(api, n => n === 1 ? {} : { salesAmount: "22340000" }, { n: 2, until: new Promise(r => { release = r; }) });
  await open(page);
  expect(dailyCalls(api)).toBe(1);
  await page.clock.runFor(30_000);
  await refreshButton(page).click();
  await expect(refreshButton(page)).toBeDisabled();
  await expect(refreshButton(page)).toHaveAttribute("aria-busy", "true");
  await expect(freshness(page)).toHaveAttribute("data-state", "refreshing");
  // در راه: عدد قبلی می‌ماند، نه اسکلت و نه صفر.
  await expect(salesKpi(page)).toContainText("1٬234٬000");
  // زمان‌سنج خودکار در همین فاصله سر می‌رسد ولی دومی شروع نمی‌شود.
  await page.clock.runFor(45_000);
  expect(dailyCalls(api)).toBe(2);
  release();
  await expect(salesKpi(page)).toContainText("2٬234٬000");
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");
  await expect(freshness(page)).toContainText("به‌روزشده ساعت ۱۰:۴۱");
  expect(dailyCalls(api)).toBe(2);
  expect(hourlyCalls(api)).toBe(2);
});

test("auto refresh runs every minute only while visible; becoming visible after the due time refreshes at once", async ({ page, api }) => {
  serveDaily(api, () => ({}));
  await open(page);
  await page.clock.runFor(59_000);
  expect(dailyCalls(api)).toBe(1);
  await page.clock.runFor(2_000);
  await expect.poll(() => dailyCalls(api)).toBe(2);
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");

  await setVisibility(page, "hidden");
  await page.clock.runFor(5 * 60_000);
  await setVisibility(page, "visible");
  // دیده‌شدن پس از موعد: همان لحظه (۱۰:۴۶) — و پس از نشستن نتیجه، دقیقاً سه خواندن: زبانهٔ پنهان
  // هیچ درخواستی نفرستاده است (شمارش پس از پایدارشدن حالت، نه بلافاصله پس از جلو بردن ساعت).
  await expect(freshness(page)).toContainText("به‌روزشده ساعت ۱۰:۴۶");
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");
  expect(dailyCalls(api), "زبانهٔ پنهان سرور را صدا نمی‌زند").toBe(3);
});

test("failed refresh keeps the last numbers, says since when (never green), and backs off before retrying", async ({ page, api }) => {
  serveDaily(api, n => n === 2 ? "fail" : {});
  await open(page);
  await page.clock.runFor(61_000);
  await expect(freshness(page)).toHaveAttribute("data-state", "failed");
  await expect(freshness(page)).toContainText("به‌روزرسانی ناموفق");
  await expect(freshness(page)).toContainText("داده‌ها از ساعت ۱۰:۴۰");
  await expect(freshness(page)).toContainText("req-9a1");
  await expect(freshness(page).locator('[data-state="completed"]')).toHaveCount(0);
  await expect(salesKpi(page)).toContainText("1٬234٬000");
  await expect(page.getByRole("status").filter({ hasText: "به‌روزرسانی ناموفق بود" })).toHaveCount(1);
  // Backoff: پس از یک شکست، دو دقیقه — نه یک. پس از ۱۰:۴۳ و نشستن نتیجه، دقیقاً سه خواندن.
  await page.clock.runFor(61_000);
  await page.clock.runFor(60_000);
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");
  await expect(freshness(page)).toContainText("به‌روزشده ساعت ۱۰:۴۳");
  expect(dailyCalls(api), "تلاش بعدی دو دقیقه پس از شکست، نه یک").toBe(3);
});

test("offline pauses refresh and says so; reconnecting refreshes once", async ({ page, api, context }) => {
  serveDaily(api, () => ({}));
  await open(page);
  await context.setOffline(true);
  await expect(freshness(page)).toHaveAttribute("data-state", "offline");
  await expect(freshness(page)).toContainText("پس از وصل‌شدن به‌روز می‌شود");
  await expect(refreshButton(page)).toBeDisabled();
  await page.clock.runFor(5 * 60_000);
  expect(dailyCalls(api)).toBe(1);
  await context.setOffline(false);
  await expect.poll(() => dailyCalls(api)).toBe(2);
  await expect(freshness(page)).toHaveAttribute("data-state", "fresh");
});

/** سطل‌های روند برای همان مرزهایی که مرورگر فرستاده، همه با یک مبلغ. */
function buckets(url: URL, salesAmount: string): { businessDate: string; profitVisible: boolean; buckets: DailyBucket[] } {
  const bounds = (url.searchParams.get("bounds") ?? "").split(",");
  return { businessDate: "2026-09-16", profitVisible: true, buckets: bounds.slice(0, -1).map((from, i) => ({
    from, to: from, partial: i === bounds.length - 2, salesAmount, receivedAmount: "0", profitAmount: "0",
    invoiceCount: 1, returnCount: 0, paymentCount: 0,
  })) };
}

test("a trend read that started before a refresh never overwrites the refreshed trend", async ({ page, api }) => {
  serveDaily(api, () => ({}));
  let releaseOld!: () => void;
  const oldHeld = new Promise<void>(r => { releaseOld = r; });
  let n = 0;
  let oldDone!: () => void;
  const oldDelivered = new Promise<void>(r => { oldDone = r; });
  api.handlers.set("GET /reports/daily/trend", async (route, url) => {
    const mine = ++n;
    if (mine === 1) {
      await oldHeld;
      await route.fulfill({ json: buckets(url, "11110000") });
      oldDone();
      return;
    }
    await route.fulfill({ json: buckets(url, "22220000") });
  });
  await open(page);
  const panel = page.locator(".today [role=tabpanel]");
  await panel.getByRole("radio", { name: "روزانه", exact: true }).click();
  await expect.poll(() => n).toBe(1);
  await refreshButton(page).click();
  await expect.poll(() => n, { message: "به‌روزرسانی روند دیده‌شده را دوباره می‌خواند" }).toBe(2);
  await expect(panel).toContainText("2٬222٬000");
  releaseOld();
  await oldDelivered;
  await page.clock.runFor(50);
  await expect(panel).toContainText("2٬222٬000");
  await expect(panel).not.toContainText("1٬111٬000");
});

test("a new business day on refresh moves the header date and reads the new day's hours", async ({ page, api }) => {
  serveDaily(api, n => n === 1 ? {} : { businessDate: "2026-09-17", salesAmount: "0", receivedAmount: "0", profitAmount: "0", invoiceCount: 0, returnCount: 0 });
  await open(page);
  await expect(page.locator(".page-context")).toContainText("۲۵ شهریور ۱۴۰۵");
  await refreshButton(page).click();
  await expect(page.locator(".page-context")).toContainText("۲۶ شهریور ۱۴۰۵");
  await expect.poll(() => api.calls.some(c => c.startsWith("GET /reports/daily/hourly") && c.includes("date=2026-09-17"))).toBe(true);
});

test("leaving the dashboard mid-refresh stops the chain: no request after the screen is gone", async ({ page, api }) => {
  serveDaily(api, () => ({}));
  api.defaults["GET /invoices"] = { rows: [], total: 0, pageSize: 50 };
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let unposted = 0;
  api.handlers.set("GET /posting-batches/unposted", async route => {
    if (++unposted === 2) await held;
    await route.fulfill({ json: { rows: [] } });
  });
  await open(page);
  await refreshButton(page).click();
  await expect.poll(() => unposted).toBe(2);
  const canBefore = api.calls.filter(c => c.startsWith("GET /auth/can?operation=period.close")).length;
  const hourlyBefore = hourlyCalls(api);
  await page.getByRole("link", { name: "فاکتورها" }).first().click();
  await expect(page).not.toHaveURL(/\/$/);
  release();
  await page.clock.runFor(2 * 60_000);
  expect(api.calls.filter(c => c.startsWith("GET /auth/can?operation=period.close")).length).toBe(canBefore);
  expect(hourlyCalls(api)).toBe(hourlyBefore);
  expect(dailyCalls(api), "بی زمان‌سنج پس از رفتن").toBe(2);
});
