/**
 * روند داشبورد — ساعتی/روزانه/ماهانه (مهاجرت ۰۹۳) و «پیگیری ثبت حسابداری فروش».
 *
 * رفتار واقعی مرورگر: مرز بازه از «امروز» سرور (نه ساعت مرورگر)، ماه جلالی، یک
 * درخواست برای هر دانه‌بندی، «هنوز نیامده» ≠ صفر، بی‌دسترسی ≠ خطا ≠ خالی، RTL
 * (قدیمی‌تر سمت راست) و بی اسکرول افقی در عرض‌های موبایل.
 */
import { test, expect, fontsReady, DEFAULT_HOURLY, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";
import type { DailyBucket } from "../src/lib/pos";

const panel = (page: Page) => page.locator(".today [role=tabpanel]");
const grain = (page: Page, name: string) => panel(page).getByRole("radio", { name, exact: true });
const trendCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /reports/daily/trend"));
const boundsOf = (call: string) => decodeURIComponent(new URL(call.replace(/^GET /, "http://x")).searchParams.get("bounds") ?? "").split(",");

for (const persisted of [false, true]) test(`dashboard pagehide: request chain ${persisted ? "survives bfcache" : "stops on departure"}`, async ({ page, api }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  api.handlers.set("GET /auth/can", async (route, url) => {
    if (url.searchParams.get("operation") === "period.close") await held;
    await route.fulfill({ json: { verdict: "allow" } });
  });
  await page.goto("/");
  await expect.poll(() => api.calls.includes("GET /auth/can?operation=period.close")).toBe(true);
  await page.evaluate(persisted => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted })), persisted);
  // A request issued after the document departs is the regression, even if its
  // rejection is caught by the UI. Keep fixture error assertions unchanged.
  const nextRequest = page.waitForRequest(url => url.url().includes("/reports/daily/hourly"), { timeout: persisted ? 7000 : 1000 })
    .then(() => true, err => { if (err.name === "TimeoutError") return false; throw err; });
  release();
  expect(await nextRequest).toBe(persisted);
  if (persisted) await expect(panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" })).toBeVisible();
});

/** پاسخ سرور برای همان مرزهایی که مرورگر فرستاده؛ سطل آخر شامل امروز است. */
function bucketsFor(bounds: string[], over: (i: number) => Partial<DailyBucket> = () => ({})): { businessDate: string; profitVisible: boolean; buckets: DailyBucket[] } {
  const buckets = bounds.slice(0, -1).map((from, i) => {
    const next = new Date(`${bounds[i + 1]}T00:00:00Z`); next.setUTCDate(next.getUTCDate() - 1);
    return { from, to: next.toISOString().slice(0, 10), partial: i === bounds.length - 2,
      salesAmount: "0", receivedAmount: "0", profitAmount: "0", invoiceCount: 0, returnCount: 0, paymentCount: 0, ...over(i) };
  });
  return { businessDate: "2026-09-16", profitVisible: true, buckets };
}

function serveTrend(api: MockApi, over: (i: number) => Partial<DailyBucket>) {
  api.handlers.set("GET /reports/daily/trend", async (route, url) => {
    await route.fulfill({ json: bucketsFor((url.searchParams.get("bounds") ?? "").split(","), over) });
  });
}

