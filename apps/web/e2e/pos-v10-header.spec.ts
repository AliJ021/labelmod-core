/**
 * WP4 صندوق — سربرگ مثل طرح ۱۰، بی تغییر رفتار.
 *
 * - کلید دوتایی «حضوری | اینستاگرام» همان شرط پیشین را دارد: با سبد خالی حالت عوض می‌شود
 *   (همان `pos.mode` در نشانی) و با سبد باز بسته است.
 * - «پیش‌نویس‌ها» از منو بیرون آمده و در نوار است؛ «چاپ پیش‌فاکتور» سر جایش می‌ماند.
 * - کارت سند: نشان «پیش‌نویس» و «ثبت‌کننده» از پاسخ سرور؛ پاسخ قدیمی‌تر «—»، نه حدس.
 * - F2 کادر جست‌وجوی کالا را فوکوس می‌کند و صفحه‌کلید هیچ قلمی اضافه نمی‌کند.
 */
import { test, expect, type MockApi } from "./fixtures";

const INV = "33333333-3333-4333-8333-333333333333";
const ME = "22222222-2222-4222-8222-222222222222";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const BR = "55555555-5555-4555-8555-555555555555";
const BRANCHES = { branches: [{ id: BR, code: "TEST", name: "شعبه آزمایشی", warehouses: [{ id: "w1", code: "STORE", name: "انبار آزمایشی", kind: "store" }] }] };
const draft = { id: INV, number: null, branchId: BR, warehouseId: "w1", shiftId: SHIFT, createdBy: ME, createdByName: "سارا کریمی", customerId: null,
  status: "draft", channel: "pos", grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "200000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-26T08:00:00Z",
  lines: [{ id: "l1", lineNo: 1, variationId: "66666666-6666-4666-8666-666666666666", productName: "شلوار کتان", sku: "NAVY-M", color: "سرمه‌ای", size: "M",
    qty: "2", unitPrice: "100000", netAmount: "200000", discountAmount: "0", listPrice: null, priceOverrideReason: null, discountReason: null }] };

function setup(api: MockApi, invoice: Record<string, unknown> | null) {
  api.handlers.set("GET /auth/can", async (route, url) => {
    const op = url.searchParams.get("operation") ?? "";
    await route.fulfill({ json: { verdict: ["sale.create", "instagram.pos.sell", "customer.manage"].includes(op) ? "allow" : "deny", approver: null, reason: "" } });
  });
  api.defaults["GET /branches"] = BRANCHES;
  api.defaults["GET /payment-methods"] = { methods: [{ code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true }, { code: "cash", name: "نقدی", kind: "cash", requiresRef: false }] };
  api.defaults["GET /gift-options"] = { options: [] };
  api.defaults["GET /pos/policy"] = { requireCustomer: false, creditEnabled: false };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: BR, status: "open", openingCash: "0", openedAt: "2026-10-26T07:00:00Z" };
  if (!invoice) return;
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: invoice }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => { await route.fulfill({ json: { payments: [] } }); });
}

const restoreCart = (page: import("@playwright/test").Page) =>
  page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);

test.describe("سربرگ صندوق (طرح ۱۰)", () => {
  test("open cart: draft badge, creator from the server, drafts link outside the menu, mode locked", async ({ page, api }) => {
    setup(api, draft);
    await restoreCart(page);
    await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
    await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");

    const head = page.locator(".pos-doc-head");
    await expect(head.locator(".status")).toHaveText("پیش‌نویس");
    await expect(head.locator(".pos-doc-meta")).toContainText("ثبت‌کننده");
    await expect(head.locator(".pos-doc-meta")).toContainText("سارا کریمی");

    const bar = page.locator(".pos-bar");
    const mode = bar.getByRole("group", { name: "نوع فروش" });
    await expect(mode.getByRole("radio", { name: "حضوری", exact: true })).toBeChecked();
    await expect(mode.getByRole("radio", { name: "اینستاگرام", exact: true })).toBeDisabled();
    // «پیش‌نویس‌ها» بیرون از منوی بسته دیده می‌شود و به همان فهرست می‌برد.
    const drafts = bar.getByRole("link", { name: "پیش‌نویس‌ها", exact: true });
    await expect(drafts).toBeVisible();
    await expect(drafts).toHaveAttribute("href", "/?page=invoices&invoices.status=draft");
    await expect(page.locator(".pos-more-actions").getByRole("link", { name: "پیش‌نویس‌ها" })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "چاپ پیش‌فاکتور", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("an older invoice response without the creator name shows a dash, never a guess", async ({ page, api }) => {
    const { createdByName: _omit, ...older } = draft;
    setup(api, older);
    await restoreCart(page);
    await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
    await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
    const meta = page.locator(".pos-doc-head .pos-doc-meta > div").filter({ hasText: "ثبت‌کننده" });
    await expect(meta.locator("dd")).toHaveText("—");
  });

  test("empty cart: the toggle switches to instagram through the same URL state", async ({ page, api }) => {
    setup(api, null);
    await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
    const mode = page.getByRole("group", { name: "نوع فروش" });
    await expect(mode.getByRole("radio", { name: "حضوری", exact: true })).toBeChecked();
    await mode.getByText("اینستاگرام", { exact: true }).click();
    await expect(page).toHaveURL(/pos\.mode=instagram/);
    await expect(page.locator(".pos-bar")).toContainText("فروش اینستاگرام");
    await expect(page.getByRole("group", { name: "نوع فروش" }).getByRole("radio", { name: "اینستاگرام", exact: true })).toBeChecked();
    expect(api.calls.filter((c) => c.startsWith("POST /invoices")), "تغییر حالت فاکتوری نمی‌سازد").toEqual([]);
  });

  test("F2 focuses the product search; no item is added", async ({ page, api }) => {
    setup(api, null);
    await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
    const search = page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox");
    await expect(search).toHaveAttribute("aria-keyshortcuts", "F2");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(search).not.toBeFocused();
    await page.keyboard.press("F2");
    await expect(search).toBeFocused();
    expect(api.calls.filter((c) => c.startsWith("POST ")), "میان‌بر هیچ چیزی ثبت نمی‌کند").toEqual([]);
  });
});
