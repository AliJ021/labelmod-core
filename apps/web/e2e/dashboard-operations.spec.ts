/**
 * کارهای عملیاتی داشبورد (دستهٔ D، مصوب مالک): شیفت، سررسید چک و ماندهٔ مشتریانِ همان شعبه. بخش بی‌مجوز
 * پنهان است (نه صفر)، فقط سررسیدگذشته و شیفت ماندهٔ دیروز «رسیدگی» می‌گیرند، و به‌روزرسانی داشبورد همین
 * بخش را با همان قاعدهٔ تازگی می‌خواند. هیچ sleep؛ پاسخ کهنه با نگه‌داشتن صریح ساخته می‌شود.
 */
import { test, expect, opsBody, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const section = (page: Page) => page.getByRole("region", { name: "کارهای عملیاتی" });
const tile = (page: Page, name: string) => section(page).getByRole("region", { name, exact: true });
const opsCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /dashboard/operations"));

const busy = opsBody({
  shifts: { state: "ready", openCount: 3, carriedOverCount: 1, closedToday: 2, varianceToday: 1, open: [
    { id: "s1", userName: "صندوق‌دار دیروز", openedAt: "2026-09-15T15:00:00.000Z", carriedOver: true },
    { id: "s2", userName: "صندوق‌دار امروز", openedAt: "2026-09-16T05:00:00.000Z", carriedOver: false },
  ] },
  cheques: { state: "ready", warningDays: 7,
    received: { overdue: { count: 2, amount: "30000010", nextDue: "2026-09-13" }, dueSoon: { count: 1, amount: "5000000", nextDue: "2026-09-18" } },
    issued: { overdue: { count: 0, amount: "0", nextDue: null }, dueSoon: { count: 1, amount: "9000000", nextDue: "2026-09-20" } } },
  receivables: { state: "ready", owed: { count: 4, amount: "12345671" }, credit: { count: 2, amount: "850000" } },
});

test.describe("کارهای عملیاتی داشبورد", () => {
  test("shifts, cheques and customer balances of the dashboard branch; exact amounts; only overdue and carried-over shifts ask for attention", async ({ page, api }) => {
    api.defaults["GET /dashboard/operations"] = busy;
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(section(page)).toBeVisible();

    const shifts = tile(page, "شیفت صندوق");
    await expect(shifts).toContainText("۱ شیفت از روز کاری قبل باز مانده است");
    // پوسته (با اسکلت) پیش از درخواست mount می‌شود و درخواست در effect بعدی می‌رود؛ پس «دیده شد» ثابت نمی‌کند
    // درخواست ثبت شده (WebKit کند: [] دید). شمار دقیق پس از رسیدن خودِ داده سنجیده می‌شود: یک درخواست، همین شعبه.
    expect(opsCalls(api)).toEqual(["GET /dashboard/operations?branchId=b1"]);
    await expect(shifts.locator('.ops-verdict [data-state="attention"]')).toHaveCount(1);
    await expect(shifts.getByRole("listitem")).toHaveCount(2);
    await expect(shifts.getByRole("listitem").first()).toContainText("از روز قبل");
    await expect(shifts.getByRole("listitem").nth(1)).not.toContainText("از روز قبل");
    await expect(shifts).toContainText("نمونهٔ ۲ از ۳ شیفت باز");
    await expect(shifts).toContainText("بسته‌شدهٔ امروز: ۲ · با مغایرت: ۱");

    const cheques = tile(page, "سررسید چک");
    await expect(cheques).toContainText("چک سررسیدگذشته‌ای در دست است");
    await expect(cheques.locator('.ops-verdict [data-state="attention"]')).toHaveCount(1);
    // ریالِ باقی‌مانده پنهان نمی‌شود: ۳۰٬۰۰۰٬۰۱۰ ریال = ۳٬۰۰۰٬۰۰۱ تومان.
    await expect(cheques.locator(".ops-row").filter({ hasText: "دریافتی — سررسیدگذشته" })).toContainText("3٬000٬001");
    await expect(cheques.locator(".ops-row").filter({ hasText: "دریافتی — نزدیک (تا ۷ روز)" })).toContainText("500٬000");
    await expect(cheques.locator(".ops-row").filter({ hasText: "پرداختی — سررسیدگذشته" })).toContainText("نیست");
    await expect(cheques.locator(".ops-row").filter({ hasText: "پرداختی — نزدیک" })).toContainText("900٬000");

    const customers = tile(page, "ماندهٔ مشتریان");
    await expect(customers.locator(".ops-row").filter({ hasText: "طلب از مشتریان" })).toContainText("1٬234٬567٫1");
    await expect(customers.locator(".ops-row").filter({ hasText: "طلب از مشتریان" })).toContainText("۴ مشتری");
    await expect(customers.locator(".ops-row").filter({ hasText: "اعتبار مشتریان" })).toContainText("85٬000");
    await expect(customers).toContainText("این سن طلب یا سررسید نیست");
    // کارت چیزی را تغییر نمی‌دهد: هیچ دکمه‌ای ندارد، فقط پیوند به همان صفحه‌های موجود.
    await expect(section(page).getByRole("button")).toHaveCount(0);
    await expect(customers.getByRole("link", { name: "دریافتنی و پرداختنی" })).toHaveAttribute("href", "/?page=reports&reports.tab=parties");
    await expect(cheques.getByRole("link", { name: "سررسیدهای چک" })).toHaveAttribute("href", "/?page=treasury&treasury.tab=due");
  });

  test("a calm day stays calm: no attention without overdue cheques or carried-over shifts", async ({ page }) => {
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(tile(page, "شیفت صندوق")).toContainText("۱ شیفت باز");
    await expect(tile(page, "سررسید چک")).toContainText("چک سررسیدگذشته یا نزدیکی نیست");
    await expect(section(page).locator('[data-state="attention"]')).toHaveCount(0);
  });

  test("cheques only near their due date inform; they do not ask for attention", async ({ page, api }) => {
    const soon = { count: 1, amount: "5000000", nextDue: "2026-09-18" }, none = { count: 0, amount: "0", nextDue: null };
    api.defaults["GET /dashboard/operations"] = opsBody({ cheques: { state: "ready", warningDays: 7,
      received: { overdue: none, dueSoon: soon }, issued: { overdue: none, dueSoon: none } } });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(tile(page, "سررسید چک")).toContainText("چک نزدیک به سررسید");
    await expect(tile(page, "سررسید چک").locator('[data-state="attention"]')).toHaveCount(0);
  });

  test("a denied section is not rendered — never zeros", async ({ page, api }) => {
    api.defaults["GET /dashboard/operations"] = opsBody({ cheques: { state: "denied" } });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(tile(page, "شیفت صندوق")).toBeVisible();
    await expect(tile(page, "ماندهٔ مشتریان")).toBeVisible();
    await expect(tile(page, "سررسید چک")).toHaveCount(0);
    await expect(section(page)).not.toContainText("سررسیدگذشته");
  });

  test("without treasury access the cheque tile stays but its link is not offered", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "treasury.manage" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(tile(page, "سررسید چک")).toBeVisible();
    await expect(tile(page, "سررسید چک").getByRole("link")).toHaveCount(0);
    await expect(tile(page, "ماندهٔ مشتریان").getByRole("link", { name: "دریافتنی و پرداختنی" })).toBeVisible();
  });

  test("low stock: exact count per selling warehouse and a link to the same list for this branch; zero is calm and has no link", async ({ page, api }) => {
    api.defaults["GET /dashboard/operations"] = opsBody({ lowStock: { state: "ready", threshold: "2", total: 7, warehouses: [
      { id: "w2", name: "انبار پشتیبان", count: 2 }, { id: "w1", name: "قفسه فروشگاه", count: 5 }] } });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    const low = tile(page, "کمبود موجودی");
    await expect(low).toContainText("۷ مورد به آستانهٔ 2 یا کمتر رسیده");
    await expect(low.locator('.ops-verdict [data-state="warning"]')).toHaveCount(1);
    await expect(low.locator(".ops-row").filter({ hasText: "قفسه فروشگاه" })).toContainText("۵ مورد");
    await expect(low.locator(".ops-row").filter({ hasText: "انبار پشتیبان" })).toContainText("۲ مورد");
    await expect(low.getByRole("link", { name: "فهرست کمبود موجودی" }))
      .toHaveAttribute("href", "/?page=reports&reports.tab=lowstock&reports.branch=b1");

    api.defaults["GET /dashboard/operations"] = opsBody();
    await page.reload();
    await expect(tile(page, "کمبود موجودی")).toContainText("موردی به آستانهٔ 2 نرسیده");
    await expect(tile(page, "کمبود موجودی").getByRole("link")).toHaveCount(0);
  });

  test("low stock with no threshold is “unknown”, never zero; denied low stock is hidden", async ({ page, api }) => {
    api.defaults["GET /dashboard/operations"] = opsBody({ lowStock: { state: "unknown", reason: "آستانهٔ کمبود موجودی تعریف نشده است." } });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    const low = tile(page, "کمبود موجودی");
    await expect(low).toContainText("شمار کمبود معلوم نیست");
    await expect(low).toContainText("این به معنای «کمبودی نیست» نیست");
    await expect(low).not.toContainText("موردی به آستانه");
    await expect(low.getByRole("link")).toHaveCount(0);

    api.defaults["GET /dashboard/operations"] = opsBody({ lowStock: { state: "denied" } });
    await page.reload();
    await expect(tile(page, "ماندهٔ مشتریان")).toBeVisible();
    await expect(tile(page, "کمبود موجودی")).toHaveCount(0);
  });

  test("everything denied hides the card; no report.view sends nothing", async ({ page, api }) => {
    api.defaults["GET /dashboard/operations"] = opsBody({ shifts: { state: "denied" }, cheques: { state: "denied" }, receivables: { state: "denied" }, lowStock: { state: "denied" } });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect.poll(() => opsCalls(api).length).toBe(1);
    // طرح ۱۰: شاخص‌ها در «نمای کلی»‌اند؛ لنگر بارشدن صفحه سرعنوان داشبورد است که در هر زبانه هست.
    await expect(page.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible();
    await expect(section(page)).toHaveCount(0);
  });

  test("no report.view: the card is not rendered and nothing is requested", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "report.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    // طرح ۱۰: شاخص‌ها در «نمای کلی»‌اند؛ لنگر بارشدن صفحه سرعنوان داشبورد است که در هر زبانه هست.
    await expect(page.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible();
    // کنترل منفیِ معنادار (طرح ۱۰): نوار زبانه‌های داشبورد از همان پاسخ دسترسی ساخته می‌شود. وقتی زبانهٔ
    // «همگام‌سازی سایت» (allow) هست و «عملیات روزانه» (deny) نیست، دسترسی رسیده و این بخش هرگز mount نمی‌شود.
    const dashTabs = page.getByRole("tablist", { name: "بخش‌های داشبورد" });
    await expect(dashTabs.getByRole("tab", { name: "همگام‌سازی سایت" })).toBeVisible();
    await expect(dashTabs.getByRole("tab", { name: "عملیات روزانه" })).toHaveCount(0);
    // نشانیِ زبانهٔ ممنوع به «نمای کلی» برمی‌گردد.
    await expect(dashTabs.getByRole("tab", { name: "نمای کلی" })).toHaveAttribute("aria-selected", "true");
    await expect(section(page)).toHaveCount(0);
    expect(opsCalls(api)).toEqual([]);
  });

  test("a failed first read says so with a reference — not “nothing to do”", async ({ page, api }) => {
    api.handlers.set("GET /dashboard/operations", async route => {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-o1" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    await expect(section(page)).toContainText("کارهای عملیاتی خوانده نشد");
    await expect(section(page)).toContainText("req-o1");
    await expect(section(page)).toContainText("این به معنای «کاری نیست» نیست");
  });

  test("refresh re-reads the card; a failed refresh keeps the last numbers and the page is never fresh; a late older answer never wins", async ({ page, api }) => {
    let releaseFirst!: () => void;
    const held = new Promise<void>(r => { releaseFirst = r; });
    let n = 0;
    api.handlers.set("GET /dashboard/operations", async (route: Route) => {
      const mine = ++n;
      if (mine === 1) {
        await held;
        await route.fulfill({ json: opsBody() }).catch(() => {});
        return;
      }
      if (mine === 2) { await route.fulfill({ json: busy }); return; }
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-o9" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=ops");
    const refresh = page.getByRole("button", { name: /به‌روزرسانی/ });
    await expect(refresh).toBeEnabled();
    await expect.poll(() => n).toBe(1);
    await refresh.click();
    await expect.poll(() => n).toBe(2);
    await expect(tile(page, "شیفت صندوق")).toContainText("از روز کاری قبل باز مانده");
    releaseFirst();
    await expect(tile(page, "شیفت صندوق")).toContainText("نمونهٔ ۲ از ۳");
    await expect(tile(page, "شیفت صندوق")).not.toContainText("۱ شیفت باز");

    await expect(refresh).toBeEnabled();
    await refresh.click();
    const freshness = page.locator(".freshness");
    await expect(freshness).toHaveAttribute("data-state", "failed");
    await expect(freshness).toContainText("req-o9");
    await expect(tile(page, "شیفت صندوق")).toContainText("نمونهٔ ۲ از ۳");
    expect(n).toBe(3);
  });
});
