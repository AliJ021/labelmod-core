/**
 * WP4 انبار و خرید — برگشت از خرید مثل طرح ۱۰: فهرست اول، «برگشت تازه» فرم را باز می‌کند.
 *
 * سه مبلغ هر برگه (بهای فاکتور، ارزش دفتری، حمل برنگشتنی) همان ستون‌های ثبت‌شدهٔ سرورند؛ صفحه
 * جمع یا تفاضلی برای فهرست نمی‌سازد. پس از ثبت برگهٔ تازه، فهرست دوباره از سرور خوانده می‌شود.
 */
import { test, expect } from "./fixtures";

const ROW = { id: "pr1", number: "PR-1405-000009", status: "posted", occurredAt: "2026-10-28T09:00:00Z", receiptNumber: "P-1405-000112",
  supplierName: "تولیدی نخ‌آرا", warehouseName: "انبار مرکزی", firstItem: "تیشرت بیسیک پنبه‌ای · استخوانی · L", lineCount: 2, totalQty: "3.000",
  goodsAmount: "2650000", costAmount: "2850000", taxAmount: "0", chargeLoss: "200000" };

test.describe("برگشت از خرید (طرح ۱۰)", () => {
  test.beforeEach(({ api }) => { api.defaults["GET /return-reasons"] = { reasons: [{ code: "quality", label: "ایراد کیفی" }] }; });
  test("list first with stored amounts; the form opens from the header and a posted sheet reloads the list", async ({ page, api }) => {
    api.defaults["GET /purchase-returns"] = { returns: [ROW, { ...ROW, id: "pr2", number: "PR-1405-000008", lineCount: 1, totalQty: "1.000", chargeLoss: "0",
      firstItem: "شلوار جین", goodsAmount: "1000000", costAmount: "1000000" }] };
    await page.goto("/?page=purchasing&purchasing.tab=returns");
    const table = page.getByRole("table", { name: "برگه‌های برگشت از خرید؛ مبلغ‌ها به تومان" });
    await expect(table).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["برگه", "تأمین‌کننده", "کالا", "تعداد", "بهای فاکتور", "ارزش دفتری", "حمل برنگشتنی", "وضعیت"]);
    const cells = (n: string) => table.locator("tbody tr").filter({ hasText: n }).locator("td");
    const a = cells("PR-1405-000009");
    await expect(a.nth(1)).toContainText("P-1405-000112");
    await expect(a.nth(2)).toContainText("تیشرت بیسیک پنبه‌ای · استخوانی · L و 1 قلم دیگر");
    await expect(a.nth(4)).toContainText("265٬000");
    await expect(a.nth(5)).toContainText("285٬000");
    await expect(a.nth(6)).toContainText("20٬000");
    await expect(cells("PR-1405-000008").nth(6)).toHaveText(/—$/);
    await expect(page.getByText("تفاوتشان حملی است", { exact: false })).toBeVisible();

    // فرم پیش از درخواست کاربر بسته است و با دکمهٔ سرعنوان باز می‌شود.
    await expect(page.getByLabel("شماره رسید خرید", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "برگشت تازه" }).click();
    await expect(page.getByRole("button", { name: "بستن فرم" })).toHaveAttribute("aria-expanded", "true");

    api.defaults["GET /receipts/lookup"] = { id: "rc1", number: "P-1405-000112" };
    api.defaults["GET /receipts/rc1/returnable"] = { receiptId: "rc1", number: "P-1405-000112", supplierName: "تولیدی نخ‌آرا", warehouseId: "w1",
      warehouseName: "انبار مرکزی", occurredAt: "2026-10-25T08:00:00Z", lines: [{ receiptLineId: "rl1", variationId: "v1", sku: "LM-1043",
        productName: "تیشرت بیسیک پنبه‌ای", color: "استخوانی", size: "L", receivedQty: "5.000", returnedQty: "0.000", remainingQty: "5.000",
        unitPrice: "1325000", landedUnitCost: "1425000" }] };
    await page.reload();
    await page.getByRole("button", { name: "برگشت تازه" }).click();
    await page.getByLabel("شماره رسید خرید", { exact: true }).fill("P-1405-000112");
    await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
    const previews: unknown[] = [];
    api.handlers.set("POST /receipts/rc1/return-preview", async route => { previews.push(route.request().postDataJSON());
      await route.fulfill({ json: { goodsAmount: "1325000", costAmount: "1425000", taxAmount: "0", chargeLoss: "100000", payableReduction: "1325000" } }); });
    await page.getByRole("button", { name: "اضافه کردن تیشرت بیسیک پنبه‌ای" }).click();
    await page.getByRole("combobox", { name: "علت برگشت" }).selectOption("quality");
    await expect(page.getByText("کاهش بدهی تأمین‌کننده").locator("..")).toContainText("132٬500");
    expect(previews.at(-1)).toEqual({ lines: [{ receiptLineId: "rl1", qty: "1" }] });
    let posts = 0;
    api.handlers.set("POST /purchase-returns", async route => {
      posts++;
      await route.fulfill({ status: 201, json: { ...ROW, id: "pr3", number: "PR-1405-000010", receiptId: "rc1", reasonCode: "quality", reasonNote: null,
        postedAt: "2026-10-29T09:00:00Z", lines: [] } });
    });
    const before = api.calls.filter(c => c.startsWith("GET /purchase-returns")).length;
    await page.getByRole("button", { name: /ثبت برگشت/ }).click();
    await expect(page.getByRole("status")).toContainText("PR-1405-000010");
    expect(posts).toBe(1);
    await expect.poll(() => api.calls.filter(c => c.startsWith("GET /purchase-returns")).length, "فهرست دوباره خوانده شد").toBe(before + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("preview amounts come from the server: payable includes tax; a rejected preview blocks posting", async ({ page, api }) => {
    api.defaults["GET /receipts/lookup"] = { id: "rc1", number: "P-1405-000112" };
    api.defaults["GET /receipts/rc1/returnable"] = { receiptId: "rc1", number: "P-1405-000112", supplierName: "تولیدی نخ‌آرا", warehouseId: "w1",
      warehouseName: "انبار مرکزی", occurredAt: "2026-10-25T08:00:00Z", lines: [{ receiptLineId: "rl1", variationId: "v1", sku: "LM-1043",
        productName: "تیشرت بیسیک پنبه‌ای", color: "استخوانی", size: "L", receivedQty: "5.000", returnedQty: "0.000", remainingQty: "5.000",
        unitPrice: "1325000", landedUnitCost: "1425000" }] };
    // عمداً با «تعداد × بها» در مرورگر فرق دارد (مالیات و گرد کردن آخرین تکه): صفحه باید عدد سرور را نشان دهد.
    let reply: { status: number; json: unknown } = { status: 200, json: { goodsAmount: "1325000", costAmount: "1424999", taxAmount: "132500",
      chargeLoss: "99999", payableReduction: "1457500" } };
    api.handlers.set("POST /receipts/rc1/return-preview", async route => { await route.fulfill(reply); });
    await page.goto("/?page=purchasing&purchasing.tab=returns");
    await page.getByRole("button", { name: "برگشت تازه" }).click();
    await page.getByLabel("شماره رسید خرید", { exact: true }).fill("P-1405-000112");
    await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
    await page.getByRole("button", { name: "اضافه کردن تیشرت بیسیک پنبه‌ای" }).click();
    await page.getByRole("combobox", { name: "علت برگشت" }).selectOption("quality");
    const payable = page.getByText("کاهش بدهی تأمین‌کننده").locator("..");
    await expect(payable).toContainText("145٬750");
    await expect(page.getByText("شامل مالیات برگشتی")).toContainText("13٬250");
    await expect(page.getByText("کاهش ارزش موجودی").locator("..")).toContainText("142٬499٫9");
    await expect(page.getByRole("button", { name: /ثبت برگشت/ })).toBeEnabled();

    reply = { status: 409, json: { error: { code: "rule_violation", message: "بیشتر از آنچه رسید شده برگشت داده می‌شود" } } };
    await page.getByRole("button", { name: "اضافه کردن تیشرت بیسیک پنبه‌ای" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "بیشتر از آنچه رسید شده" })).toBeVisible();
    await expect(page.getByText("کاهش بدهی تأمین‌کننده")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /ثبت برگشت/ })).toBeDisabled();
    expect(api.calls.filter(c => c === "POST /purchase-returns")).toHaveLength(0);
    api.errors.length = 0;
  });

  test("empty list says how to start; a failed read is an error, not an empty list", async ({ page, api }) => {
    await page.goto("/?page=purchasing&purchasing.tab=returns");
    await expect(page.getByText("هنوز برگشتی ثبت نشده.")).toBeVisible();
    api.handlers.set("GET /purchase-returns", async route => { await route.fulfill({ status: 500, json: { error: { code: "internal", message: "خطای سرور" } } }); });
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: "خطای سرور" })).toBeVisible();
    await expect(page.getByText("هنوز برگشتی ثبت نشده.")).toHaveCount(0);
    api.errors.length = 0;
  });
});
