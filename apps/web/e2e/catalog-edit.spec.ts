import { test, expect, product } from "./fixtures";
import type { Variation } from "../src/lib/catalog";

const variations: Variation[] = ["S", "M", "L"].map((size, i) => ({
  id: `v${i + 1}`, sku: `TR-${size}`, size, color: "مشکی", barcode: `123456789012${i}`,
  status: "active", price: "1234000", priceKind: "regular", priceSince: "2026-09-16T00:00:00Z", locked: false,
}));

test("ویرایش نام ذخیره و با Reload حفظ می‌شود؛ انصراف درخواستی نمی‌فرستد", async ({ page, api }) => {
  let current = { ...product };
  api.handlers.set(`GET /products/${product.id}`, async route => {
    await route.fulfill({ json: { product: current, variations } });
  });
  api.handlers.set(`PATCH /products/${product.id}/name`, async route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ nameInternal: "نام اصلاح‌شدهٔ کالا", expectedName: product.nameInternal });
    current = { ...current, nameInternal: body.nameInternal };
    await route.fulfill({ json: { ok: true } });
  });
  api.handlers.set("POST /labels", async route => {
    await route.fulfill({ contentType: "text/html", body: `<html><body>${current.nameInternal}</body></html>` });
  });
  await page.goto(`/?page=catalog&catalog.product=${product.id}&catalog.labels=1`);
  const panel = page.getByRole("region", { name: "موجودی و چاپ بارکد" });
  const queue = page.getByRole("region", { name: "فهرست چاپ گروهی" });
  await page.getByRole("checkbox", { name: "انتخاب TR-S", exact: true }).check();
  await panel.getByRole("button", { name: "افزودن به فهرست چاپ گروهی", exact: true }).click();
  await panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" }).click();
  await queue.getByRole("button", { name: "پیش‌نمایش ۱ لیبل" }).click();
  await expect(page.locator("iframe")).toHaveCount(2);
  await page.getByRole("button", { name: "ویرایش نام کالا" }).click();
  const form = page.getByRole("form", { name: "ویرایش نام کالا" });
  await expect(form.getByRole("button", { name: "ذخیرهٔ نام" })).toBeDisabled();
  await form.getByLabel("نام کالا", { exact: true }).fill("نام لغوشده");
  await form.getByRole("button", { name: "انصراف از ویرایش" }).click();
  expect(api.calls.filter(c => c.startsWith("PATCH /products/"))).toHaveLength(0);
  await page.getByRole("button", { name: "ویرایش نام کالا" }).click();
  await expect(form.getByLabel("نام کالا", { exact: true })).toHaveValue(product.nameInternal);
  await form.getByLabel("نام کالا", { exact: true }).fill("نام اصلاح‌شدهٔ کالا");
  await form.getByRole("button", { name: "ذخیرهٔ نام" }).click();
  await expect(page.getByRole("heading", { name: "نام اصلاح‌شدهٔ کالا", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "نام کالا ذخیره شد." })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(queue).toContainText("نام اصلاح‌شدهٔ کالا");
  await panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" }).click();
  await expect(panel.locator("iframe").contentFrame().locator("body")).toContainText("نام اصلاح‌شدهٔ کالا");
  await queue.getByRole("button", { name: "پیش‌نمایش ۱ لیبل" }).click();
  await expect(queue.locator("iframe").contentFrame().locator("body")).toContainText("نام اصلاح‌شدهٔ کالا");
  await api.settled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "نام اصلاح‌شدهٔ کالا", exact: true })).toBeVisible();
  expect(api.calls.filter(c => c.startsWith("PATCH /products/"))).toHaveLength(1);
  expect(current.code).toBe(product.code);
});

test("خطای ویرایش نام فرم را نگه می‌دارد و موفقیت کاذب نمی‌دهد", async ({ page, api }) => {
  api.handlers.set(`PATCH /products/${product.id}/name`, async route => {
    await route.fulfill({ status: 409, json: { error: { code: "product_name_changed", message: "نام در این فاصله تغییر کرده است" } } });
  });
  await page.goto(`/?page=catalog&catalog.product=${product.id}`);
  await page.getByRole("button", { name: "ویرایش نام کالا" }).click();
  const form = page.getByRole("form", { name: "ویرایش نام کالا" });
  await form.getByLabel("نام کالا", { exact: true }).fill("نام مورد نظر");
  await form.getByRole("button", { name: "ذخیرهٔ نام" }).click();
  await expect(form.getByRole("alert")).toContainText("نام در این فاصله تغییر کرده است");
  await expect(form.getByLabel("نام کالا", { exact: true })).toHaveValue("نام مورد نظر");
  await expect(page.getByRole("status").filter({ hasText: "نام کالا ذخیره شد." })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: product.nameInternal, exact: true })).toBeVisible();
});

test("انتخاب همهٔ تنوع‌ها، حالت نیمه‌انتخاب و پاک‌کردن همه", async ({ page, api }) => {
  api.handlers.set(`GET /products/${product.id}`, async route => {
    await route.fulfill({ json: { product, variations } });
  });
  await page.goto(`/?page=catalog&catalog.product=${product.id}`);
  const all = page.getByRole("checkbox", { name: "انتخاب همهٔ تنوع‌ها", exact: true });
  await all.check();
  for (const v of variations) await expect(page.getByRole("checkbox", { name: `انتخاب ${v.sku}`, exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "ثبت قیمت برای 3 تنوع", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "انتخاب TR-M", exact: true }).uncheck();
  await expect(all).toHaveJSProperty("indeterminate", true);
  await all.check();
  await expect(all).toHaveJSProperty("indeterminate", false);
  await all.uncheck();
  for (const v of variations) await expect(page.getByRole("checkbox", { name: `انتخاب ${v.sku}`, exact: true })).not.toBeChecked();
  expect(api.calls.some(c => c.startsWith("PUT /prices"))).toBe(false);
});
