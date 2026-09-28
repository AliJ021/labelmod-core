/**
 * نظام طراحی — پوسته، ناوبری مجوزدار، داشبورد مرجع، عمل مالی ایمن و UI Kit.
 *
 * تصویرها **مرجع** بازبینی انسانی‌اند، نه مقایسهٔ پیکسلی: پایهٔ پیکسلی پیش
 * از تأیید جهت بصری معنایی ندارد (docs/DESIGN_SYSTEM.md، «رگرسیون بصری»).
 * همه با اندازهٔ واقعی نمایشگر گرفته می‌شوند، نه fullPage.
 */
import { test, expect, fontsReady } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const ZONE_LABELS = ["داشبورد", "صندوق", "فاکتورها", "مرجوعی", "کالا و قیمت", "انبار و خرید", "خزانه و چک", "مشتریان", "گزارش‌ها", "تنظیمات"];
const GROUPS = ["کار روزانه", "کالا و انبار", "مالی و گزارش", "اشخاص", "سامانه"];

async function noOverflow(page: Page, what: string) {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll, `${what} must not scroll horizontally`).toBeLessThanOrEqual(size.client);
}
async function reference(page: Page, name: string) {
  await fontsReady(page);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}
const compact = (page: Page) => page.viewportSize()!.width < 900;

test("app shell renders one taxonomy: grouped sidebar or bottom bar plus grouped sheet", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "امروز", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "ناوبری اصلی" });
  const list = nav.getByRole("tablist", { name: "بخش‌ها", exact: true });
  expect(await list.getByRole("tab", { includeHidden: true }).allInnerTexts()).toHaveLength(ZONE_LABELS.length);
  for (const label of ZONE_LABELS) await expect(list.getByRole("tab", { name: label, exact: true, includeHidden: true })).toHaveCount(1);
  if (!compact(page)) {
    for (const label of ZONE_LABELS) await expect(list.getByRole("tab", { name: label, exact: true })).toBeVisible();
    for (const group of GROUPS) await expect(nav.getByText(group, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "بخش‌های بیشتر" })).toBeHidden();
  } else {
    const visible = await list.getByRole("tab").count();
    expect(visible, "mobile bottom bar keeps 4–5 true primary destinations").toBeGreaterThanOrEqual(4);
    expect(visible).toBeLessThanOrEqual(5);
    for (const group of GROUPS) await expect(nav.getByText(group, { exact: true })).toBeHidden();
    const more = page.getByRole("button", { name: "بخش‌های بیشتر", exact: true });
    for (const target of [...await list.getByRole("tab").all(), more]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await reference(page, "shell-bottom-bar");
    await more.click();
    await expect(page.getByRole("button", { name: "بستن بخش‌های بیشتر" })).toHaveAttribute("aria-expanded", "true");
    for (const label of ZONE_LABELS) await expect(list.getByRole("tab", { name: label, exact: true })).toBeVisible();
    for (const group of GROUPS) await expect(nav.getByText(group, { exact: true })).toBeVisible();
    const sheet = (await nav.boundingBox())!, viewport = page.viewportSize()!;
    expect(sheet.y).toBeGreaterThanOrEqual(0);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(viewport.height + 1);
    await noOverflow(page, "open navigation sheet");
    await reference(page, "shell-more-sheet");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "بخش‌های بیشتر", exact: true })).toBeFocused();
    await expect(list.getByRole("tab", { name: "تنظیمات", exact: true })).toBeHidden();
  }
  for (const tab of await list.getByRole("tab").all()) {
    expect(await tab.locator("svg").count(), "each destination has its functional icon").toBe(1);
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await noOverflow(page, "shell");
  await reference(page, "shell");
});

test("navigation hides server-denied destinations but keeps the open section and personal settings", async ({ page, api }) => {
  const denied = new Set(["treasury.manage", "customer.manage", "report.view"]);
  api.handlers.set("GET /auth/can", async (route: Route, url: URL) => {
    const verdict = denied.has(url.searchParams.get("operation") ?? "") ? "deny" : "allow";
    await route.fulfill({ json: { verdict, approver: null, reason: "" } });
  });
  await page.goto("/");
  const list = page.getByRole("tablist", { name: "بخش‌ها", exact: true });
  await expect(list.getByRole("tab", { name: "خزانه و چک", includeHidden: true })).toHaveCount(0);
  await expect(list.getByRole("tab", { name: "مشتریان", includeHidden: true })).toHaveCount(0);
  await expect(list.getByRole("tab", { name: "گزارش‌ها", includeHidden: true })).toHaveCount(0);
  // PIN و ورود دومرحله‌ای شخصی در تنظیمات‌اند؛ داشبورد امروز برای همه باز است.
  await expect(list.getByRole("tab", { name: "تنظیمات", includeHidden: true })).toHaveCount(1);
  await expect(list.getByRole("tab", { name: "داشبورد", includeHidden: true })).toHaveCount(1);
  // سرور دروازه است: نشانی مستقیم هنوز بخش را باز می‌کند و زبانه‌اش دیده می‌شود.
  await page.goto("/?page=treasury");
  await expect(list.getByRole("tab", { name: "خزانه و چک", includeHidden: true })).toHaveAttribute("aria-selected", "true");
  // بی report.view، نمودار ساعتی ساخته نمی‌شود — نه صفر، نه خطا.
  api.handlers.set("GET /reports/hourly", async route => { await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "اجازه ندارید" } } }); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "نیاز به رسیدگی" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "روند فروش ساعتی" })).toHaveCount(0);
});