test.describe("روند داشبورد", () => {
  test("hourly line chart by default; daily and monthly fetch once each with server-day Jalali bounds", async ({ page, api }) => {
    serveTrend(api, i => i % 3 === 0 ? { salesAmount: String((i + 1) * 1_000_000), receivedAmount: String(i * 900_000), profitAmount: "100000", invoiceCount: 2, paymentCount: 2 } : {});
    await page.goto("/");
    await expect(grain(page, "ساعتی")).toBeChecked();
    const hourly = panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" });
    // پیش‌فرض فقط شاخص انتخاب‌شده (بازطراحی مصوب مالک)؛ مقایسه صریح است.
    await expect(hourly.locator(".line-chart-line")).toHaveCount(1);
    await expect(hourly.locator('g[data-series="sales"] .line-chart-line')).toHaveCount(1);
    expect(trendCalls(api), "nothing fetched before a choice").toHaveLength(0);

    await grain(page, "روزانه").check();
    await expect(panel(page).getByRole("heading", { name: "روند فروش روزانه" })).toBeVisible();
    const daily = panel(page).getByRole("figure", { name: "فروش هر روز (تومان)" });
    await expect(daily).toBeVisible();
    const [dayCall] = trendCalls(api);
    const dayBounds = boundsOf(dayCall!);
    expect(dayBounds).toHaveLength(31);
    expect(dayBounds[0]).toBe("2026-08-18");
    expect(dayBounds[29], "today from the server").toBe("2026-09-16");
    expect(dayBounds[30]).toBe("2026-09-17");
    await expect(daily.locator("table tbody tr")).toHaveCount(30);
    await expect(daily.locator("table tbody tr").last()).toContainText("(ناقص)");
    await expect(daily).toContainText("امروز هنوز تمام نشده");
    // یک نقطهٔ ناقص برای هر خطِ نشان‌داده؛ پیش‌فرض فقط شاخص انتخاب‌شده.
    await expect(daily.locator(".line-chart-dot.is-partial")).toHaveCount(1);

    await grain(page, "ماهانه").check();
    const monthly = panel(page).getByRole("figure", { name: "فروش هر ماه (تومان)" });
    await expect(monthly).toBeVisible();
    const monthBounds = boundsOf(trendCalls(api)[1]!);
    expect(monthBounds).toHaveLength(13);
    expect(monthBounds[0], "1 Mehr 1404").toBe("2025-09-23");
    expect(monthBounds[11], "1 Shahrivar 1405").toBe("2026-08-23");
    expect(monthBounds[12]).toBe("2026-09-17");
    await expect(monthly.locator("table tbody th").first()).toHaveText("مهر ۱۴۰۴");
    await expect(monthly.locator("table tbody th").last()).toHaveText("شهریور ۱۴۰۵ (ناقص)");
    await expect(monthly).toContainText("این ماه هنوز تمام نشده");

    // KPI tab and grain are independent; switching back never refetches.
    await page.getByRole("tab", { name: "وجه دریافتی", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: "روند وجه دریافتی ماهانه" })).toBeVisible();
    await grain(page, "روزانه").check();
    await grain(page, "ساعتی").check();
    await expect(panel(page).getByRole("figure", { name: "وجه دریافتی هر ساعت (تومان)" })).toBeVisible();
    expect(trendCalls(api)).toHaveLength(2);
  });

  test("RTL: the earliest point sits on the right; no page overflow at phone and tablet widths", async ({ page, api }) => {
    serveTrend(api, i => ({ salesAmount: String(1_000_000 + i * 10_000), invoiceCount: 1 }));
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      for (const g of ["روزانه", "ماهانه", "ساعتی"]) {
        await grain(page, g).check();
        const chart = panel(page).getByRole("figure");
        await expect(chart).toBeVisible();
        await fontsReady(page);
        const labels = chart.locator(".line-chart-x span");
        const first = (await labels.first().boundingBox())!, last = (await labels.last().boundingBox())!;
        expect(first.x, `${width}/${g}: first label right of last`).toBeGreaterThan(last.x);
        const plot = (await chart.locator(".line-chart-plot").boundingBox())!;
        for (const b of [first, last]) {
          expect(b.x, `${width}/${g}: label inside plot`).toBeGreaterThanOrEqual(plot.x - 1);
          expect(b.x + b.width, `${width}/${g}: label inside plot`).toBeLessThanOrEqual(plot.x + plot.width + 1);
        }
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(size.scroll, `${width}/${g}: no horizontal overflow`).toBeLessThanOrEqual(size.client);
      }
    }
  });

  test("hours after the server's current hour are not drawn as zero", async ({ page, api }) => {
    api.defaults["GET /reports/daily/hourly"] = { ...DEFAULT_HOURLY, currentHour: 18 };
    await page.goto("/");
    const chart = panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" });
    await expect(chart).toContainText("ساعت ۱۸ هنوز تمام نشده");
    await expect(chart).toContainText("۴ ساعت بعدی هنوز نرسیده");
    await expect(chart.locator("table tbody tr").filter({ hasText: "ساعت ۱۹" })).toContainText("هنوز نرسیده");
    await expect(chart.locator("table tbody tr").filter({ hasText: "ساعت ۱۸" })).toContainText("(ناقص)");
    // ساعت ۲۰ (مرجوعی) هنوز نیامده: نه نقطه، نه «−».
    await expect(chart.locator("table tbody tr").filter({ hasText: "ساعت ۲۰" })).not.toContainText("−");
    await expect(chart.locator('g[data-series="sales"] .line-chart-dot')).toHaveCount(11);
  });

  test("daily trend: no report.view is a denial (no request), server 403 too, an error offers re-selection, and none is zero", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "report.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/");
    await expect(panel(page).getByRole("figure")).toBeVisible();
    await grain(page, "روزانه").check();
    await expect(panel(page).getByText("روند روزانه برای این نقش در دسترس نیست.")).toBeVisible();
    await expect(panel(page)).toContainText("روند ساعتی امروز در دسترس است");
    expect(trendCalls(api), "explicit deny sends nothing").toHaveLength(0);
    await grain(page, "ساعتی").check();
    await expect(panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" })).toBeVisible();

    api.handlers.delete("GET /auth/can");
    let status = 403;
    api.handlers.set("GET /reports/daily/trend", async (route, url) => {
      if (status !== 200) await route.fulfill({ status, json: { error: { code: status === 403 ? "deny" : "internal", message: "x", correlationId: "req-42" } } });
      else await route.fulfill({ json: bucketsFor((url.searchParams.get("bounds") ?? "").split(",")) });
    });
    await page.reload();
    await grain(page, "ماهانه").check();
    await expect(panel(page).getByText("روند ماهانه برای این نقش در دسترس نیست.")).toBeVisible();
    status = 500;
    await grain(page, "روزانه").check();
    await expect(panel(page).getByText("روند روزانه خوانده نشد.")).toBeVisible();
    await expect(panel(page)).toContainText("req-42");
    await expect(panel(page).getByRole("figure")).toHaveCount(0);
    status = 200;
    await grain(page, "ساعتی").check();
    await grain(page, "روزانه").check();
    // روز بی رویداد «خالی» است: متن خاص روزانه، نه خط صفر.
    await expect(panel(page).getByText("در ۳۰ روز اخیر فروشی ثبت نشده است.", { exact: true })).toBeVisible();
  });
});

