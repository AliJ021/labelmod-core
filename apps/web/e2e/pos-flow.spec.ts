import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const id = "33333333-3333-4333-8333-333333333333";
const shift = "44444444-4444-4444-8444-444444444444";
const draft = { id, number: null, branchId: "b1", warehouseId: "w1", shiftId: shift,
  createdBy: "22222222-2222-4222-8222-222222222222", customerId: null, status: "draft", channel: "pos",
  grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "200000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null,
  occurredAt: "2026-10-10T08:00:00Z", lines: [{ id: "l1", lineNo: 1,
    variationId: "66666666-6666-4666-8666-666666666666", productName: "شلوار کتان", sku: "NAVY-M",
    qty: "2", unitPrice: "100000", netAmount: "200000", discountAmount: "0", listPrice: null,
    priceOverrideReason: null, discountReason: null }] };
async function open(page: Page, api: MockApi) {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true }] };
  api.defaults["GET /shifts/current"] = { id: shift, userId: draft.createdBy, branchId: "b1", status: "open", openingCash: "0" };
  api.defaults["GET /gift-options"] = { options: [] };
  api.defaults[`GET /invoices/${id}`] = draft;
  api.defaults[`GET /invoices/${id}/customer`] = { customer: null };
  api.defaults[`GET /invoices/${id}/payments`] = { payments: [] };
  await page.addInitScript(([invoiceId, shiftId]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({invoiceId, shiftId})), [id, shift]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.locator(".lines li")).toContainText("شلوار کتان");
}

test("cashier workspace keeps customer before product entry without horizontal overflow", async ({page, api}, info) => {
  await open(page, api);
  const customer = (await page.getByRole("region", {name: "مشتری", exact: true}).boundingBox())!;
  const product = (await page.getByRole("region", {name: "افزودن کالا"}).boundingBox())!;
  expect(customer.y + customer.height).toBeLessThanOrEqual(product.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.POS_FLOW_EVIDENCE) await page.screenshot({path: `${process.env.POS_FLOW_EVIDENCE}-${info.project.name}.png`, fullPage: true});
});

test("secondary sale tools disclose by keyboard without mutating the draft and close after an action", async ({page, api}) => {
  await open(page, api);
  const toggle = page.locator("summary", {hasText: "ابزارهای فروش"});
  const discard = page.getByRole("button", {name: "رها کردن سبد", exact: true});
  await expect(discard).toBeHidden();
  await expect(page.getByRole("button", {name: "چاپ پیش‌فاکتور", exact: true})).toBeVisible();
  const writes = () => api.calls.filter(call => /^(POST|PATCH|DELETE) \/(invoices|shifts)/.test(call));
  const before = writes();
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(discard).toBeVisible();
  await expect(page.getByRole("button", {name: "ذخیره و فروش جدید", exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await discard.focus(); await page.keyboard.press("Escape");
  await expect(discard).toBeHidden(); await expect(toggle).toBeFocused();
  await toggle.click(); await page.getByRole("button", {name: "بستن شیفت", exact: true}).click();
  await expect(discard).toBeHidden();
  await expect(page.getByRole("heading", {name: "بستن شیفت", exact: true})).toBeVisible();
  expect(writes()).toEqual(before);
});

test("the editable unit price is distinct from the total for a quantity of two", async ({page, api}) => {
  await open(page, api);
  const edit = page.getByRole("button", {name: "ویرایش قیمت شلوار کتان", exact: true});
  await expect(edit).toContainText("قیمت واحد"); await expect(edit).toContainText("10٬000");
  await expect(page.locator(".line-total")).toContainText("20٬000");
  await expect(page.locator(".line-total")).not.toHaveRole("button");
  const size = (await edit.boundingBox())!; expect(size.height).toBeGreaterThanOrEqual(44);
  await edit.focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel(/قیمت واحد/)).toHaveValue("10000");
  await expect(page.getByLabel(/قیمت واحد/)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(edit).toHaveAttribute("aria-expanded", "false");
});
