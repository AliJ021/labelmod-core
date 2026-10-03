/**
 * ستون «قیمت فروش» فهرست کالا — دادهٔ مصنوعی، API ماک.
 *
 * ادعای مرکزی: قیمتِ نبوده هرگز صفر یا مبلغ کامل نشان داده نمی‌شود، و
 * ستون شمارش «قیمت‌دار» برنگشته است.
 */
import { test, expect, openCatalog, product } from "./fixtures";
import type { Product } from "../src/lib/catalog";

const row = (code: string, over: Partial<Product>): Product => ({
  ...product, id: crypto.randomUUID(), code, nameInternal: `کالای آزمایشی ${code}`, ...over,
});

const ROWS: Product[] = [
  row("EQ-1", { variationCount: 3, pricedCount: 3, sellableCount: 3, sellablePricedCount: 3, priceMin: "12500000", priceMax: "12500000" }),
  row("RG-1", { variationCount: 3, pricedCount: 3, sellableCount: 3, sellablePricedCount: 3, priceMin: "9000000", priceMax: "11000000" }),
  row("NP-1", { variationCount: 2, pricedCount: 0, sellableCount: 2, sellablePricedCount: 0, priceMin: null, priceMax: null }),
  row("PP-1", { variationCount: 3, pricedCount: 2, sellableCount: 3, sellablePricedCount: 2, priceMin: "7000000", priceMax: "8000000" }),
  row("AR-1", { status: "archived", variationCount: 1, pricedCount: 1, sellableCount: 0, sellablePricedCount: 0, priceMin: null, priceMax: null }),
  row("BG-1", { variationCount: 2, pricedCount: 2, sellableCount: 2, sellablePricedCount: 2, priceMin: "900719925474099300", priceMax: "999999999999999999" }),
  row("FR-1", { variationCount: 3, pricedCount: 2, sellableCount: 3, sellablePricedCount: 2, priceMin: "1001", priceMax: "1009" }),
  row("SM-1", { variationCount: 1, pricedCount: 1, sellableCount: 1, sellablePricedCount: 1, priceMin: "1", priceMax: "1" }),
  row("ZR-1", { variationCount: 1, pricedCount: 1, sellableCount: 1, sellablePricedCount: 1, priceMin: "0", priceMax: "0" }),
  row("AD-1", { variationCount: 2, pricedCount: 2, sellableCount: 2, sellablePricedCount: 2, priceMin: "900719925474099300", priceMax: "900719925474099301" }),
];

test("قیمت فروش: برابر، بازه، بی‌قیمت، بخشی بی‌قیمت، بی‌تنوع فعال و مبلغ بزرگ", async ({ page, api }) => {
  api.productRows = ROWS;
  await openCatalog(page);
  const table = page.locator("main table.grid");
  await expect(table.getByRole("columnheader", { name: "قیمت فروش", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "قیمت‌دار", exact: true })).toHaveCount(0);
  const cell = (code: string) => table.getByRole("row").filter({ hasText: code }).getByRole("cell").nth(4);

  await expect(cell("EQ-1")).toContainText("1٬250٬000");
  await expect(cell("EQ-1")).toContainText("تومان");
  await expect(cell("EQ-1")).not.toContainText("تا");
  await expect(cell("EQ-1")).not.toContainText("بی‌قیمت");
  await expect(cell("RG-1")).toContainText("900٬000 تا 1٬100٬000");
  await expect(cell("RG-1")).not.toContainText("بی‌قیمت");
  await expect(cell("NP-1")).toHaveText("بدون قیمت");
  await expect(cell("NP-1")).not.toContainText("۰");
  await expect(cell("PP-1")).toContainText("700٬000 تا 800٬000");
  await expect(cell("PP-1")).toContainText("۱ تنوع بی‌قیمت");
  await expect(cell("PP-1").locator('[data-state="warning"]')).toHaveCount(1);
  await expect(cell("AR-1")).toHaveText("تنوع فعال ندارد");
  await expect(cell("BG-1").locator(".money-digits")).toHaveText(["90٬071٬992٬547٬409٬930", "99٬999٬999٬999٬999٬999٫9"]);
  await expect(cell("FR-1").locator(".money-digits")).toHaveText(["100٫1", "100٫9"]);
  await expect(cell("FR-1")).toContainText("۱ تنوع بی‌قیمت");
  await expect(cell("FR-1").locator(".money-unit")).toHaveText(["تومان"]);
  await expect(cell("SM-1").locator(".money-digits")).toHaveText(["0٫1"]);
  await expect(cell("ZR-1").locator(".money-digits")).toHaveText(["0"]);
  await expect(cell("ZR-1")).not.toContainText("بدون قیمت");
  await expect(cell("AD-1").locator(".money-digits")).toHaveText(["90٬071٬992٬547٬409٬930", "90٬071٬992٬547٬409٬930٫1"]);
  // هر ردیف هنوز دکمهٔ «باز کردن» خودش را دارد — شناسهٔ کالا عوض نشده.
  await expect(table.getByRole("button", { name: "باز کردن", exact: true })).toHaveCount(ROWS.length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
