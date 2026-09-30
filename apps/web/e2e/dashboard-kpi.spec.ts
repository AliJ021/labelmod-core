/**
 * زبانه‌های شاخص داشبورد — فروش · وجه دریافتی · سود (مهاجرت ۰۸۳).
 *
 * رفتار واقعی، نه تصویر: انتخاب، نشانگر، پنل مشترک، کیبورد RTL، یک درخواست
 * برای هر سه روند، سود نامعلوم بی نشت، خالی ≠ صفر ≠ نامعلوم، منفی با علامت، و
 * چیدمان در هشت عرض. داده از `DEFAULT_HOURLY` است که با کارت‌ها آشتی دارد.
 * هیچ `sleep`؛ «در حال بارگذاری» با نگه‌داشتن صریح پاسخ ساخته می‌شود.
 */
import { test, expect, fontsReady, hourlyDay, type MockApi } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

const tablist = (page: Page) => page.getByRole("tablist", { name: "شاخص‌های امروز" });
const tab = (page: Page, name: string) => tablist(page).getByRole("tab", { name, exact: true });
/** پنل مشترک زیر نوار شاخص (پوسته هم پنل زبانهٔ «داشبورد» دارد). */
const panel = (page: Page) => page.locator(".today [role=tabpanel]");
const TITLE: Record<string, string> = { "فروش": "روند فروش ساعتی", "وجه دریافتی": "روند وجه دریافتی ساعتی", "سود": "روند سود ساعتی" };
const hourlyCalls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /reports/daily/hourly")).length;
/** نشانگر طلایی: شبه‌عنصر `::before`؛ فقط زبانهٔ انتخاب‌شده آن را پیدا دارد. */
const indicator = (t: Locator) => t.evaluate(el => Number(getComputedStyle(el, "::before").opacity));

async function expectSelected(page: Page, name: string) {
  for (const n of ["فروش", "وجه دریافتی", "سود"]) {
    await expect(tab(page, n)).toHaveAttribute("aria-selected", String(n === name));
  }
  // نشانگر با انتخاب جابه‌جا می‌شود و روی زبانهٔ قبلی نمی‌ماند (پس از گذار کوتاه).
  for (const n of ["فروش", "وجه دریافتی", "سود"]) {
    await expect.poll(() => indicator(tab(page, n)), { message: `indicator on ${n}` }).toBe(n === name ? 1 : 0);
  }
  // هر سه زبانه همان پنل را کنترل می‌کنند؛ نام پنل عنوان شاخص انتخاب‌شده است — نه متن زبانه با مبلغ.
  const panelId = (await panel(page).getAttribute("id"))!;
  for (const n of ["فروش", "وجه دریافتی", "سود"]) await expect(tab(page, n)).toHaveAttribute("aria-controls", panelId);
  await expect(page.getByRole("tabpanel", { name: TITLE[name]!, exact: true })).toBeVisible();
}