test("slash and Ctrl+K focus global search, never while typing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "امروز", exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "پیداکردن بخش یا ابزار" });
  await page.locator("main#workspace-content").focus();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("کالا/قیمت");
  await expect(search).toHaveValue("کالا/قیمت");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await page.locator("main#workspace-content").focus();
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
});

const unpostedRow = { branchId: "b1", invoiceCount: 12, payableAmount: "12340000", cogsAmount: "9000000" };

test("dashboard reference: Jalali date, human channel labels, three labelled KPIs and real hourly data", async ({ page, api }) => {
  api.defaults["GET /posting-batches/unposted"] = { rows: [
    { ...unpostedRow, batchId: "p1", batchKind: "shift", channel: "pos", businessDate: "2026-09-16" },
    { ...unpostedRow, batchId: "p2", batchKind: "channel_day", channel: "web", businessDate: "2026-09-15" },
  ] };
  api.defaults["GET /reports/hourly"] = { rows: [
    { businessDate: "2026-09-16", hourOfDay: 11, channel: "pos", invoiceCount: 2, itemQty: "3", netAmount: "2000000" },
    { businessDate: "2026-09-16", hourOfDay: 18, channel: "pos", invoiceCount: 4, itemQty: "6", netAmount: "5000000" },
    { businessDate: "2026-09-16", hourOfDay: 18, channel: "web", invoiceCount: 1, itemQty: "1", netAmount: "1500000" },
  ] };
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "امروز", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("۲۵ شهریور ۱۴۰۵", { exact: false }).first()).toBeVisible();
  for (const label of ["فروش", "وجه دریافتی", "سود"]) await expect(page.getByRole("region", { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "فروش", exact: true })).toContainText("1٬234٬000");
  await expect(page.getByText("۱۲ فاکتور سایت در ۲۴ شهریور ۱۴۰۵ هنوز به دفتر نرفته")).toBeVisible();
  await expect(page.getByText("۱۲ فاکتور صندوق در ۲۵ شهریور ۱۴۰۵ هنوز به دفتر نرفته")).toBeVisible();
  expect(await page.locator("main").innerText(), "raw channel codes never reach the user").not.toMatch(/\b(pos|web)\b/);
  const chart = page.getByRole("figure", { name: "فروش خالص هر ساعت (تومان)" });
  await expect(chart).toBeVisible();
  // کانال‌ها در bigint جمع می‌شوند: ۵٬۰۰۰٬۰۰۰ + ۱٬۵۰۰٬۰۰۰ ریال = ۶۵۰٬۰۰۰ تومان.
  await expect(chart).toContainText("بیشترین فروش: ساعت ۱۸ با 650٬000 تومان");
  await expect(chart.getByRole("row", { includeHidden: true })).toHaveCount(16);
  await expect(page.locator("main .glass")).toHaveCount(0);
  await noOverflow(page, "dashboard");
  await reference(page, "dashboard");
});

async function openClose(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "بستن دوره", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /بستن دورهٔ سایت/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1٬234٬000");
  await expect(dialog).toContainText("فقط با سند معکوس");
  return dialog;
}

test("safe financial action: confirmation, locked pending state and a verified success", async ({ page, api }) => {
  let rows = [{ ...unpostedRow, batchId: "p2", batchKind: "channel_day", channel: "web", businessDate: "2026-09-15" }];
  api.handlers.set("GET /posting-batches/unposted", async route => { await route.fulfill({ json: { rows } }); });
  let pending: Route | undefined;
  const posts: unknown[] = [];
  api.handlers.set("POST /posting-batches/close-channel-day", async route => { posts.push(route.request().postDataJSON()); pending = route; });
  const dialog = await openClose(page);
  expect(posts, "opening the confirmation never posts").toHaveLength(0);
  await reference(page, "safe-action-confirm");
  await dialog.getByRole("button", { name: "بستن دوره و ثبت در دفتر" }).click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(dialog.getByRole("button", { name: "در حال بستن…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "انصراف" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog, "a pending financial action cannot be dismissed").toBeVisible();
  rows = [];
  await pending!.fulfill({ json: { batchId: "p2", saleEntry: "e1", cogsEntry: "e2", replayed: false } });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "بسته شد" })).toContainText("دورهٔ سایت در ۲۴ شهریور ۱۴۰۵ بسته شد.");
  expect(posts).toEqual([{ branchId: "b1", channel: "web", date: "2026-09-15" }]);
  await expect(page.getByText("همه درآمدها به دفتر رفته‌اند")).toBeVisible();
});

