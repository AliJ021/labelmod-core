import { test, expect, product } from "./fixtures";

const categoryId = "00000000-0000-7000-8000-000000000777";
const rows = Array.from({ length: 115 }, (_, i) => ({ ...product,
  id: `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
  code: `LM${String(i + 1).padStart(5, "0")}`, nameInternal: `کالای شماره ${i + 1}`,
  categoryId: i >= 100 ? categoryId : null, status: i === 114 ? "archived" : "active",
}));
const tableName = "فهرست کالا؛ قیمت‌ها به تومان";

test.beforeEach(async ({ api }) => {
  api.handlers.set("GET /products", async (route, url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    const search = url.searchParams.get("search") ?? "";
    const category = url.searchParams.get("categoryId");
    const status = url.searchParams.get("status") ?? "active";
    const filtered = rows.filter(p => p.status === status && (!category || p.categoryId === category)
      && (p.code.includes(search) || p.nameInternal.includes(search)));
    await route.fulfill({ json: { products: filtered.slice((page - 1) * 100, page * 100), page, hasMore: filtered.length > page * 100 } });
  });
  api.handlers.set("GET /products/ref-data", async route => {
    await route.fulfill({ json: { categories: [{ id: categoryId, name: "دستهٔ دوم" }], brands: [], seasons: [] } });
  });
});

test("۱۱۴ کالا: صفحهٔ دوم، جزئیات، Reload و Back؛ بدون گم‌شدن یا تکرار", async ({ page, api }) => {
  await page.goto("/?page=catalog");
  const table = page.getByRole("table", { name: tableName });
  const pager = page.getByRole("navigation", { name: "صفحه‌های کالا" });
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await expect(pager.getByRole("button", { name: "صفحهٔ قبل" })).toBeDisabled();
  await pager.getByRole("button", { name: "صفحهٔ بعد" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await expect(table).toContainText("LM00101");
  await expect(table).toContainText("LM00114");
  await expect(table).not.toContainText("LM00100");
  await expect(pager.getByRole("button", { name: "صفحهٔ بعد" })).toBeDisabled();
  await expect(page).toHaveURL(/catalog.page=2/);
  api.handlers.set(`GET /products/${rows[100]!.id}`, async route => {
    await route.fulfill({ json: { product: rows[100], variations: [] } });
  });
  api.handlers.set(`GET /products/${rows[100]!.id}/stock-matrix`, async route => {
    await route.fulfill({ json: { totalOnHand: "0", cells: {} } });
  });
  await table.locator("tbody tr").first().getByRole("button", { name: "باز کردن", exact: true }).click();
  await page.getByRole("button", { name: "بازگشت به فهرست" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await api.settled();
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await pager.getByRole("button", { name: "صفحهٔ قبل" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await api.settled();
  await page.goBack();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("جست‌وجو، دسته و بایگانی از صفحهٔ اول شروع می‌شوند", async ({ page, api }) => {
  await page.goto("/?page=catalog&catalog.page=2");
  const table = page.getByRole("table", { name: tableName });
  await expect(table.locator("tbody tr")).toHaveCount(14);
  const search = page.getByRole("searchbox", { name: "جست‌وجوی کد یا نام کالا" });
  await search.fill("LM00114");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("LM00114");
  await expect(page).not.toHaveURL(/catalog.page=/);
  await search.fill("");
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await page.getByRole("button", { name: "صفحهٔ بعد" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await page.getByRole("button", { name: "دستهٔ دوم", exact: true }).click();
  await expect(page).not.toHaveURL(/catalog.page=/);
  await expect(table.locator("tbody tr")).toHaveCount(14);
  await page.getByRole("tab", { name: "بایگانی", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("LM00115");
  expect(api.calls.some(c => c.includes("status=archived") && c.includes("page=1"))).toBe(true);
});

test("چاپ گروهی انتخاب صفحهٔ اول و دوم را نگه می‌دارد", async ({ page }) => {
  await page.goto("/?page=catalog&catalog.labels=1");
  await page.getByRole("checkbox", { name: "انتخاب کالای شماره 1 برای چاپ گروهی", exact: true }).check();
  await page.getByRole("button", { name: "صفحهٔ بعد" }).click();
  await page.getByRole("checkbox", { name: "انتخاب کالای شماره 114 برای چاپ گروهی", exact: true }).check();
  await expect(page.getByRole("button", { name: /افزودن ۲ کالای انتخاب‌شده/ })).toBeEnabled();
  await page.getByRole("button", { name: "صفحهٔ قبل" }).click();
  await expect(page.getByRole("checkbox", { name: "انتخاب کالای شماره 1 برای چاپ گروهی", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "انتخاب کالای شماره 2 برای چاپ گروهی", exact: true })).not.toBeChecked();
});

test("صفحهٔ خالی یا خطادار راه بازگشت دارد؛ خطا با نبود کالا اشتباه نمی‌شود", async ({ page, api }) => {
  await page.goto("/?page=catalog&catalog.page=3");
  await expect(page.getByText("کالایی برای نمایش در این فهرست نیست.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "صفحهٔ قبل" }).click();
  await expect(page.getByRole("table", { name: tableName }).locator("tbody tr")).toHaveCount(14);
  api.handlers.set("GET /products", async route => {
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "خطای آزمایشی خواندن کالا" } } });
  });
  await page.getByRole("button", { name: "صفحهٔ قبل" }).click();
  await expect(page.getByText("خطای آزمایشی خواندن کالا", { exact: true })).toBeVisible();
  await expect(page.getByText("کالایی برای نمایش در این فهرست نیست.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "تلاش دوباره" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "صفحهٔ بعد" })).toBeDisabled();
});
