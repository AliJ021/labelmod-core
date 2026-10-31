/**
 * همگام‌سازی سایت در داشبورد (دستهٔ C، مصوب مالک): دو جهت جدا با شمار دقیق هر حالت، «نامعلوم» هرگز
 * صفر یا سبز نیست، نمونه با «N از کل»، و هیچ کنترل ارسال دوباره‌ای. فقط با `settings.view`.
 * هیچ sleep؛ پاسخ کهنه با نگه‌داشتن صریح ساخته می‌شود.
 */
import { test, expect, syncBody, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const section = (page: Page) => page.getByRole("region", { name: "همگام‌سازی سایت" });
const core = (page: Page) => section(page).getByRole("region", { name: /^Core → سایت/ });
const woo = (page: Page) => section(page).getByRole("region", { name: /^سایت → Core/ });
const syncCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /dashboard/stock-sync"));
/** سطر جدول شمار هر جهت (نه جدول نمونه، که همان برچسب وضعیت را هم دارد). */
const row = (scope: ReturnType<typeof core>, label: string) =>
  scope.getByRole("table", { name: /به تفکیک وضعیت/ }).getByRole("row").filter({ hasText: label });

const busy = syncBody({
  core: {
    counts: { due: 3, scheduled: 1, retrying: 2, running: 1, leaseExpired: 1, deadExhausted: 1, deadRejected: 1 },
    oldestOpenSeconds: 1900,
    sample: { total: 5, items: [
      { id: "9001", topic: "web.stock_push", state: "deadRejected", attempts: 1, ageSeconds: 7200, hasError: true },
      { id: "9002", topic: "web.instore_push", state: "leaseExpired", attempts: 1, ageSeconds: 1900, hasError: false },
    ] },
  },
  woo: { state: "known", backend: "action-scheduler", fetchedAt: "2026-09-16T08:00:00.000Z",
    counts: { due: null, scheduled: null, running: null, deferred: 1, busy: 0, stoppedTasks: 0, failedRows: 4 } },
});

test.describe("همگام‌سازی سایت در داشبورد", () => {
  test("two directions, each state counted on its own; unreported counts are “—” not 0; sample is labelled N of total; no replay control", async ({ page, api }) => {
    api.defaults["GET /dashboard/stock-sync"] = busy;
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    await expect(section(page)).toBeVisible();
    await expect(core(page)).toContainText("۲ پیام متوقف شده و خودکار دوباره فرستاده نمی‌شود");
    await expect(row(core(page), "در صف")).toContainText("۳");
    await expect(row(core(page), "در حال ارسال")).toContainText("۱");
    await expect(row(core(page), "در انتظار تلاش دوباره")).toContainText("۲");
    // اجارهٔ منقضی (خرابی Worker) جدا از توقف؛ دو نوع توقف هم جدا.
    await expect(row(core(page), "اجارهٔ منقضی")).toContainText("خرابی، نه تصمیم");
    await expect(row(core(page), "متوقف: تلاش‌ها تمام شد")).toContainText("۱");
    await expect(row(core(page), "متوقف: رد قطعی")).toContainText("۱");
    await expect(core(page)).toContainText("نمونهٔ ۲ از ۵ پیام مشکل‌دار");
    await expect(core(page)).toContainText("خوراک دوره‌ای هر ۱۵ دقیقه");
    // کد خام موضوع به کاربر نمی‌رسد.
    await expect(core(page)).toContainText("خرید حضوری");
    await expect(core(page)).not.toContainText("web.");

    await expect(woo(page)).toContainText("بخشی از وضعیت صف را افزونه گزارش نکرد");
    await expect(woo(page)).not.toContainText("صف خالی است");
    await expect(row(woo(page), "در صف").locator(".sync-unknown")).toHaveText("—");
    await expect(row(woo(page), "در صف")).not.toContainText("۰");
    await expect(woo(page).locator(".sync-unknown")).toHaveCount(3);
    await expect(row(woo(page), "سطرهای ناموفق Action Scheduler")).toContainText("۴");
    await expect(row(woo(page), "سطرهای ناموفق Action Scheduler")).toContainText("نه شمار کارها");
    await expect(row(woo(page), "متوقف با شکست غیرمنتظره")).toContainText("توقف تجاری");

    await expect(section(page).getByRole("button")).toHaveCount(0);
    expect(syncCalls(api)).toEqual(["GET /dashboard/stock-sync"]);
  });

  test("site → Core unreadable: “unknown” with the reason, no counts at all, never “empty”", async ({ page, api }) => {
    api.defaults["GET /dashboard/stock-sync"] = syncBody({
      woo: { state: "unknown", code: "timeout", message: "سایت در مهلت پاسخ نداد.", fetchedAt: "2026-09-16T08:00:00.000Z" },
    });
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    await expect(woo(page)).toContainText("نامعلوم — سایت در مهلت پاسخ نداد.");
    await expect(woo(page)).toContainText("نبودِ گزارش به معنای «صف خالی» نیست");
    await expect(woo(page).getByRole("table")).toHaveCount(0);
    await expect(woo(page)).not.toContainText("صف خالی است");
    // جهت دیگر دانسته است و جدا می‌ماند.
    await expect(core(page)).toContainText("صف خالی است");
  });

  test("a failed first read says so with a reference — not an empty queue", async ({ page, api }) => {
    api.handlers.set("GET /dashboard/stock-sync", async route => {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-s1" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    await expect(section(page)).toContainText("وضعیت همگام‌سازی خوانده نشد");
    await expect(section(page)).toContainText("req-s1");
    await expect(section(page)).toContainText("به معنای «صف خالی» نیست");
    await expect(section(page).getByRole("table")).toHaveCount(0);
  });

  test("refresh re-reads the card; a failed refresh keeps the last counts and the page is never fresh; a late older answer never wins", async ({ page, api }) => {
    let releaseFirst!: () => void;
    const held = new Promise<void>(r => { releaseFirst = r; });
    let n = 0;
    api.handlers.set("GET /dashboard/stock-sync", async (route: Route) => {
      const mine = ++n;
      if (mine === 1) {
        // پاسخ بار اول تا پس از به‌روزرسانی نگه داشته می‌شود؛ رسیدنش نباید چیزی را بازنویسی کند.
        await held;
        await route.fulfill({ json: syncBody() }).catch(() => {});
        return;
      }
      if (mine === 2) { await route.fulfill({ json: busy }); return; }
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور", correlationId: "req-s9" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    const refresh = page.getByRole("button", { name: /به‌روزرسانی/ });
    await expect(refresh).toBeEnabled();
    await expect.poll(() => n).toBe(1);
    await refresh.click();
    await expect.poll(() => n).toBe(2);
    await expect(row(core(page), "در صف")).toContainText("۳");
    const freshness = page.locator(".freshness");
    await expect(freshness).not.toHaveAttribute("data-state", "failed");
    releaseFirst();
    await expect(core(page)).toContainText("۲ پیام متوقف شده");
    await expect(core(page)).not.toContainText("صف خالی است");

    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(freshness).toHaveAttribute("data-state", "failed");
    await expect(freshness).toContainText("req-s9");
    await expect(row(core(page), "در صف")).toContainText("۳");
    expect(n).toBe(3);
  });

  test("no settings.view: the section is not rendered and nothing is requested", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "settings.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    // طرح ۱۰: شاخص‌ها در «نمای کلی»‌اند؛ لنگر بارشدن صفحه سرعنوان داشبورد است که در هر زبانه هست.
    await expect(page.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible();
    // کنترل منفی (طرح ۱۰): زبانه‌ها از پاسخ دسترسی‌اند؛ «فروش و پرداخت» (allow) هست و «همگام‌سازی سایت» (deny) نه.
    const dashTabs = page.getByRole("tablist", { name: "بخش‌های داشبورد" });
    await expect(dashTabs.getByRole("tab", { name: "فروش و پرداخت" })).toBeVisible();
    await expect(dashTabs.getByRole("tab", { name: "همگام‌سازی سایت" })).toHaveCount(0);
    await expect(section(page)).toHaveCount(0);
    expect(syncCalls(api)).toEqual([]);
  });

  test("a server 403 hides the card (no zeros, no error)", async ({ page, api }) => {
    let n = 0;
    api.handlers.set("GET /dashboard/stock-sync", async route => {
      n += 1;
      await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "دسترسی ندارید", correlationId: "req-s4" } } });
    });
    await page.goto("/?page=dashboard&dashboard.tab=sync");
    await expect.poll(() => n).toBe(1);
    // زبانه همان «همگام‌سازی سایت» است؛ پاسخ ۴۰۳ کارت را پنهان می‌کند، نه صفر و نه خطا.
    await expect(page.getByRole("tab", { name: "همگام‌سازی سایت" })).toHaveAttribute("aria-selected", "true");
    await expect(section(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
