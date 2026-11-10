/**
 * WP4 دستهٔ ۴ — زبانهٔ حرکت پول خزانه مثل طرح ۱۰.
 *
 * «شیفت‌ها و کشوها» (موجودی اول، انتظار نقد، شمرده، مغایرت)، «حرکت‌های نقد غیرفروشی امروز» و
 * «پایانه‌ها و تسویه» (کارمزد، تسویه، درایور). همهٔ عددها از پاسخ سرور؛ پیش از شمارش «پس از شمارش»
 * نه صفر؛ بی `report.view` بخش کشوها نیست؛ بی `settings.view` کارمزد «—» است نه صفر.
 */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const DRAWERS = {
  businessDate: "2026-09-16", shiftsVisible: true,
  shifts: [
    { id: "s1", userName: "سارا کریمی", openedAt: "2026-09-16T04:25:00Z", closedAt: null, status: "open", carriedOver: false,
      openingCash: "20000000", expectedCash: "72900000", countedCash: null, variance: null },
    { id: "s2", userName: "علی نوری", openedAt: "2026-09-16T05:30:00Z", closedAt: "2026-09-16T11:35:00Z", status: "closed", carriedOver: false,
      openingCash: "20000000", expectedCash: "24500000", countedCash: "24300000", variance: "-200000" },
    { id: "s3", userName: "سارا کریمی", openedAt: "2026-09-15T04:20:00Z", closedAt: "2026-09-15T18:10:00Z", status: "closed", carriedOver: false,
      openingCash: "20000000", expectedCash: "98700000", countedCash: "98700000", variance: "0" },
  ],
  moves: [
    { id: "m1", occurredAt: "2026-09-16T08:00:00Z", drawerName: "سارا کریمی", purpose: "expense", note: "کرایهٔ پیک — ارسال اینستاگرام",
      createdByName: "مدیر فروشگاه", counterpartCode: "6102", counterpartName: "هزینه حمل و ارسال", drawerAmount: "-1800000" },
    { id: "m2", occurredAt: "2026-09-16T11:35:00Z", drawerName: "علی نوری", purpose: "transfer", note: "واریز به بانک — بستن شیفت",
      createdByName: "علی نوری", counterpartCode: "1102", counterpartName: "بانک — حساب جاری", drawerAmount: "-15000000" },
    { id: "m3", occurredAt: "2026-09-16T12:00:00Z", drawerName: null, purpose: "capital", note: null,
      createdByName: "مدیر فروشگاه", counterpartCode: null, counterpartName: null, drawerAmount: "500000" },
  ],
};
const ACCOUNTS = [
  { id: "t1", code: "POS-1", name: "کارت‌خوان سامان — پیشخوان", kind: "card_terminal", branchId: "b1", ledgerAccountCode: "1103", isActive: true },
  { id: "t2", code: "GW-1", name: "درگاه سایت — زرین‌پال", kind: "gateway", branchId: null, ledgerAccountCode: "1104", isActive: true },
];
const TERMS = { terms: [
  { id: "t1", code: "POS-1", name: "کارت‌خوان سامان — پیشخوان", kind: "card_terminal", feePercent: "0.250", settlementDays: 1, canEdit: false },
  { id: "t2", code: "GW-1", name: "درگاه سایت — زرین‌پال", kind: "gateway", feePercent: "1.000", settlementDays: 2, canEdit: false },
] };
const DRIVERS = { terminals: [
  { accountId: "t1", accountCode: "POS-1", accountName: "کارت‌خوان سامان — پیشخوان", kind: "card_terminal", driverCode: null, driverLabel: null,
    vendor: null, sdkDocUrl: null, isImplemented: null, driverConfig: {}, canEdit: false },
  { accountId: "t2", accountCode: "GW-1", accountName: "درگاه سایت — زرین‌پال", kind: "gateway", driverCode: "zarinpal", driverLabel: "زرین‌پال",
    vendor: "زرین‌پال", sdkDocUrl: null, isImplemented: false, driverConfig: {}, canEdit: false },
] };

const cells = (page: Page, table: string, rowText: string) =>
  page.getByRole("table", { name: table }).locator("tbody tr").filter({ hasText: rowText }).first().locator("td");

