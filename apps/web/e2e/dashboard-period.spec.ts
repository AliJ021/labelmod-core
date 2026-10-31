/**
 * مرور دوره در داشبورد (دستهٔ B، مصوب مالک): بازه و مبنا از «امروزِ» سرور، صندوق جدا از سایت،
 * مرجوعی جدا از بازپرداخت، ترکیب پرداخت، تفاضل مطلق بی درصد، دامنهٔ شعبه، و اینکه
 * «نمی‌دانم» هرگز صفر نشان داده نمی‌شود. داده از `periodBody` است که مثل سرور خودسازگار است.
 * هیچ sleep؛ پاسخ کهنه با نگه‌داشتن صریح ساخته می‌شود.
 */
import { test, expect, periodBody, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const section = (page: Page) => page.getByRole("region", { name: "مرور دوره" });
const periodCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /reports/dashboard/period"));
const query = (call: string) => Object.fromEntries(new URL(`http://x${call.slice(4)}`).searchParams);
const kpi = (page: Page, label: string) => section(page).getByRole("region", { name: label, exact: true });

test.describe("مرور دوره در داشبورد", () => {
  test("7 days by default, bounds from the server's business day; channels, returns ≠ refunds, payment mix, exact deltas", async ({ page, api }) => {
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    await expect(section(page)).toBeVisible();
    await expect.poll(() => periodCalls(api).length).toBe(1);
    expect(query(periodCalls(api)[0]!)).toEqual({ from: "2026-09-10", to: "2026-09-16", prevFrom: "2026-09-03", prevTo: "2026-09-09", branchId: "b1" });
    await expect(section(page)).toContainText("۷ روز، امروز هنوز تمام نشده");
    // فروش خالص = (۴۵٬۰۰۰٬۰۰۰ − ۱٬۵۰۰٬۰۰۰) + (۱۸٬۰۰۰٬۰۰۱ − ۲٬۰۰۰٬۰۰۰) ریال؛ ریالِ باقی‌مانده پنهان نمی‌شود.
    await expect(kpi(page, "فروش خالص")).toContainText("5٬950٬000٫1");
    await expect(kpi(page, "فروش خالص")).toContainText("دورهٔ قبل: 3٬950٬000");
    await expect(kpi(page, "فروش خالص")).toContainText(/2٬000٬000٫1\s*تومان بیشتر/);
    await expect(section(page)).not.toContainText("%");
    // مرجوعی (ارزش کالا) و بازپرداخت (پول) دو عددِ جدا.
    await expect(kpi(page, "مرجوعی (ارزش کالای برگشتی)")).toContainText("350٬000");
    await expect(kpi(page, "مرجوعی (ارزش کالای برگشتی)")).toContainText("۳ برگ");
    await expect(kpi(page, "بازپرداخت (پول پس‌داده)")).toContainText("350٬000");
    await expect(kpi(page, "بازپرداخت (پول پس‌داده)")).toContainText("۲ پرداخت");
    await expect(kpi(page, "دریافت خالص")).toContainText("4٬850٬000");

    const channels = section(page).getByRole("region", { name: "صندوق و سایت" });
    await expect(channels.getByRole("row")).toHaveCount(4); // سرستون + صندوق + سایت + جمع
    await expect(channels.getByRole("row").nth(1)).toContainText("صندوق");
    await expect(channels.getByRole("row").nth(2)).toContainText("سایت");
    // سایتِ بی فاکتور در دورهٔ قبل: میانگین فقط برای این دوره؛ تفاضل خالص همهٔ فروشش است.
    await expect(channels.getByRole("row").nth(2)).toContainText(/1٬600٬000٫1\s*تومان بیشتر/);
    const payments = section(page).getByRole("region", { name: "ترکیب پرداخت" });
    await expect(payments.getByRole("row").nth(1)).toContainText("کارت‌خوان");
    // روشی که این دوره پولی نداشت، صفر است و تفاضل منفی‌اش «کمتر» — پنهان نمی‌شود.
    const transfer = payments.getByRole("row").filter({ hasText: "کارت‌به‌کارت" });
    await expect(transfer).toContainText(/100٬000\s*تومان کمتر/);
    expect(api.unexpected).toEqual([]);
  });

  test("changing the period cancels the old read; a late old answer never replaces the new one", async ({ page, api }) => {
    let releaseOld!: () => void;
    const held = new Promise<void>(r => { releaseOld = r; });
    let n = 0;
    api.handlers.set("GET /reports/dashboard/period", async (route: Route, url: URL) => {
      const mine = ++n;
      const q = Object.fromEntries(url.searchParams);
      if (mine === 1) {
        await held;
        await route.fulfill({ json: periodBody({ ...q, branchId: "b1" }) }).catch(() => {});
        return;
      }
      const body = periodBody({ ...q, branchId: "b1" });
      body.current.totals.salesAmount = "77700000";
      await route.fulfill({ json: body });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    await expect.poll(() => n).toBe(1);
    await section(page).getByRole("radio", { name: "ماه قبل" }).check();
    await expect.poll(() => n).toBe(2);
    expect(query(periodCalls(api)[1]!)).toMatchObject({ from: "2026-07-23", to: "2026-08-22", prevFrom: "2026-06-22", prevTo: "2026-07-22" });
    await expect(kpi(page, "فروش خالص")).toContainText("7٬770٬000");
    await expect(section(page)).toContainText("۳۱ روز)");
    releaseOld();
    await expect(kpi(page, "فروش خالص")).toContainText("7٬770٬000");
    await expect(kpi(page, "فروش خالص")).not.toContainText("5٬950٬000");
  });

  test("no cost.view: profit is “—” with the reason, never 0; no average without invoices", async ({ page, api }) => {
    const body = periodBody({ profitVisible: false });
    body.current.channels[1] = { ...body.current.channels[1]!, invoiceCount: 0, averageInvoice: null };
    api.defaults["GET /reports/dashboard/period"] = body;
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    await expect(kpi(page, "سود")).toContainText("دسترسی بهای تمام‌شده لازم است");
    await expect(kpi(page, "سود").locator(".money--unknown")).toHaveCount(1);
    await expect(kpi(page, "سود")).not.toContainText(/\b0\b|۰ تومان/);
    const web = section(page).getByRole("region", { name: "صندوق و سایت" }).getByRole("row").nth(2);
    await expect(web.locator(".money--unknown")).toHaveCount(1);
  });

  test("a failed read says so with a reference — not zeros", async ({ page, api }) => {
    api.handlers.set("GET /reports/dashboard/period", async route => {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-p1" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    await expect(section(page)).toContainText("مرور دوره خوانده نشد");
    await expect(section(page)).toContainText("req-p1");
    await expect(section(page)).toContainText("به معنای «فروشی نبود» نیست");
    await expect(kpi(page, "فروش خالص")).toHaveCount(0);
  });

  test("all-branch scope: “all branches” by default (no branchId), and a branch can be picked", async ({ page, api }) => {
    api.defaults["GET /branches"] = { allBranches: true, branches: [
      { id: "b1", code: "A", name: "شعبه یک", warehouses: [] }, { id: "b2", code: "B", name: "شعبه دو", warehouses: [] }] };
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    const select = section(page).getByLabel("شعبه");
    await expect(select).toHaveValue("all");
    await expect.poll(() => periodCalls(api).length).toBe(1);
    expect(query(periodCalls(api)[0]!)).not.toHaveProperty("branchId");
    await select.selectOption("b2");
    await expect.poll(() => periodCalls(api).length).toBe(2);
    expect(query(periodCalls(api)[1]!).branchId).toBe("b2");
  });

  test("multi-branch without all-branch scope: no “all” option; single branch: no selector", async ({ page, api }) => {
    api.defaults["GET /branches"] = { allBranches: false, branches: [
      { id: "b1", code: "A", name: "شعبه یک", warehouses: [] }, { id: "b2", code: "B", name: "شعبه دو", warehouses: [] }] };
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    const select = section(page).getByLabel("شعبه");
    await expect(select.locator("option")).toHaveText(["شعبه یک", "شعبه دو"]);
    await expect.poll(() => periodCalls(api).length).toBe(1);
    expect(query(periodCalls(api)[0]!).branchId).toBe("b1");
  });

  test("same-day refresh re-reads the period with the same selection; the page is not fresh until it lands; a late older answer never wins", async ({ page, api }) => {
    api.defaults["GET /branches"] = { allBranches: true, branches: [
      { id: "b1", code: "A", name: "شعبه یک", warehouses: [] }, { id: "b2", code: "B", name: "شعبه دو", warehouses: [] }] };
    const holds = new Map<number, () => void>();
    let n = 0;
    api.handlers.set("GET /reports/dashboard/period", async (route: Route, url: URL) => {
      const mine = ++n;
      const q = Object.fromEntries(url.searchParams);
      const body = periodBody({ ...q, branchId: q.branchId ?? null });
      if (mine >= 4) body.current.totals.salesAmount = "88800000";
      // سومی (انتخاب شعبه) کهنه‌ای است که دیر می‌رسد؛ چهارمی (به‌روزرسانی) تا آزادسازی صریح در راه است.
      if (mine === 3 || mine === 4) await new Promise<void>(r => holds.set(mine, r));
      await route.fulfill({ json: body }).catch(() => {});
    });
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    const freshness = page.locator(".freshness");
    await expect(freshness).toHaveAttribute("data-state", "fresh");
    await section(page).getByRole("radio", { name: "۳۰ روز اخیر" }).check();
    await expect.poll(() => n).toBe(2);
    await expect(kpi(page, "فروش خالص")).toContainText("5٬950٬000٫1");
    await section(page).getByLabel("شعبه").selectOption("b2");
    await expect.poll(() => holds.has(3)).toBe(true);
    // به‌روزرسانی هنگامی که پاسخ انتخاب شعبه هنوز نرسیده: همان انتخاب (۳۰ روز، b2) دوباره خوانده می‌شود.
    await page.getByRole("button", { name: /به‌روزرسانی/ }).click();
    await expect.poll(() => holds.has(4)).toBe(true);
    expect(query(periodCalls(api)[3]!)).toEqual(query(periodCalls(api)[2]!));
    expect(query(periodCalls(api)[3]!)).toMatchObject({ branchId: "b2", from: "2026-08-18", to: "2026-09-16" });
    // «امروز» رسیده، ولی دوره نه: سرصفحه هنوز «تازه» نیست.
    await expect(freshness).toHaveAttribute("data-state", "refreshing");
    holds.get(4)!();
    await expect(kpi(page, "فروش خالص")).toContainText("8٬880٬000");
    await expect(freshness).toHaveAttribute("data-state", "fresh");
    // پاسخ کهنهٔ انتخاب شعبه دیر می‌رسد و جای نتیجهٔ تازه‌تر را نمی‌گیرد.
    holds.get(3)!();
    await page.waitForLoadState("networkidle");
    await expect(kpi(page, "فروش خالص")).toContainText("8٬880٬000");
    await expect(section(page).getByLabel("شعبه")).toHaveValue("b2");
    await expect(section(page).getByRole("radio", { name: "۳۰ روز اخیر" })).toBeChecked();
    expect(api.unexpected).toEqual([]);
  });

  test("a failed period refresh keeps the last numbers and fails the page refresh (never fresh)", async ({ page, api }) => {
    let n = 0;
    api.handlers.set("GET /reports/dashboard/period", async (route: Route) => {
      if (++n === 1) { await route.fulfill({ json: periodBody() }); return; }
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-p9" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    await expect(kpi(page, "فروش خالص")).toContainText("5٬950٬000٫1");
    await page.getByRole("button", { name: /به‌روزرسانی/ }).click();
    const freshness = page.locator(".freshness");
    await expect(freshness).toHaveAttribute("data-state", "failed");
    await expect(freshness).toContainText("req-p9");
    await expect(kpi(page, "فروش خالص")).toContainText("5٬950٬000٫1");
    expect(n).toBe(2);
  });

  test("no report.view: the section is not rendered and nothing is requested", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "report.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sales");
    // طرح ۱۰: شاخص‌ها در «نمای کلی»‌اند؛ لنگر بارشدن صفحه سرعنوان داشبورد است که در هر زبانه هست.
    await expect(page.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible();
    await expect(section(page)).toHaveCount(0);
    expect(periodCalls(api)).toEqual([]);
  });
});
