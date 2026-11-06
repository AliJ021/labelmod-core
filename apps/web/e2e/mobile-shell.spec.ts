/**
 * WP3 — سربرگ گوشی مثل طرح ۱۰ (تصمیم مالک، ۲۰۲۶/۱۱/۰۲).
 *
 * راست: ☰ و عنوان همین صفحه؛ چپ: جست‌وجو، نقطهٔ وضعیت اتصال، قفل و تم. حساب و خروج در سربرگ نیستند
 * و پای منوی ☰اند. ☰ همان برگهٔ مودال همهٔ بخش‌ها را باز می‌کند و فوکوس را به خودش برمی‌گرداند.
 * نوار پایین می‌ماند و فقط در صندوقِ گوشی پنهان است. دسکتاپ بی‌تغییر: ☰ ندارد.
 */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const header = (page: Page) => page.locator(".workspace-header");
const menuButton = (page: Page) => page.getByRole("button", { name: "بازکردن منو", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "همهٔ بخش‌ها" });
const bottomBar = (page: Page) => page.getByRole("navigation", { name: "ناوبری اصلی" });

test.describe("سربرگ و منوی گوشی (طرح ۱۰)", () => {
  test.beforeEach(async ({ page }) => {
    // سربرگ گوشی زیر ۹۰۰ پیکسل است؛ پروژهٔ پهن همین را در نمایشگر گوشی می‌سنجد، نه Skip.
    if (page.viewportSize()!.width >= 900) await page.setViewportSize({ width: 390, height: 844 });
  });

  test("header: menu and page title on the start side; search, status, lock and theme on the end side; no account or logout", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "نمای کلی امروز", exact: true })).toBeVisible();
    const h = header(page);
    await expect(menuButton(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-haspopup", "dialog");
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(h.locator(".shell-trail [aria-current=page]")).toHaveText("داشبورد");
    await expect(h.getByRole("button", { name: "قفل صفحه", exact: true })).toBeVisible();
    await expect(h.getByRole("button", { name: /^تم:/ })).toBeVisible();
    await expect(h.getByRole("searchbox", { name: "پیداکردن بخش یا ابزار" })).toBeVisible();
    await expect(h.locator(".server-fresh-dot")).toBeVisible();
    await expect(h.getByRole("button", { name: "خروج", exact: true })).toHaveCount(0);
    await expect(h.getByRole("button", { name: /^حساب / })).toHaveCount(0);
    // RTL: ☰ و عنوان در آغاز (راست)، قفل در پایان (چپ).
    const menu = (await menuButton(page).boundingBox())!, title = (await h.locator(".shell-trail").boundingBox())!;
    const lock = (await h.getByRole("button", { name: "قفل صفحه", exact: true }).boundingBox())!;
    expect(menu.x, "☰ rightmost").toBeGreaterThan(title.x);
    expect(title.x, "title right of the tools").toBeGreaterThan(lock.x);
    for (const b of [menu, lock]) { expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); }
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, "no horizontal overflow").toBeLessThanOrEqual(size.client);
  });

  test("menu opens the one sections sheet with brand, branch, account and logout; closing returns focus to the menu button", async ({ page, api }) => {
    await page.goto("/");
    await menuButton(page).click();
    const s = sheet(page);
    await expect(s).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(s.locator(".shell-brand")).toContainText("لیبل مد");
    await expect(s.locator(".shell-branch")).toContainText("شعبه آزمایشی");
    await expect(s.getByRole("link", { name: "خزانه و چک", exact: true })).toBeVisible();
    await expect(s.getByRole("button", { name: "حساب مدیر آزمایشی" })).toBeVisible();
    await expect(s.getByRole("button", { name: "خروج", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(s).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    // «بیشتر» نوار پایین همان برگه است و فوکوس به خودش برمی‌گردد، نه به ☰.
    const more = page.getByRole("button", { name: "بخش‌های بیشتر", exact: true });
    await more.click();
    await expect(s).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    // خروج از پای منو همان خروج است.
    await menuButton(page).click();
    await s.getByRole("button", { name: "خروج", exact: true }).click();
    await expect(page.getByLabel("نام کاربری", { exact: true })).toBeVisible();
    expect(api.calls).toContain("POST /auth/logout");
  });

  test("the POS on a phone hides the bottom bar; every section stays one tap away through the menu", async ({ page, api }) => {
    api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
    api.defaults["GET /shifts/current"] = { id: "s1", userId: "22222222-2222-4222-8222-222222222222", branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-09-16T05:00:00Z" };
    await page.goto("/");
    await expect(bottomBar(page)).toBeVisible();
    await page.goto("/?page=pos");
    await expect(page.locator(".workspace--pos-phone")).toHaveCount(1);
    await expect(bottomBar(page)).toBeHidden();
    await expect(header(page).locator(".shell-trail [aria-current=page]")).toHaveText("صندوق");
    const reserved = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bottom-nav-h").trim());
    expect(reserved, "no space reserved for a hidden bar").toBe("0px");
    await menuButton(page).click();
    await sheet(page).getByRole("link", { name: "فاکتورها", exact: true }).click();
    await expect(page).toHaveURL(/page=invoices/);
    await expect(bottomBar(page)).toBeVisible();
  });
});

test("desktop keeps the sidebar: no menu button, account and logout in the sidebar footer", async ({ page }) => {
  if (page.viewportSize()!.width < 900) await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "نمای کلی امروز", exact: true })).toBeVisible();
  await expect(menuButton(page)).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "ناوبری اصلی" });
  await expect(nav.getByRole("button", { name: "حساب مدیر آزمایشی" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "خروج", exact: true })).toBeVisible();
  await expect(header(page).getByRole("button", { name: "خروج", exact: true })).toHaveCount(0);
});
