/**
 * WP4 مرجوعی — چیدمان طرح ۱۰، بی تغییر رفتار.
 *
 * - دو ستون «۱. فاکتور و اقلام برگشتی» و «۲. حساب مرجوعی»؛ پیش از بارشدن فاکتور فقط ستون یک.
 * - اقلام در جدول: کالا، فروخته، بهای همان فروش، برگشتی، وضعیت کالا («—» تا انتخاب نشده).
 * - مهلت از `windowHours` سرور (همان تنظیمی که «دیرهنگام» را تعیین می‌کند)؛ پاسخ قدیمی‌تر
 *   فقط ساعت گذشته را می‌گوید و عددی برای مهلت نمی‌سازد.
 * - هیچ مبلغی در مرورگر حساب نمی‌شود؛ حساب مرجوعی همان سه عدد معلوم پیشین است.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const invoice = { id: "i1", number: "1405080714", branchId: "b1", warehouseId: "w1", shiftId: "s1", customerId: null, createdByName: "سارا کریمی",
  channel: "pos", status: "finalized", grossAmount: "8800000", discountAmount: "0", netAmount: "8800000", taxAmount: "0",
  shippingAmount: "0", payableAmount: "8800000", paidAmount: "8800000", receivedAmount: "8800000", occurredAt: "2026-10-29T12:50:00Z",
  lines: [
    { id: "l1", lineNo: 1, variationId: "v1", productName: "شال نخی ساده", sku: "LM-6120", color: "خاکی", size: null, qty: "1", unitPrice: "3900000", netAmount: "3900000", discountAmount: "0", taxAmount: "0" },
    { id: "l2", lineNo: 2, variationId: "v2", productName: "تیشرت بیسیک پنبه‌ای", sku: "LM-1043", color: "استخوانی", size: "L", qty: "2", unitPrice: "4900000", netAmount: "9800000", discountAmount: "0", taxAmount: "0" }] };
const returnable = (over: Record<string, unknown> = {}) => ({ invoiceId: "i1", invoiceStatus: "finalized", daysSinceSale: 0, hoursSinceSale: 2, late: false, windowHours: 48,
  lines: [
    { invoiceLineId: "l1", variationId: "v1", soldQty: "1", returnedQty: "0", remainingQty: "1", unitPrice: "3900000", netAmount: "3900000", returnedNetAmount: "0", taxAmount: "0", returnedTaxAmount: "0" },
    { invoiceLineId: "l2", variationId: "v2", soldQty: "2", returnedQty: "1", remainingQty: "1", unitPrice: "4900000", netAmount: "9800000", returnedNetAmount: "4900000", taxAmount: "0", returnedTaxAmount: "0" }],
  ...over });

function fixture(api: MockApi, view: Record<string, unknown>) {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /return-reasons"] = { reasons: [{ code: "changed_mind", label: "تغییر نظر" }] };
  api.defaults["GET /invoices/lookup"] = invoice;
  api.defaults["GET /invoices/i1"] = invoice;
  api.defaults["GET /invoices/i1/refund-sources"] = { payments: [] };
  api.defaults["GET /shifts/open"] = [{ id: "s1", userName: "سارا کریمی", openedAt: "2026-10-29T05:25:00Z" }];
  api.defaults["GET /invoices/i1/returnable"] = view;
}
async function find(page: Page) {
  await page.goto("/?page=returns");
  await page.getByLabel("شماره فاکتور", { exact: true }).fill("1405080714");
  await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
}

test.describe("مرجوعی (طرح ۱۰)", () => {
  test("two sections, the item table and the window from the server", async ({ page, api }) => {
    fixture(api, returnable());
    await page.goto("/?page=returns");
    await expect(page.getByRole("region", { name: "۱. فاکتور و اقلام برگشتی" })).toBeVisible();
    await expect(page.getByRole("region", { name: "۲. حساب مرجوعی" }), "پیش از فاکتور، حسابی نیست").toHaveCount(0);

    await page.getByLabel("شماره فاکتور", { exact: true }).fill("1405080714");
    await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
    const one = page.getByRole("region", { name: "۱. فاکتور و اقلام برگشتی" });
    const two = page.getByRole("region", { name: "۲. حساب مرجوعی" });
    await expect(two).toBeVisible();
    await expect(one).toContainText("1405080714");
    await expect(one).toContainText("سارا کریمی");
    await expect(one.locator(".returns-window")).toHaveText("در مهلت: 2 ساعت از 48 ساعت گذشته");

    const table = one.getByRole("table");
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["کالا", "فروخته", "بهای همان فروش", "برگشتی", "وضعیت کالا"]);
    const shirt = table.locator("tbody tr").filter({ hasText: "تیشرت بیسیک پنبه‌ای" });
    await expect(shirt).toContainText("LM-1043");
    await expect(shirt).toContainText("استخوانی");
    await expect(shirt).toContainText("قبلاً برگشته 1");
    await expect(shirt).toContainText("490٬000");
    await expect(shirt.getByRole("combobox")).toHaveCount(0);
    await page.getByRole("button", { name: "اضافه کردن تیشرت بیسیک پنبه‌ای", exact: true }).click();
    await expect(page.getByRole("button", { name: "اضافه کردن تیشرت بیسیک پنبه‌ای", exact: true }), "حداکثر همان باقی‌ماندهٔ سرور").toBeDisabled();
    await expect(shirt.getByRole("combobox", { name: "وضعیت برگشتی تیشرت بیسیک پنبه‌ای" })).toHaveValue("sellable");

    // حساب: همان سه عدد معلوم؛ ارزش کالا از همان پیشنهاد پیشین (۴۹۰٬۰۰۰ تومان).
    await expect(two.locator(".return-account")).toContainText("490٬000");
    await expect(two.getByRole("button", { name: "۱. بررسی مرجوعی", exact: true })).toBeVisible();
    expect(api.calls.filter(c => c.startsWith("POST ")), "هیچ چیزی ثبت نشد").toEqual([]);

    const width = page.viewportSize()!.width;
    const a = (await one.boundingBox())!, b = (await two.boundingBox())!;
    if (width >= 1100) {
      expect(Math.abs(a.y - b.y), "کنار هم").toBeLessThan(2);
      expect(b.x + b.width, "حساب در سمت چپ (RTL)").toBeLessThanOrEqual(a.x + 1);
      if (width >= 1440) {
        // روی دسکتاپ پهن، وضعیت کالا بی اسکرول افقی دیده می‌شود (اندازه‌گیری‌شده، نه فرض).
        const fit = await one.locator(".table-scroll").evaluate(t => t.scrollWidth <= t.clientWidth + 1);
        expect(fit, "جدول اقلام در کارت خودش جا می‌شود").toBe(true);
      }
    } else {
      expect(b.y, "زیر هم").toBeGreaterThan(a.y + a.height - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("late invoice: the badge says outside the window; an older response without windowHours never invents one", async ({ page, api }) => {
    fixture(api, returnable({ hoursSinceSale: 72, late: true }));
    await find(page);
    const one = page.getByRole("region", { name: "۱. فاکتور و اقلام برگشتی" });
    await expect(one.locator(".returns-window")).toHaveText("خارج از مهلت: 72 ساعت از فروش گذشته (مهلت 48 ساعت)");
    await expect(one).toContainText("ثبتش تأیید مدیر می‌خواهد");

    const { windowHours: _omit, ...older } = returnable();
    fixture(api, older);
    await find(page);
    await expect(page.getByRole("region", { name: "۱. فاکتور و اقلام برگشتی" }).locator(".returns-window")).toHaveText("2 ساعت از فروش گذشته");
  });
});