test.describe("بررسی نمودار و مقایسه", () => {
  test("compare-all is explicit: three lines with distinct colours AND dash patterns; off again shows only the selected metric", async ({ page }) => {
    await page.goto("/");
    const chart = panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" });
    await expect(chart.locator(".line-chart-line")).toHaveCount(1);
    const compare = panel(page).getByRole("checkbox", { name: "مقایسهٔ هر سه شاخص" });
    await expect(compare).not.toBeChecked();
    await compare.check();
    await expect(chart.locator(".line-chart-line")).toHaveCount(3);
    const style = await chart.locator(".line-chart-line").evaluateAll(els => els.map(el => {
      const st = getComputedStyle(el); return { color: st.stroke, dash: st.strokeDasharray, series: el.parentElement!.getAttribute("data-series") };
    }));
    expect(new Set(style.map(s => s.color)).size, "سه رنگ").toBe(3);
    expect(new Set(style.map(s => s.dash)).size, "سه الگوی خط").toBe(3);
    await expect(chart.locator(".line-chart-legend li")).toHaveText(["فروش", "وجه دریافتی", "سود"]);
    await expect(chart.locator("g[data-emphasis]")).toHaveAttribute("data-series", "sales");
    await compare.uncheck();
    await expect(chart.locator(".line-chart-line")).toHaveCount(1);
  });

  test("keyboard and touch inspection: one Tab stop, RTL arrows/Home/End move the readout; tap picks the nearest point; table can be shown", async ({ page }) => {
    await page.goto("/");
    const chart = panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" });
    const plot = chart.getByRole("group");
    const readout = chart.locator(".line-chart-readout");
    await expect(readout, "پیش‌فرض: آخرین نقطهٔ رسیده").toContainText("ساعت ۲۲");
    await plot.focus();
    await expect(plot).toBeFocused();
    await page.keyboard.press("Home");
    await expect(readout).toContainText("ساعت ۸");
    await page.keyboard.press("ArrowLeft"); // RTL: چپ = بعدی
    await expect(readout).toContainText("ساعت ۹");
    await page.keyboard.press("ArrowRight");
    await expect(readout).toContainText("ساعت ۸");
    await page.keyboard.press("End");
    await expect(readout).toContainText("ساعت ۲۲");
    await expect(readout).toHaveAttribute("aria-live", "polite");
    // لمس/کلیک: نقطهٔ نزدیک — لبهٔ راست (RTL) قدیمی‌ترین ساعت است.
    const box = (await plot.boundingBox())!;
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await expect(readout).toContainText("ساعت ۸");
    await expect(readout).toContainText("فروش");
    await expect(readout).toContainText("تومان");
    // جدول آشکار — همان جدول، بی نسخهٔ دوم.
    const toggle = chart.getByRole("button", { name: "نمایش جدول داده" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const table = chart.getByRole("table");
    await expect(table).toBeVisible();
    await expect(chart.getByRole("table")).toHaveCount(1);
    await expect(table.locator("thead th")).toHaveText(["ساعت", "فروش"]);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, "جدول آشکار صفحه را افقی نمی‌کشد").toBeLessThanOrEqual(size.client);
  });

  test("axis has a unit and round ticks that include zero; negative profit stays below zero, not clamped", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "سود", exact: true }).click();
    const chart = panel(page).getByRole("figure", { name: "سود هر ساعت (تومان)" });
    await expect(chart.locator(".line-chart-unit")).toHaveText("تومان");
    const ys = await chart.locator(".line-chart-y").allTextContents();
    expect(ys).toContain("0");
    expect(ys.some(t => t.startsWith("−")), "تیک منفی برای زیان").toBe(true);
    await expect(chart.locator(".line-chart-zero")).toHaveCount(1);
    await expect(chart.locator('.line-chart-dot[data-sign="negative"]')).toHaveCount(1);
  });

  test("when the trend period is not today, the today-only scope of the KPI cards is stated", async ({ page, api }) => {
    serveTrend(api, () => ({}));
    await page.goto("/");
    const scope = panel(page).locator(".trend-scope");
    await expect(scope).toContainText("کارت‌ها و نمودار: امروز");
    await grain(page, "روزانه").check();
    await expect(scope).toContainText("کارت‌های بالا: فقط امروز");
    await expect(scope).toContainText("۳۰ روز اخیر");
    await grain(page, "ماهانه").check();
    await expect(scope).toContainText("۱۲ ماه شمسی اخیر");
  });
});