test.describe("زبانه‌های شاخص داشبورد", () => {
  test("Sales first; Received and Profit switch the one shared panel; the data is fetched once", async ({ page, api }) => {
    await page.goto("/");
    await expect(tablist(page).getByRole("tab")).toHaveText([/^فروش/, /^وجه دریافتی/, /^سود/]);
    await expectSelected(page, "فروش");
    await expect(panel(page).getByRole("heading", { name: "روند فروش ساعتی" })).toBeVisible();
    await expect(panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" })).toBeVisible();
    // نام زبانه فقط برچسب است؛ عدد شاخص خوانده می‌شود ولی نام را عوض نمی‌کند.
    await expect(tab(page, "فروش")).toContainText("1٬234٬000");
    expect(hourlyCalls(api)).toBe(1);

    await tab(page, "وجه دریافتی").click();
    await expectSelected(page, "وجه دریافتی");
    await expect(panel(page).getByRole("heading", { name: "روند وجه دریافتی ساعتی" })).toBeVisible();
    const received = panel(page).getByRole("figure", { name: "وجه دریافتی هر ساعت (تومان)" });
    await expect(received).toBeVisible();
    await expect(panel(page)).not.toContainText("فروش هر ساعت");
    await expect(page.getByRole("heading", { name: "روند فروش ساعتی" })).toHaveCount(0);
    // ساعت ۲۰: بازپرداخت، منفی با علامت.
    await expect(received.locator("table tbody tr").filter({ hasText: "۲۰" })).toContainText("−50٬000 تومان");

    await tab(page, "سود").click();
    await expectSelected(page, "سود");
    await expect(panel(page).getByRole("heading", { name: "روند سود ساعتی" })).toBeVisible();
    const profit = panel(page).getByRole("figure", { name: "سود هر ساعت (تومان)" });
    await expect(profit).toContainText("بیشترین سود: ساعت ۱۸ با 200٬000 تومان");
    await expect(profit).toContainText("کمترین: ساعت ۲۰ با −50٬000 تومان");
    await expect(profit.locator(".bar-chart-bar--negative")).toHaveCount(1);
    await expect(panel(page)).not.toContainText("روند فروش");

    await tab(page, "فروش").click();
    await expectSelected(page, "فروش");
    expect(hourlyCalls(api), "switching tabs never refetches").toBe(1);
  });

  test("keyboard: manual activation, RTL arrows, Home/End, Enter and Space; only the active tab is in Tab order", async ({ page, api }) => {
    await page.goto("/");
    await expect(panel(page).getByRole("figure")).toBeVisible();
    await expect(tab(page, "فروش")).toHaveAttribute("tabindex", "0");
    await expect(tab(page, "وجه دریافتی")).toHaveAttribute("tabindex", "-1");
    await tab(page, "فروش").focus();
    // RTL: پیکان چپ یعنی زبانهٔ بعدی. حرکت فوکوس انتخاب نمی‌کند.
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "وجه دریافتی")).toBeFocused();
    await expect(tab(page, "فروش")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expectSelected(page, "وجه دریافتی");
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "سود")).toBeFocused();
    await page.keyboard.press(" ");
    await expectSelected(page, "سود");
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "فروش"), "wraps to the first").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "سود"), "ArrowRight goes back in RTL").toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab(page, "فروش")).toBeFocused();
    await page.keyboard.press("End");
    await expect(tab(page, "سود")).toBeFocused();
    // فوکوس کیبورد دیده می‌شود.
    const outline = await tab(page, "سود").evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    expect(hourlyCalls(api)).toBe(1);
  });

  test("without cost.view Profit stays unknown: disabled tab with its reason, never selected, no profit anywhere in the DOM", async ({ page, api }) => {
    api.defaults["GET /reports/daily"] = { businessDate: "2026-09-16", salesAmount: "12340000", receivedAmount: "11000000", profitAmount: null, invoiceCount: 12, returnCount: 1 };
    api.defaults["GET /reports/daily/hourly"] = hourlyDay({
      11: { salesAmount: "4340000", receivedAmount: "4000000", invoiceCount: 5, paymentCount: 5 },
      18: { salesAmount: "9000000", receivedAmount: "7500000", invoiceCount: 7, paymentCount: 6 },
      20: { salesAmount: "-1000000", receivedAmount: "-500000", returnCount: 1, paymentCount: 1 },
    }, false);
    await page.goto("/");
    await expect(panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" })).toBeVisible();
    const profit = tab(page, "سود");
    await expect(profit).toHaveAttribute("aria-disabled", "true");
    await expect(profit).toContainText("—");
    await expect(profit).toContainText("برای دیدن سود، دسترسی بهای تمام‌شده لازم است");
    await expect(profit).not.toContainText(/\d/);
    await expect(profit, "aria-disabled is exposed as disabled").toBeDisabled();
    // کاربر واقعی هنوز می‌تواند رویش بزند؛ کلیک واقعی (بی بررسی آمادگی) انتخاب را عوض نمی‌کند.
    await profit.click({ force: true });
    await expectSelected(page, "فروش");
    await profit.focus();
    await page.keyboard.press("Enter");
    await expect(profit).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("heading", { name: "روند سود ساعتی" })).toHaveCount(0);
    // فروش و دریافتی مستقل می‌مانند.
    await tab(page, "وجه دریافتی").click();
    await expectSelected(page, "وجه دریافتی");
    // هیچ عددی از سود در DOM (حتی پنهان یا برای صفحه‌خوان) نیست.
    const html = await page.content();
    expect(html).not.toContain("سود هر ساعت");
    expect(html).not.toMatch(/پس از بهای تمام‌شده/);
  });

  test("empty day: metric-specific empty states; zero profit is 0, not unknown", async ({ page, api }) => {
    api.defaults["GET /reports/daily"] = { businessDate: "2026-09-16", salesAmount: "0", receivedAmount: "0", profitAmount: "0", invoiceCount: 0, returnCount: 0 };
    api.defaults["GET /reports/daily/hourly"] = hourlyDay();
    await page.goto("/");
    await expect(panel(page).getByText("هنوز فروشی برای امروز ثبت نشده است.", { exact: true })).toBeVisible();
    await tab(page, "وجه دریافتی").click();
    await expect(panel(page).getByText("هنوز وجهی برای امروز دریافت نشده است.", { exact: true })).toBeVisible();
    await expect(panel(page)).not.toContainText("فروشی");
    await tab(page, "سود").click();
    await expect(panel(page).getByText("هنوز فروشی برای امروز ثبت نشده که سودی داشته باشد.", { exact: true })).toBeVisible();
    // صفر معلوم است: «0» و بی آیکون هشدار؛ «—» مال نامعلوم است.
    await expect(tab(page, "سود")).not.toHaveAttribute("aria-disabled", "true");
    await expect(tab(page, "سود").locator(".money")).toContainText("0");
    await expect(tab(page, "سود")).not.toContainText("—");
  });

  test("credit sale: Sales has a chart, Received is empty — the two never merge", async ({ page, api }) => {
    api.defaults["GET /reports/daily"] = { businessDate: "2026-09-16", salesAmount: "1000000", receivedAmount: "0", profitAmount: "600000", invoiceCount: 1, returnCount: 0 };
    api.defaults["GET /reports/daily/hourly"] = hourlyDay({ 11: { salesAmount: "1000000", profitAmount: "600000", invoiceCount: 1 } });
    await page.goto("/");
    await expect(panel(page).getByRole("figure", { name: "فروش هر ساعت (تومان)" })).toContainText("بیشترین فروش: ساعت ۱۱ با 100٬000 تومان");
    await tab(page, "وجه دریافتی").click();
    await expect(panel(page).getByText("هنوز وجهی برای امروز دریافت نشده است.", { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("figure")).toHaveCount(0);
  });

  test("loading keeps the tabs usable; an error fails only the panel, the KPI values stay", async ({ page, api }) => {
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    let fail = true;
    api.handlers.set("GET /reports/daily/hourly", async route => {
      await held;
      if (fail) await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور" } } });
      else await route.fulfill({ json: hourlyDay() });
    });
    await page.goto("/");
    await expect(panel(page)).toHaveAttribute("aria-busy", "true");
    await tab(page, "وجه دریافتی").click();
    await expectSelected(page, "وجه دریافتی");
    await expect(panel(page).getByRole("heading", { name: "روند وجه دریافتی ساعتی" })).toBeVisible();
    release();
    await expect(panel(page).getByText("روند ساعتی خوانده نشد.")).toBeVisible();
    await expect(panel(page)).not.toHaveAttribute("aria-busy", "true");
    await expect(tab(page, "فروش")).toContainText("1٬234٬000");
    fail = false;
  });

  test("layout: three selectors side by side or stacked, never overlapping, no page overflow, panel below them", async ({ page }) => {
    for (const width of [320, 375, 390, 412, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(panel(page).getByRole("figure")).toBeVisible();
      await tab(page, "سود").click();
      await expectSelected(page, "سود");
      await fontsReady(page);
      const boxes = await Promise.all(["فروش", "وجه دریافتی", "سود"].map(async n => (await tab(page, n).boundingBox())!));
      for (const b of boxes) {
        expect(b.x, `${width}: tab inside viewport`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, `${width}: tab inside viewport`).toBeLessThanOrEqual(width + 1);
      }
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        const overlap = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
        expect(overlap, `${width}: tabs ${i} and ${j} overlap`).toBe(false);
      }
      const p = (await panel(page).boundingBox())!;
      expect(p.y, `${width}: panel below the selectors`).toBeGreaterThanOrEqual(Math.max(...boxes.map(b => b.y + b.height)) - 1);
      const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(size.scroll, `${width}: no page-level horizontal overflow`).toBeLessThanOrEqual(size.client);
    }
  });
});
