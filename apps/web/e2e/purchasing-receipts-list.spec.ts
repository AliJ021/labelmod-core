/**
 * WP4 انبار و خرید — فهرست رسیدهای خرید مثل طرح ۱۰.
 *
 * ستون‌ها: رسید (انبار زیرش)، تاریخ، تأمین‌کننده (شمارهٔ فاکتور)، اقلام (جمع تعداد سرور)، کالا،
 * هزینهٔ جانبی (جمع سرور و نوع و روش هر هزینه)، وضعیت؛ باز کردن با دکمهٔ هر ردیف.
 * بی هزینه «—»؛ پاسخ قدیمی‌تر بی جمع تعداد «قلم» و بی جمع هزینه «نامعلوم»، هرگز صفر.
 */
import { test, expect } from "./fixtures";

const base = { warehouseName: "انبار مرکزی", supplierInvoiceNo: "8831", lineCount: 3 };
const ROWS = [
  { ...base, id: "r1", number: "RC-1405-0112", status: "posted", supplierName: "تولیدی نخ‌آرا", occurredAt: "2026-10-25T08:00:00Z",
    goodsAmount: "31800000", totalQty: "12.000", chargesAmount: "2400000", charges: [{ chargeType: "حمل", allocation: "by_value" }] },
  { ...base, id: "r2", number: "RC-1405-0113", status: "posted", supplierName: "کفش رهنورد", occurredAt: "2026-10-28T08:00:00Z", supplierInvoiceNo: "210",
    goodsAmount: "78400000", totalQty: "7.000", chargesAmount: "600000", charges: [{ chargeType: "بیمه", allocation: "none" }] },
  { ...base, id: "r3", number: null, status: "draft", supplierName: "پوشاک آریا", occurredAt: "2026-10-29T08:00:00Z", supplierInvoiceNo: "550",
    goodsAmount: "82200000", totalQty: "6.000", chargesAmount: "0", charges: [] },
];

test.describe("فهرست رسیدهای خرید (طرح ۱۰)", () => {
  test("quantity and side costs from the server, no-cost dash, open from the row", async ({ page, api }) => {
    api.defaults["GET /receipts"] = ROWS;
    await page.goto("/?page=purchasing&purchasing.tab=receipts");
    const table = page.getByRole("table", { name: "رسیدهای خرید؛ مبلغ‌ها به تومان" });
    await expect(table).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["رسید", "تاریخ", "تأمین‌کننده", "اقلام", "کالا", "هزینهٔ جانبی", "وضعیت", "کنش‌ها"]);
    const cells = (text: string) => table.locator("tbody tr").filter({ hasText: text }).locator("td");

    const first = cells("RC-1405-0112");
    await expect(first.nth(0)).toContainText("انبار مرکزی");
    await expect(first.nth(2)).toContainText("فاکتور 8831");
    await expect(first.nth(3)).toHaveText(/12 عدد$/);
    await expect(first.nth(4)).toContainText("3٬180٬000");
    await expect(first.nth(5)).toContainText("240٬000");
    await expect(first.nth(5)).toContainText("حمل · سرشکن به نسبت مبلغ");
    await expect(cells("RC-1405-0113").nth(5)).toContainText("بیمه · هزینهٔ دوره (بدون تخصیص)");

    const draft = cells("پوشاک آریا");
    await expect(draft.nth(0)).toContainText("پس از ثبت");
    await expect(draft.nth(2)).toContainText("فاکتور 550 (پیش‌نویس)");
    await expect(draft.nth(5)).toHaveText(/—$/);
    await expect(draft.nth(6)).toContainText("پیش‌نویس");

    api.defaults["GET /receipts/r3"] = { ...ROWS[2], branchId: "b1", warehouseId: "w1", supplierId: "s1", postedAt: null, note: null, taxAmount: "0",
      supplierPayable: "0", thirdPartyPayable: "0", lines: [], charges: [] };
    await table.getByRole("button", { name: "باز کن پیش‌نویس" }).click();
    await expect.poll(() => api.calls).toContain("GET /receipts/r3");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("an older response without totals shows lines and unknown cost, never zero", async ({ page, api }) => {
    api.defaults["GET /receipts"] = [{ ...base, id: "r9", number: "RC-1405-0001", status: "posted", supplierName: "تأمین‌کنندهٔ قدیمی",
      occurredAt: "2026-10-25T08:00:00Z", goodsAmount: "1000000" }];
    await page.goto("/?page=purchasing&purchasing.tab=receipts");
    const row = page.getByRole("table", { name: "رسیدهای خرید؛ مبلغ‌ها به تومان" }).locator("tbody tr").first().locator("td");
    await expect(row.nth(3)).toHaveText(/3 قلم$/);
    await expect(row.nth(5)).toContainText("نامعلوم");
  });
});
