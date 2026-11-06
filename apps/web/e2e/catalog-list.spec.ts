/**
 * WP4 دستهٔ ۵ — فهرست «کالا و قیمت» مثل طرح ۱۰.
 *
 * ستون‌ها: کد، کالا (رنگ‌ها · دسته)، سایزها، موجودی هر انبار، قیمت فروش، بهای واحد (فقط با cost.view)،
 * وضعیت (کمبود/عادی). همهٔ عددها از پاسخ سرور؛ انبار بی‌سابقه «—» نه صفر؛ بی cost.view ستون بها نیست؛
 * آستانهٔ تعریف‌نشده «کمبود» یا «عادی» ادعا نمی‌کند. روی گوشی هر کالا کارتی با برچسب کنار مقدار است.
 */
import { test, expect, product } from "./fixtures";
import type { Product, ProductInventory } from "../src/lib/catalog";

const STORE = { warehouseId: "w1", warehouseName: "فروشگاه", warehouseKind: "store" };
const DEPOT = { warehouseId: "w2", warehouseName: "انبار مرکزی", warehouseKind: "stock" };
const inv = (o: Partial<ProductInventory>): ProductInventory => ({
  sizes: [], colors: [], stock: [], costVisible: true, unitCostMin: null, unitCostMax: null, lowStock: 0, ...o,
});
const row = (code: string, over: Partial<Product>): Product => ({ ...product, id: crypto.randomUUID(), code, nameInternal: `کالای ${code}`, ...over });

const ROWS: Product[] = [
  row("LM-1042", { categoryName: "تیشرت", priceMin: "4900000", priceMax: "4900000",
    inventory: inv({ sizes: ["S", "M", "L", "XL"], colors: ["مشکی"], stock: [{ ...STORE, qty: "15.000" }, { ...DEPOT, qty: "27.000" }],
      unitCostMin: "2650000", unitCostMax: "2650000", lowStock: 2 }) }),
  row("LM-2084", { categoryName: "شلوار", priceMin: "12800000", priceMax: "12800000",
    inventory: inv({ sizes: ["30", "32", "34", "36"], colors: ["آبی تیره"], stock: [{ ...STORE, qty: "11.000" }],
      unitCostMin: "7000000", unitCostMax: "7400000", lowStock: 0 }) }),
  row("LM-6120", { categoryName: "اکسسوری", priceMin: "3900000", priceMax: "3900000",
    inventory: inv({ sizes: [], colors: ["خاکی"], stock: [], unitCostMin: null, unitCostMax: null, lowStock: 0 }) }),
];

test.describe("فهرست کالا (طرح ۱۰)", () => {
  test("columns like V10: sizes in garment order, stock per warehouse, sale price, unit cost range and shortage — all from the server", async ({ page, api }) => {
    api.productRows = ROWS;
    await page.goto("/?page=catalog");
    const table = page.getByRole("table", { name: "فهرست کالا؛ قیمت‌ها به تومان" });
    await expect(table).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["کد", "کالا", "سایزها", "فروشگاه", "انبار مرکزی", "قیمت فروش", "بهای واحد", "وضعیت", "کنش‌ها"]);
    const cells = (code: string) => table.locator("tbody tr").filter({ hasText: code }).locator("td");

    const tee = cells("LM-1042");
    await expect(tee.nth(1)).toContainText("مشکی · تیشرت");
    await expect(tee.nth(2)).toHaveText("S · M · L · XL");
    await expect(tee.nth(3)).toHaveText("15");
    await expect(tee.nth(4)).toHaveText("27");
    await expect(tee.nth(5)).toContainText("490٬000");
    await expect(tee.nth(6)).toContainText("265٬000");
    await expect(tee.nth(7)).toContainText("کمبود");

    const jeans = cells("LM-2084");
    await expect(jeans.nth(2)).toHaveText("30 · 32 · 34 · 36");
    await expect(jeans.nth(4)).toContainText("—");
    await expect(jeans.nth(4)).toContainText("در این انبار سابقه ندارد");
    await expect(jeans.nth(6)).toContainText("700٬000");
    await expect(jeans.nth(6)).toContainText("740٬000");
    await expect(jeans.nth(7)).toContainText("عادی");

    const scarf = cells("LM-6120");
    await expect(scarf.nth(2)).toContainText("سایز ندارد");
    await expect(scarf.nth(4)).toContainText("—");
    await expect(scarf.nth(4)).not.toContainText("0");
    await expect(scarf.nth(6)).toContainText("موجودی یا بها ندارد");

    await expect(table.getByRole("button", { name: "باز کردن", exact: true })).toHaveCount(ROWS.length);
    const phone = page.viewportSize()!.width <= 640;
    const shape = await table.locator("tbody tr").first().evaluate(tr => ({ row: getComputedStyle(tr).display, label: getComputedStyle((tr as HTMLTableRowElement).cells[2]!, "::before").content }));
    expect(shape.row).toBe(phone ? "block" : "table-row");
    if (phone) expect(shape.label).toBe('"سایزها"');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("without cost.view there is no cost column at all; unknown threshold claims neither shortage nor normal", async ({ page, api }) => {
    api.productRows = ROWS.map(p => ({ ...p, inventory: { ...p.inventory!, costVisible: false, unitCostMin: null, unitCostMax: null, lowStock: null } }));
    await page.goto("/?page=catalog");
    const table = page.getByRole("table", { name: "فهرست کالا؛ قیمت‌ها به تومان" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "بهای واحد" })).toHaveCount(0);
    await expect(table.getByText("کمبود", { exact: true })).toHaveCount(0);
    await expect(table.getByText("عادی", { exact: true })).toHaveCount(0);
    await expect(table.locator("tbody tr").first().locator("td").nth(6)).toContainText("فعال");
  });

  test("label mode keeps the per-row and select-all checkboxes with their names", async ({ page, api }) => {
    api.productRows = ROWS;
    await page.goto("/?page=catalog&catalog.labels=1");
    await expect(page.getByRole("checkbox", { name: "انتخاب همهٔ کالاهای این فهرست" })).toBeVisible();
    await page.getByRole("checkbox", { name: "انتخاب کالای LM-1042 برای چاپ گروهی" }).check();
    await expect(page.getByRole("button", { name: /افزودن ۱ کالای انتخاب‌شده/ })).toBeEnabled();
    await page.getByRole("checkbox", { name: "انتخاب همهٔ کالاهای این فهرست" }).check();
    await expect(page.getByRole("button", { name: /افزودن ۳ کالای انتخاب‌شده/ })).toBeEnabled();
  });
});
