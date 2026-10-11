/**
 * رسید خرید: افزودن گروهی رنگ/سایز و کد خودکار کالا — رفتار مرورگر.
 * قرارداد مالی (همه یا هیچ، ادغام هم‌قیمت، Idempotency، هم‌زمانی کد) در آزمون API است.
 */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const summary = { id: "r1", number: null, status: "draft", supplierName: "تأمین‌کنندهٔ آزمایشی", warehouseName: "انبار آزمایشی",
  occurredAt: "2026-09-16T08:00:00Z", supplierInvoiceNo: null, lineCount: 0, goodsAmount: "0" };
const receipt = { ...summary, branchId: "b1", warehouseId: "w1", supplierId: "s1", postedAt: null, note: null, taxAmount: "0",
  chargesAmount: "0", supplierPayable: "0", thirdPartyPayable: "0", lines: [] as unknown[], charges: [] };
const variations = [
  { id: "v-bs", sku: "LM00042-001", barcode: "2000000000015", color: "مشکی", size: "S" },
  { id: "v-bm", sku: "LM00042-002", barcode: "2000000000022", color: "مشکی", size: "M" },
  { id: "v-ws", sku: "LM00042-003", barcode: null, color: "سفید", size: "S" },
];
const hit = { id: "p1", name: "پیراهن آزمایشی", code: "LM00042", variationCount: 3 };

async function openDraft(page: Page, api: import("./fixtures").MockApi) {
  api.defaults["GET /receipts"] = [summary];
  api.defaults["GET /receipts/r1"] = receipt;
  api.defaults["GET /receipts/r1/products/p1/variations"] = { variations };
  await page.goto("/?page=purchasing");
  await page.getByRole("button", { name: "باز کن" }).click();
  await expect(page.getByRole("heading", { name: "افزودن چند رنگ و سایز" })).toBeVisible();
}

test.describe("افزودن گروهی رسید خرید", () => {
  test("search by name, pick product, select a whole colour plus one size, edit qty, one all-or-nothing request", async ({ page, api }) => {
    api.defaults["GET /receipts/r1/products"] = { products: [hit, { ...hit, id: "p2", name: "پیراهن دیگر", code: "LM00043" }], exactVariationId: null, exactProductId: null };
    const posts: unknown[] = [];
    api.handlers.set("POST /receipts/r1/lines/bulk", async route => {
      posts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
      await route.fulfill({ status: 201, json: { ...receipt, lines: [], replayed: false } });
    });
    await openDraft(page, api);
    await page.getByLabel("جست‌وجوی کالا با نام، کد یا بارکد").fill("پیراهن");
    await page.getByRole("button", { name: "جست‌وجو", exact: true }).click();
    await page.getByRole("button", { name: /پیراهن آزمایشی/ }).click();
    const pick = page.getByRole("group", { name: /پیراهن آزمایشی/ });
    await pick.getByLabel("مشکی — همهٔ سایزها").check();
    await pick.getByLabel("تعداد مشکی M").fill("۴");
    await pick.getByRole("checkbox", { name: "S" }).nth(1).check();
    await expect(pick.getByRole("button", { name: "افزودن ۳ قلم" })).toBeVisible();
    // قیمت لازم است: بی قیمت، هیچ درخواستی نمی‌رود.
    await pick.getByRole("button", { name: "افزودن ۳ قلم" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "قیمت خرید معتبر نیست." })).toBeVisible();
    expect(posts).toHaveLength(0);
    // تعداد نامعتبر: پیام، نه درخواست.
    await pick.getByLabel("قیمت خرید هر عدد به تومان، برای همهٔ انتخاب‌شده‌ها").fill("۱۲۰٬۰۰۰");
    await pick.getByLabel("تعداد سفید S").fill("0");
    await pick.getByRole("button", { name: "افزودن ۳ قلم" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "تعداد ۱ قلم معتبر نیست" })).toBeVisible();
    expect(posts).toHaveLength(0);
    await pick.getByLabel("تعداد سفید S").fill("2");
    await pick.getByRole("button", { name: "افزودن ۳ قلم" }).click();
    await expect(page.getByText("۳ قلم به رسید اضافه شد.")).toBeVisible();
    expect(posts).toHaveLength(1);
    const sent = posts[0] as { body: { lines: { variationId: string; qty: string; unitPrice: string }[] }; key: string };
    expect(sent.key, "Idempotency-Key").toBeTruthy();
    expect(sent.body.lines).toEqual([
      { variationId: "v-bs", qty: "1", unitPrice: "1200000" },
      { variationId: "v-bm", qty: "4", unitPrice: "1200000" },
      { variationId: "v-ws", qty: "2", unitPrice: "1200000" },
    ]);
    await expect(pick.getByRole("button", { name: "افزودن", exact: true }), "selection cleared after success").toBeVisible();
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, "no horizontal overflow").toBeLessThanOrEqual(size.client);
  });

  test("exact barcode opens its product with that size preselected; a server rejection keeps the selection", async ({ page, api }) => {
    // کالای دقیق عمداً اول فهرست نیست: مرورگر با شناسهٔ صریح انتخاب می‌کند، نه «اولین سطر».
    api.defaults["GET /receipts/r1/products"] = { products: [{ ...hit, id: "p0", name: "آ کالای دیگر", code: "LM00001" }, hit], exactVariationId: "v-bm", exactProductId: "p1" };
    api.handlers.set("POST /receipts/r1/lines/bulk", async route => {
      await route.fulfill({ status: 409, json: { error: { code: "variation_archived", message: "این کالا بایگانی شده است", correlationId: "req-1" } } });
    });
    await openDraft(page, api);
    await page.getByLabel("جست‌وجوی کالا با نام، کد یا بارکد").fill("2000000000022");
    await page.getByRole("button", { name: "جست‌وجو", exact: true }).click();
    const pick = page.getByRole("group", { name: /پیراهن آزمایشی/ });
    await expect(pick.getByLabel("تعداد مشکی M")).toHaveValue("1");
    await expect(pick.getByLabel("تعداد مشکی S")).toBeDisabled();
    await pick.getByLabel("قیمت خرید هر عدد به تومان، برای همهٔ انتخاب‌شده‌ها").fill("100000");
    await pick.getByRole("button", { name: "افزودن ۱ قلم" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "این کالا بایگانی شده است" })).toBeVisible();
    await expect(pick.getByLabel("تعداد مشکی M"), "rejected request keeps what the user chose").toHaveValue("1");
  });
});