test.describe("پیگیری ثبت حسابداری فروش", () => {
  const row = { branchId: "b1", invoiceCount: 12, payableAmount: "12340000", cogsAmount: "9000000" };
  const section = (page: Page) => page.getByRole("region", { name: "پیگیری ثبت حسابداری فروش" });
  const summary = (page: Page) => section(page).locator("summary");
  async function expand(page: Page) {
    const d = section(page).locator("details");
    await expect(d, "بسته به‌طور پیش‌فرض").not.toHaveAttribute("open", "");
    await summary(page).click();
    await expect(d).toHaveAttribute("open", "");
  }

  test("collapsed below the KPI band and the chart; the summary carries the real count; each item states cause and an allowed action", async ({ page, api }) => {
    api.defaults["GET /posting-batches/unposted"] = { rows: [
      { ...row, batchId: "t", batchKind: "channel_day", channel: "web", businessDate: "2026-09-16" },
      { ...row, batchId: "p", batchKind: "channel_day", channel: "web", businessDate: "2026-09-15" },
      { ...row, batchId: "s", batchKind: "shift", channel: "pos", businessDate: "2026-09-14" },
    ] };
    await page.goto("/");
    await expect(summary(page)).toContainText("۲ مورد نیازمند بررسی");
    const today = (await page.locator(".today").boundingBox())!, own = (await section(page).boundingBox())!;
    expect(own.y, "پس از شاخص‌ها و نمودار").toBeGreaterThan(today.y + today.height - 1);
    await expand(page);
    await expect(section(page)).toContainText("این بخش وضعیت کلی سایت یا سامانه نیست");
    const items = section(page).locator(".task");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("سود و ترازنامه ناقص‌اند");
    await expect(items.nth(0).getByRole("button", { name: "بستن دوره", exact: true })).toBeVisible();
    await expect(items.nth(1)).toContainText("صندوق‌دار کشو را نشمارد");
    await expect(items.nth(2)).toContainText("کاری لازم نیست");
    await expect(items.nth(2).getByRole("button")).toHaveCount(0);
    await items.nth(1).getByRole("link", { name: "رفتن به صندوق" }).click();
    await expect(page).toHaveURL(/page=pos/);
  });

  test("today's open period alone is information, not a count", async ({ page, api }) => {
    api.defaults["GET /posting-batches/unposted"] = { rows: [{ ...row, batchId: "t", batchKind: "channel_day", channel: "web", businessDate: "2026-09-16" }] };
    await page.goto("/");
    await expect(summary(page)).toContainText("دورهٔ امروز هنوز باز است؛ کاری لازم نیست");
    await expect(summary(page)).not.toContainText("مورد");
  });

  test("empty, no permission, loading and failure read differently in the collapsed summary; failure is never green and can be re-checked", async ({ page, api }) => {
    await page.goto("/");
    await expect(summary(page)).toContainText("همه ثبت شده‌اند");
    await expect(summary(page).locator(".status")).toHaveAttribute("data-state", "completed");
    await expand(page);
    await expect(section(page)).toContainText("همه درآمدها به دفتر رفته‌اند");

    let status = 403;
    let release: (() => void) | null = null;
    api.handlers.set("GET /posting-batches/unposted", async route => {
      if (status === 0) { await new Promise<void>(r => { release = r; }); await route.fulfill({ json: { rows: [] } }); return; }
      if (status === 200) await route.fulfill({ json: { rows: [] } });
      else await route.fulfill({ status, json: { error: { code: "x", message: "x", correlationId: "req-7" } } });
    });
    await page.reload();
    await expect(summary(page)).toContainText("برای این نقش نمایش داده نمی‌شود");
    await expect(summary(page).locator(".status")).toHaveAttribute("data-state", "unknown");
    await expand(page);
    await expect(section(page)).toContainText("به معنای «همه‌چیز مرتب» نیست");
    await expect(section(page)).not.toContainText("همه درآمدها به دفتر رفته‌اند");
    await expect(section(page).getByRole("button")).toHaveCount(0);

    status = 500;
    await page.reload();
    await expect(summary(page)).toContainText("وضعیت خوانده نشد");
    await expect(summary(page).locator(".status"), "خطا سبز نیست").toHaveAttribute("data-state", "failed");
    await expand(page);
    await expect(section(page)).toContainText("req-7");
    status = 0;
    await section(page).getByRole("button", { name: "بررسی دوباره" }).click();
    await expect(summary(page)).toContainText("در حال بررسی");
    await expect.poll(() => release !== null).toBe(true);
    release!();
    await expect(summary(page)).toContainText("همه ثبت شده‌اند");
  });
});
