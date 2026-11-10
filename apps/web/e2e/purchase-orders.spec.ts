/**
 * WP4 دستهٔ ۳ — فهرست سفارش خرید مثل طرح ۱۰.
 *
 * ستون‌ها: سفارش، تأمین‌کننده، پیشرفت («X از Y رسیده»)، مانده، بیش‌تحویل، جمع سفارش (مقایسه)، وضعیت.
 * تعداد با `formatQty` (رقم لاتین در DOM، همان قرارداد سبد صندوق؛ قلم فارسی نمایش می‌دهد).
 * همهٔ عددها از پاسخ سرور (نمای پیشرفت سفارش در SQL) نمایش داده می‌شوند؛ مرورگر جمع نمی‌زند.
 * پیش‌نویس هنوز تعهد نیست: پیشرفت و مانده «—»، نه صفر. دلیل بستن زیر وضعیت «بسته» می‌آید.
 */
import { test, expect } from "./fixtures";

const base = { expectedAt: null, createdAt: "2026-10-17T08:00:00Z", closeReason: null };
const ORDERS = [
  { ...base, id: "o1", number: "PO-1405-000031", status: "sent", supplierName: "تولیدی نخ‌آرا", lineCount: 3, pendingLines: 2,
    orderedQty: "32.000", fulfilledQty: "23.000", remainingQty: "9.000", overQty: "0.000", orderedAmount: "84800000" },
  { ...base, id: "o2", number: "PO-1405-000032", status: "sent", supplierName: "کفش رهنورد", lineCount: 2, pendingLines: 0,
    orderedQty: "6.000", fulfilledQty: "6.000", remainingQty: "0.000", overQty: "1.000", orderedAmount: "67200000" },
  { ...base, id: "o3", number: "PO-1405-000028", status: "closed", supplierName: "پوشاک آریا", lineCount: 1, pendingLines: 1,
    orderedQty: "10.000", fulfilledQty: "6.000", remainingQty: "4.000", overQty: "0.000", orderedAmount: "138000000",
    closeReason: "تأمین‌کننده باقی را ندارد" },
  { ...base, id: "o4", number: null, status: "draft", supplierName: "تولیدی نخ‌آرا", lineCount: 1, pendingLines: 1,
    orderedQty: "5.000", fulfilledQty: "0.000", remainingQty: "5.000", overQty: "0.000", orderedAmount: "5000000" },
];

test.describe("سفارش خرید (طرح ۱۰)", () => {
  test("columns like V10: progress, remaining, over-delivery and the comparison total come from the server; drafts show dashes", async ({ page, api }) => {
    api.defaults["GET /purchase-orders"] = ORDERS;
    await page.goto("/?page=purchasing&purchasing.tab=orders");
    const table = page.getByRole("table", { name: "سفارش‌های خرید" });
    await expect(table).toBeVisible();
    const headers = await table.locator("thead th").allInnerTexts();
    expect(headers.map(h => h.trim()).slice(0, 7)).toEqual(["سفارش", "تأمین‌کننده", "پیشرفت", "مانده", "بیش‌تحویل", "جمع سفارش (مقایسه)", "وضعیت"]);
    await expect(table.locator("thead th").nth(7)).toHaveText("کنش‌ها"); // فقط برای صفحه‌خوان

    const row = (no: string) => table.locator("tbody tr").filter({ hasText: no });
    const open = row("PO-1405-000031");
    await expect(open.locator("td").nth(2)).toContainText("23 از 32 رسیده");
    await expect(open.locator("td").nth(3)).toHaveText("9");
    await expect(open.locator("td").nth(4)).toHaveText("—");
    await expect(open.locator("td").nth(5)).toContainText("8٬480٬000");
    await expect(open.getByText("باز", { exact: true })).toBeVisible();
    // پهنای نوار همان نسبت برآورده به سفارش است (۲۳ از ۳۲ ≈ ۷۲٪).
    const fill = await open.locator(".progress-cell .bar > i").evaluate(el => (el as HTMLElement).style.inlineSize);
    expect(fill).toBe("72%");

    const over = row("PO-1405-000032");
    await expect(over.locator("td").nth(3)).toHaveText("0");
    await expect(over.locator(".po-over")).toHaveText("1");

    const closed = row("PO-1405-000028");
    await expect(closed.getByText("بسته", { exact: true })).toBeVisible();
    await expect(closed.locator("td").nth(6)).toContainText("تأمین‌کننده باقی را ندارد");
    await expect(closed.locator("td").nth(3)).toHaveText("4");

    // پیش‌نویس تعهد نیست: «—» نه صفر، ولی جمع توافقی دیده می‌شود.
    const draft = row("پیش‌نویس");
    await expect(draft.locator("td").nth(2)).toHaveText("—");
    await expect(draft.locator("td").nth(3)).toHaveText("—");
    await expect(draft.locator("td").nth(5)).toContainText("500٬000");

    // گوشی: هر سفارش یک کارت با برچسب ستون کنار مقدار (طرح ۱۰)؛ دسکتاپ: جدول.
    const phone = page.viewportSize()!.width <= 640;
    const shape = await open.evaluate(tr => ({ row: getComputedStyle(tr).display, label: getComputedStyle((tr as HTMLTableRowElement).cells[3]!, "::before").content }));
    expect(shape.row).toBe(phone ? "block" : "table-row");
    if (phone) expect(shape.label).toBe('"مانده"');

    await expect(page.getByText("بستن سفارش نیمه‌رسیده دلیل می‌خواهد", { exact: false })).toBeVisible();
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, "no horizontal page overflow").toBeLessThanOrEqual(size.client);
  });

  test("the row action opens that order by its accessible name", async ({ page, api }) => {
    api.defaults["GET /purchase-orders"] = ORDERS;
    api.defaults["GET /purchase-orders/o3"] = {
      id: "o3", number: "PO-1405-000028", status: "closed", branchId: "b1", supplierId: "s1", supplierName: "پوشاک آریا",
      warehouseId: "w1", warehouseName: "انبار آزمایشی", expectedAt: null, note: null, createdAt: "2026-10-17T08:00:00Z",
      sentAt: "2026-10-17T09:00:00Z", closedAt: "2026-10-20T09:00:00Z", closeReason: "تأمین‌کننده باقی را ندارد",
      orderedAmount: "138000000", lines: [],
    };
    await page.goto("/?page=purchasing&purchasing.tab=orders");
    await page.getByRole("button", { name: "باز کن PO-1405-000028", exact: true }).click();
    await expect(page.getByRole("heading", { name: /PO-1405-000028 — پوشاک آریا/ })).toBeVisible();
    await expect(page.getByText("دلیل بستن: تأمین‌کننده باقی را ندارد")).toBeVisible();
    expect(api.calls).toContain("GET /purchase-orders/o3");
  });

  test("no orders: an empty message, no table and no closing note", async ({ page, api }) => {
    api.defaults["GET /purchase-orders"] = [];
    await page.goto("/?page=purchasing&purchasing.tab=orders");
    await expect(page.getByText("هنوز سفارشی ثبت نشده.")).toBeVisible();
    await expect(page.getByRole("table", { name: "سفارش‌های خرید" })).toHaveCount(0);
    await expect(page.getByText("بستن سفارش نیمه‌رسیده دلیل می‌خواهد", { exact: false })).toHaveCount(0);
  });
});