test("a pending bulk add locks receipt switch, post and edits; its answer lands on the same receipt; the panel resets per receipt", async ({ page, api }) => {
  const other = { ...summary, id: "r2", supplierName: "تأمین‌کنندهٔ دوم" };
  api.defaults["GET /receipts"] = [summary, other];
  const line = { id: "l0", variationId: "v-bs", sku: "LM00042-001", barcode: null, productName: "پیراهن آزمایشی", color: "مشکی", size: "S", qty: "1.000", unitPrice: "1000000", lineAmount: "1000000", chargeAlloc: "0", landedUnitCost: "1000000" };
  api.defaults["GET /receipts/r1"] = { ...receipt, lines: [line] };
  api.defaults["GET /receipts/r2"] = { ...receipt, id: "r2", supplierName: "تأمین‌کنندهٔ دوم" };
  api.defaults["GET /receipts/r1/products"] = { products: [hit], exactVariationId: null, exactProductId: null };
  api.defaults["GET /receipts/r1/products/p1/variations"] = { variations };
  let release: () => void = () => {};
  const held = new Promise<void>(r => { release = r; });
  api.handlers.set("POST /receipts/r1/lines/bulk", async route => {
    await held;
    await route.fulfill({ status: 201, json: { ...receipt, goodsAmount: "3000000", lines: [line, { ...line, id: "l1", variationId: "v-bm", size: "M", qty: "2.000" }], replayed: false } });
  });
  await page.goto("/?page=purchasing");
  await page.getByRole("button", { name: "باز کن" }).first().click();
  await page.getByLabel("جست‌وجوی کالا با نام، کد یا بارکد").fill("پیراهن");
  await page.getByRole("button", { name: "جست‌وجو", exact: true }).click();
  const pick = page.getByRole("group", { name: /پیراهن آزمایشی/ });
  await pick.getByLabel("مشکی — همهٔ سایزها").check();
  await pick.getByLabel("قیمت خرید هر عدد به تومان، برای همهٔ انتخاب‌شده‌ها").fill("100000");
  await pick.getByRole("button", { name: "افزودن ۲ قلم" }).click();

  // در راه: تعویض رسید، ثبت، ابطال و ویرایش سطر بسته‌اند — حتی با کلیک اجباری درخواستی نمی‌رود.
  for (const name of ["ثبت رسید", "ابطال پیش‌نویس"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  for (const b of await page.getByRole("button", { name: "باز کن" }).all()) await expect(b).toBeDisabled();
  await page.getByRole("button", { name: "باز کن" }).nth(1).click({ force: true });
  await page.getByRole("button", { name: "ثبت رسید", exact: true }).click({ force: true });
  expect(api.calls.filter(c => c.startsWith("GET /receipts/r2") || c.startsWith("POST /receipts/r1/post"))).toEqual([]);

  release();
  await expect(page.getByText("۲ قلم به رسید اضافه شد.")).toBeVisible();
  await expect(page.getByRole("button", { name: "ثبت رسید", exact: true })).toBeEnabled();

  // رسید دیگر: پنل افزودن گروهی از نو — نه کالای انتخاب‌شده، نه نرخ.
  await page.getByRole("button", { name: "باز کن" }).nth(1).click();
  await expect(page.getByRole("heading", { name: /تأمین‌کنندهٔ دوم/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /پیراهن آزمایشی/ })).toHaveCount(0);
  await expect(page.getByLabel("جست‌وجوی کالا با نام، کد یا بارکد")).toHaveValue("");
});

test("new product without a code: the server's generated code is shown", async ({ page, api }) => {
  const posts: unknown[] = [];
  api.handlers.set("POST /products", async route => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: "p9", code: "LM00042", replayed: false } });
  });
  api.defaults["GET /products/p9"] = { product: { id: "p9", code: "LM00042", nameInternal: "کالای تازه", nameWeb: null, brandId: null, brandName: null, categoryId: null, categoryName: null, season: null, collection: null, fabric: null, fit: null, originCountry: null, taxRateCode: "standard", notes: null, status: "active", variationCount: 0, pricedCount: 0, sellableCount: 0, sellablePricedCount: 0, priceMin: null, priceMax: null }, variations: [] };
  api.defaults["GET /seasons"] = { seasons: [] };
  api.defaults["GET /products/p9/stock-matrix"] = { totalOnHand: "0", cells: {} };
  await page.goto("/?page=catalog");
  await page.getByRole("button", { name: "کالای تازه", exact: true }).click();
  await expect(page.getByLabel(/کد کالا — اختیاری/)).not.toHaveAttribute("required", "");
  await page.getByLabel("نام کالا", { exact: true }).fill("کالای تازه");
  await page.getByRole("button", { name: "ساخت کالا", exact: true }).click();
  await expect(page.getByText("کالا با کد LM00042 ساخته شد. حالا تنوع‌هایش را بسازید.")).toBeVisible();
  expect(posts).toEqual([{ nameInternal: "کالای تازه" }]);
});