test.describe("خزانه — کشوها، نقد امروز و پایانه‌ها (طرح ۱۰)", () => {
  test.beforeEach(async ({ api }) => {
    api.defaults["GET /treasury/drawers"] = DRAWERS;
    api.defaults["GET /treasury/accounts"] = { accounts: ACCOUNTS };
    api.defaults["GET /settlement-terms"] = TERMS;
    api.defaults["GET /terminal-drivers"] = DRIVERS;
  });

  test("shifts: opening, expected, counted and variance from the server; open drawers say 'after counting', not zero", async ({ page, api }) => {
    await page.goto("/?page=treasury&treasury.tab=cash");
    await expect(page.getByRole("heading", { name: "شیفت‌ها و کشوها" })).toBeVisible();
    const table = page.getByRole("table", { name: "شیفت‌ها و کشوهای امروز و دیروز" });
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["کشو", "وضعیت", "موجودی اول", "انتظار نقد", "شمرده‌شده", "مغایرت"]);
    const open = cells(page, "شیفت‌ها و کشوهای امروز و دیروز", "سارا کریمی");
    await expect(open.nth(1)).toContainText("باز");
    await expect(open.nth(3)).toContainText("7٬290٬000");
    await expect(open.nth(4)).toHaveText("—");
    await expect(open.nth(5)).toHaveText("پس از شمارش");
    const short = cells(page, "شیفت‌ها و کشوهای امروز و دیروز", "علی نوری");
    await expect(short.nth(1)).toContainText("بسته");
    await expect(short.nth(5)).toContainText("−20٬000");
    await expect(short.nth(5).locator("[data-tone]")).toHaveAttribute("data-tone", "crit");
    const exact = page.getByRole("table", { name: "شیفت‌ها و کشوهای امروز و دیروز" }).locator("tbody tr").nth(2).locator("td");
    await expect(exact.nth(5)).toHaveText("ندارد");
    expect(api.calls).toContain("GET /treasury/drawers?branchId=b1");
  });

  test("today's non-sale cash: signed from the drawer's side, counterpart account, who recorded it; a drawer move without a shift is flagged", async ({ page }) => {
    await page.goto("/?page=treasury&treasury.tab=cash");
    const table = page.getByRole("table", { name: "حرکت‌های نقد غیرفروشی امروز" });
    await expect(table).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim())).toEqual(["ساعت", "کشو", "شرح", "طرف حساب", "مبلغ"]);
    const pik = cells(page, "حرکت‌های نقد غیرفروشی امروز", "کرایهٔ پیک");
    await expect(pik.nth(1)).toHaveText("سارا کریمی");
    await expect(pik.nth(2)).toContainText("ثبت‌شده: مدیر فروشگاه");
    await expect(pik.nth(3)).toContainText("6102");
    await expect(pik.nth(3)).toContainText("هزینه حمل و ارسال");
    await expect(pik.nth(4)).toContainText("−180٬000");
    const loose = table.locator("tbody tr").nth(2).locator("td");
    await expect(loose.nth(1)).toContainText("بی شیفت");
    await expect(loose.nth(2)).toContainText("آورده نقدی");
    await expect(loose.nth(4)).toContainText("50٬000");
    await expect(loose.nth(4)).not.toContainText("−");
  });

  test("terminals: fee, settlement days and driver from the settings routes; without settings.view they are unknown, never zero", async ({ page, api }) => {
    await page.goto("/?page=treasury&treasury.tab=cash");
    const pos = cells(page, "پایانه‌ها و تسویه", "کارت‌خوان سامان");
    await expect(pos.nth(1)).toHaveText("1103");
    await expect(pos.nth(2)).toHaveText("0.250٪");
    await expect(pos.nth(3)).toHaveText("۱ روز");
    await expect(pos.nth(4)).toHaveText("دستی (درایور ثبت‌نشده)");
    const gw = cells(page, "پایانه‌ها و تسویه", "درگاه سایت");
    await expect(gw.nth(4)).toContainText("زرین‌پال");
    await expect(gw.nth(4)).toContainText("پیاده‌نشده");
    expect(api.calls).toContain("GET /settlement-terms");
    expect(api.calls).toContain("GET /auth/can?operation=settings.view");

    api.calls.length = 0;
    api.handlers.set("GET /auth/can", async route => {
      const op = new URL(route.request().url()).searchParams.get("operation");
      await route.fulfill({ json: { verdict: op === "settings.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.reload();
    const denied = cells(page, "پایانه‌ها و تسویه", "کارت‌خوان سامان");
    await expect(denied.nth(2)).toContainText("—");
    await expect(denied.nth(2)).toContainText("بدون دسترسی به تنظیمات پایانه");
    await expect(denied.nth(2)).not.toContainText("0");
    expect(api.calls).not.toContain("GET /settlement-terms");
    expect(api.calls).not.toContain("GET /terminal-drivers");
  });

  test("without report.view the drawers section is absent (not 'no drawers'); today's cash moves stay", async ({ page, api }) => {
    api.defaults["GET /treasury/drawers"] = { ...DRAWERS, shiftsVisible: false, shifts: null };
    await page.goto("/?page=treasury&treasury.tab=cash");
    await expect(page.getByRole("table", { name: "حرکت‌های نقد غیرفروشی امروز" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "شیفت‌ها و کشوها" })).toHaveCount(0);
    await expect(page.getByText("امروز و دیروز کشویی باز نشده.")).toHaveCount(0);
  });

  test("a failed read says so and retries; it never shows an empty drawer list", async ({ page, api }) => {
    let fail = true;
    api.handlers.set("GET /treasury/drawers", async route => {
      if (fail) { await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطا" } } }); return; }
      await route.fulfill({ json: DRAWERS });
    });
    await page.goto("/?page=treasury&treasury.tab=cash");
    await expect(page.getByRole("alert").filter({ hasText: "کشوها و حرکت‌های نقد امروز خوانده نشدند." })).toBeVisible();
    await expect(page.getByText("امروز حرکت نقدی غیرفروشی ثبت نشده.")).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "تلاش دوباره" }).click();
    await expect(page.getByRole("table", { name: "شیفت‌ها و کشوهای امروز و دیروز" })).toBeVisible();
  });
});