test("unknown financial result offers status verification, never a blind resend", async ({ page, api }) => {
  const row = { ...unpostedRow, batchId: "p2", batchKind: "channel_day", channel: "web", businessDate: "2026-09-15" };
  api.defaults["GET /posting-batches/unposted"] = { rows: [row] };
  let posts = 0;
  api.handlers.set("POST /posting-batches/close-channel-day", async route => { posts++; await route.abort("connectionreset"); });
  const dialog = await openClose(page);
  await dialog.getByRole("button", { name: "بستن دوره و ثبت در دفتر" }).click();
  await expect(dialog.getByRole("alert")).toContainText("نتیجه نامعلوم");
  await expect(dialog.getByRole("button", { name: "بستن دوره و ثبت در دفتر" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "بررسی وضعیت" })).toBeVisible();
  await reference(page, "safe-action-unknown");
  // بستن پنجره وضعیت را نامعلوم نگه می‌دارد؛ دکمهٔ سطر دیگر «اجرا» نیست.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" })).toBeVisible();
  await expect(page.getByRole("button", { name: "بستن دوره", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
  await dialog.getByRole("button", { name: "بررسی وضعیت" }).click();
  // سرور می‌گوید دوره هنوز باز است: حالا تأیید با وضعیت معلوم مجاز است.
  await expect(dialog.getByRole("status")).toContainText("انجام نشده");
  await expect(dialog.getByRole("button", { name: "بستن دوره و ثبت در دفتر" })).toBeEnabled();
  expect(posts, "verification never re-sends the action").toBe(1);
});

test("UI kit shows every primitive section in both themes without overflow and honours reduced motion", async ({ page }) => {
  await page.goto("/dev/ui-kit");
  await expect(page.getByRole("heading", { name: "UI Kit لیبل مد", level: 1 })).toBeVisible();
  const sections = page.getByRole("tablist", { name: "بخش‌های UI Kit" });
  const names = await sections.getByRole("tab").allInnerTexts();
  expect(names.length).toBe(9);
  for (const name of names) {
    await sections.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tabpanel", { name })).toBeVisible();
    await noOverflow(page, `UI kit ${name}`);
  }
  await sections.getByRole("tab", { name: "پایه", exact: true }).click();
  await reference(page, "ui-kit-foundation");
  await sections.getByRole("tab", { name: "عدد و متن", exact: true }).click();
  await reference(page, "ui-kit-numbers");
  await sections.getByRole("tab", { name: "جدول و نمودار", exact: true }).click();
  await expect(page.getByRole("region", { name: "فاکتورهای نمونه" })).toBeVisible();
  await reference(page, "ui-kit-data");
  await sections.getByRole("tab", { name: "لایه‌ها و عمل مالی", exact: true }).click();
  const opener = page.getByRole("button", { name: "باز کردن Dialog" });
  await opener.click();
  await expect(page.getByRole("dialog", { name: "تغییر شعبهٔ پیش‌فرض" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener, "dialog returns focus to its opener").toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sections.getByRole("tab", { name: "حرکت و جلوه", exact: true }).click();
  await expect(page.locator(".kit-motion.m-rise").first()).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "پخش دوباره" }).click();
  await expect(page.locator(".kit-motion.m-rise").first()).not.toHaveCSS("animation-name", "none");
  // تم مخالف همان صفحه: هر دو تم در هر پروژه دیده می‌شوند.
  await sections.getByRole("tab", { name: "پایه", exact: true }).click();
  const scheme = test.info().project.use.colorScheme;
  await page.getByRole("radio", { name: scheme === "dark" ? "روشن" : "تیره", exact: true }).check({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme === "dark" ? "light" : "dark");
  await noOverflow(page, "UI kit opposite theme");
  await reference(page, "ui-kit-opposite-theme");
});

test("reference screens: login, settings and reports keep the new shell without overflow", async ({ page, api }) => {
  for (const [url, heading, name] of [
    ["/?page=settings", "بخش تنظیمات", "settings"],
    ["/?page=reports", "گزارش‌ها", "reports"],
  ] as const) {
    await page.goto(url);
    await expect(page.locator(".settings-nav, [role=tablist][aria-label='" + heading + "']").first()).toBeVisible();
    await noOverflow(page, name);
    await reference(page, name);
  }
  api.handlers.set("GET /auth/me", async route => { await route.fulfill({ status: 401, json: { error: { code: "no_session", message: "وارد نشده‌اید" } } }); });
  await page.goto("/");
  await expect(page.getByLabel("نام کاربری", { exact: true })).toBeVisible();
  await noOverflow(page, "login");
  await reference(page, "login");
});
