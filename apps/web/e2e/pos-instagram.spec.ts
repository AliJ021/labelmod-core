/**
 * صندوق در حالت فروش اینستاگرام (بازنگری مالک ۲۶ اکتبر، مهاجرت ۱۰۵) — API ماک.
 *
 * - اپراتور اینستاگرام (فقط `instagram.pos.sell`) مستقیم در حالت اینستاگرام است: شیفتی پرسیده و باز
 *   نمی‌شود، «بستن شیفت»، پیش‌فاکتور و تغییر حالت ندارد.
 * - همان چیدمان مصوب پرداخت، با **کارت‌به‌کارت** به‌جای کارت‌خوان؛ نسیه نیست. نقد می‌ماند (۱۰۶) ولی
 *   باقی پول ندارد و کشویش را سرور از شعبه تعیین می‌کند؛ دو کشوی باز ۴۲۲ است و پولی شمرده نمی‌شود.
 * - پرداخت کامل کارت‌به‌کارت و نهایی‌سازی — بدنه‌ها دقیق شمرده می‌شوند.
 * - مدیر (هر دو مجوز) پیش‌فرض صندوق فروشگاه است و با یک دکمه به حالت اینستاگرام می‌رود؛ سبد تازه با
 *   `channel: "instagram"` ساخته می‌شود. کنترل منفی: همان مدیر در حالت فروشگاه `channel: "pos"` می‌فرستد.
 * - صفحهٔ قدیمی سفارش اینستاگرام بی تنظیم صریح «سفارش تازه» ندارد و به همین حالت پیوند می‌دهد.
 * هیچ sleep در کار نیست.
 */
import type { Page } from "@playwright/test";
import { test, expect, type MockApi } from "./fixtures";

const INV = "33333333-3333-4333-8333-333333333333";
const ME = "22222222-2222-4222-8222-222222222222";
const SHIFT = "44444444-4444-4444-8444-444444444444";
// کلید زمینهٔ فروش اینستاگرام شناسهٔ شعبه است و مثل شیفت باید UUID باشد.
const BR = "55555555-5555-4555-8555-555555555555";
const BRANCHES = { branches: [{ id: BR, code: "TEST", name: "شعبه آزمایشی", warehouses: [{ id: "w1", code: "STORE", name: "انبار آزمایشی", kind: "store" }] }] };
const VAR = "66666666-6666-4666-8666-666666666666";
const draft = { id: INV, number: null, branchId: BR, warehouseId: "w1", shiftId: null as string | null, createdBy: ME, customerId: null,
  status: "draft", channel: "instagram", grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "200000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-26T08:00:00Z",
  lines: [{ id: "l1", lineNo: 1, variationId: VAR, productName: "شلوار کتان", sku: "NAVY-M", qty: "2", unitPrice: "100000",
    netAmount: "200000", discountAmount: "0", listPrice: null, priceOverrideReason: null, discountReason: null }] };
const METHODS = [
  { code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true },
  { code: "cash", name: "نقدی", kind: "cash", requiresRef: false },
  { code: "credit", name: "نسیه", kind: "credit", requiresRef: false },
  { code: "digipay", name: "دیجی‌پی", kind: "gateway", requiresRef: true },
  { code: "gateway", name: "درگاه پرداخت", kind: "gateway", requiresRef: true },
  { code: "transfer", name: "کارت‌به‌کارت", kind: "transfer", requiresRef: true },
];

function allow(api: MockApi, ops: readonly string[]) {
  api.handlers.set("GET /auth/can", async (route, url) => {
    const op = url.searchParams.get("operation") ?? "";
    await route.fulfill({ json: { verdict: ops.includes(op) ? "allow" : "deny", approver: null, reason: "" } });
  });
}

/** سبد اینستاگرامِ بازیابی‌شده، با شمارش پرداخت و نهایی‌سازی. */
function server(api: MockApi) {
  const state = { invoice: { ...draft }, posted: [] as Array<Record<string, unknown>>, finalized: 0 };
  let received = 0n;
  api.defaults["GET /branches"] = BRANCHES;
  api.defaults["GET /payment-methods"] = { methods: METHODS };
  api.defaults["GET /gift-options"] = { options: [] };
  api.defaults["GET /pos/policy"] = { requireCustomer: false, creditEnabled: true };
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: { ...state.invoice, receivedAmount: received.toString() } }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => {
    await route.fulfill({ json: { payments: received > 0n ? [{ id: "p1", name: "کارت‌به‌کارت", amount: received.toString() }] : [] } });
  });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.posted.push(body);
    received += BigInt(String(body.amount));
    await route.fulfill({ status: 201, json: { paymentId: "p1", replayed: false, receivedAmount: received.toString(),
      invoice: { ...state.invoice, receivedAmount: received.toString() } } });
  });
  api.handlers.set(`POST /invoices/${INV}/finalize`, async (route) => {
    state.finalized++;
    const due = 200000n - received;
    await route.fulfill({ json: { ...state.invoice, status: "finalized", number: "IG-77", paidAmount: received.toString(), replayed: false,
      settlement: { payableAmount: "200000", paidAmount: received.toString(), receivedAmount: received.toString(), changeAmount: "0", dueAmount: due.toString() } } });
  });
  return state;
}

const selector = (page: Page) => page.getByRole("region", { name: "روش پرداخت" });
const method = (page: Page, name: string) => selector(page).getByRole("button", { name, exact: true });
const bar = (page: Page) => page.locator(".pos-bar");

test("اپراتور اینستاگرام: بی شیفت، کارت‌به‌کارت به‌جای کارت‌خوان، بی نسیه؛ پرداخت کامل و نهایی", async ({ page, api }) => {
  const s = server(api);
  allow(api, ["instagram.pos.sell"]);
  await page.addInitScript(([inv, ctx]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: ctx })), [INV, BR]);
  await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");

  await expect(bar(page)).toContainText("فروش اینستاگرام");
  await expect(bar(page)).not.toContainText("شیفت باز");
  await expect(page.getByRole("button", { name: "چاپ پیش‌فاکتور", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "صندوق فروشگاه", exact: true }), "اپراتور حالت فروشگاه ندارد").toHaveCount(0);
  await page.locator("summary", { hasText: "ابزارهای فروش" }).click();
  await expect(page.getByRole("button", { name: "رها کردن سبد", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "بستن شیفت", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "پیش‌نویس‌ها", exact: true }), "فهرست فاکتور برای نقش محدود بسته است").toHaveCount(0);
  await page.keyboard.press("Escape");

  // همان سه خانهٔ مصوب، کارت‌به‌کارت در جای کارت‌خوان.
  const tiles = selector(page).locator(".pay-tile");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAttribute("data-key", "transfer");
  await expect(method(page, "کارت‌به‌کارت")).toBeVisible();
  await expect(method(page, "کارت‌خوان")).toHaveCount(0);
  await expect(method(page, "اسنپ‌پی")).toBeVisible();
  await expect(method(page, "دیجی‌پی")).toBeVisible();
  await selector(page).getByRole("button", { name: /^نمایش (بیشتر|کمتر)/ }).click();
  await expect(method(page, "نقدی"), "نقد از روش‌های صندوق می‌ماند").toBeVisible();
  await expect(method(page, "نسیه")).toHaveCount(0);
  await expect(method(page, "درگاه پرداخت"), "روش‌های مجاز دیگر برای پرداخت ترکیبی می‌مانند").toBeVisible();
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toHaveCount(0);

  await method(page, "کارت‌به‌کارت").click();
  const form = page.getByRole("form", { name: "دریافت با کارت‌به‌کارت" });
  await form.getByLabel("شماره پیگیری").fill("C2C-778899");
  await form.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect.poll(() => s.posted.length).toBe(1);
  expect(s.posted[0]).toEqual({ methodCode: "transfer", amount: "200000", refNo: "C2C-778899" });

  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  await page.getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).click();
  await expect.poll(() => s.finalized).toBe(1);
  await expect(page.getByText("IG-77").first()).toBeVisible();
  expect(api.calls.filter((c) => c.startsWith("GET /shifts") || c.startsWith("POST /shifts")), "شیفتی پرسیده یا باز نشد").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("مدیر: پیش‌فرض صندوق فروشگاه؛ دکمهٔ «فروش اینستاگرام» سبد تازه را با کانال اینستاگرام می‌سازد", async ({ page, api }) => {
  server(api);
  allow(api, ["sale.create", "instagram.pos.sell", "sale.credit", "customer.manage"]);
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: BR, status: "open", openingCash: "0", openedAt: "2026-10-26T07:00:00Z" };
  api.defaults["GET /pos/products"] = { products: [{ id: "p1", name: "شلوار کتان", code: "P1", variationCount: 1 }] };
  api.defaults["GET /pos/products/p1/variations"] = { variations: [{ id: VAR, sku: "NAVY-M", barcode: null, color: "سرمه‌ای", size: "M", price: "100000", available: "4" }] };
  const created: Array<Record<string, unknown>> = [];
  let channel = "pos";
  api.handlers.set("POST /invoices", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    created.push(body);
    channel = body.channel === "instagram" ? "instagram" : "pos";
    await route.fulfill({ status: 201, json: { ...draft, lines: [], channel, shiftId: channel === "instagram" ? null : SHIFT } });
  });
  api.handlers.set(`POST /invoices/${INV}/scan`, async (route) => {
    await route.fulfill({ json: { invoice: { ...draft, channel, shiftId: channel === "instagram" ? null : SHIFT }, replayed: false } });
  });
  const add = async () => {
    const panel = page.getByRole("region", { name: "افزودن کالا" });
    await panel.getByRole("searchbox").fill("شلوار");
    await panel.getByRole("button", { name: /شلوار کتان/ }).click();
    await panel.getByRole("button", { name: "سرمه‌ای", exact: true }).click();
    await panel.getByRole("button", { name: /سایز M/ }).click();
    await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
  };

  await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
  await expect(bar(page)).toContainText("شیفت باز");
  // کنترل منفی: فروش حضوری مدیر همان کانال صندوق است.
  await add();
  expect(created.at(-1)).toMatchObject({ channel: "pos" });
  await expect(page.getByRole("button", { name: "فروش اینستاگرام", exact: true }), "با سبد باز، حالت عوض نمی‌شود").toBeDisabled();

  await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1&pos.mode=instagram`);
  await expect(bar(page)).toContainText("فروش اینستاگرام");
  await expect(page.locator(".lines li"), "سبد حضوری به حالت اینستاگرام نمی‌چسبد").toHaveCount(0);
  await add();
  expect(created.at(-1)).toMatchObject({ channel: "instagram", branchId: BR });
  await expect(selector(page).locator(".pay-tile").nth(0)).toHaveAttribute("data-key", "transfer");
});

test("صفحهٔ قدیمی سفارش اینستاگرام بی تنظیم صریح «سفارش تازه» ندارد و به حالت اینستاگرام صندوق می‌برد", async ({ page, api }) => {
  allow(api, ["instagram.order.manage", "instagram.payment.verify"]);
  api.handlers.set("GET /instagram-orders", async (route) => {
    await route.fulfill({ json: { page: 1, perPage: 20, total: 0, pages: 1, orders: [], legacyCreate: false } });
  });
  await page.goto("/?page=instagram-orders&ig.new=1");
  const link = page.getByRole("link", { name: "صندوق — فروش اینستاگرام" });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "سفارش تازه" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "سفارش تازه" }), "نشانی کهنه فرم بسته را باز نمی‌کند").toHaveCount(0);
  await expect(link).toHaveAttribute("href", "/?page=pos&pos.mode=instagram");
});

test("نقد اینستاگرام: بی باقی پول، و دو کشوی باز یعنی پیام روشن و هیچ دریافتی شمرده نمی‌شود", async ({ page, api }) => {
  const s = server(api);
  allow(api, ["instagram.pos.sell"]);
  api.defaults["GET /shifts/open"] = [{ id: SHIFT, userName: "صندوق اول", openedAt: "2026-10-27T08:00:00Z" }];
  let refuse = true;
  const sent: Array<Record<string, unknown>> = [];
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (refuse) {
      refuse = false;
      await route.fulfill({ status: 422, json: { error: { code: "ambiguous_shift",
        message: "نقد فروش اینستاگرام به کشوی باز همین شعبه می‌نشیند؛ چند کشو در این شعبه باز است و حدس زده نمی‌شود کدام. کشو را مشخص کنید یا روش دیگری انتخاب کنید." } } });
      return;
    }
    s.posted.push(body);
    await route.fulfill({ status: 201, json: { paymentId: "p1", replayed: false, receivedAmount: String(body.amount),
      invoice: { ...s.invoice, receivedAmount: String(body.amount) } } });
  });
  await page.addInitScript(([inv, ctx]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: ctx })), [INV, BR]);
  await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
  await selector(page).getByRole("button", { name: /^نمایش (بیشتر|کمتر)/ }).click();
  await method(page, "نقدی").click();
  const form = page.getByRole("form", { name: "دریافت با نقدی" });
  await form.getByLabel("کشوی دریافت نقد").selectOption(SHIFT);
  await expect(form).toContainText("باقی پول ندارد");
  // بیش از مانده پیش از هر درخواست رد می‌شود: باقی پولی در کار نیست.
  await form.getByLabel("مبلغ (تومان)").fill("25000");
  await form.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(form).toContainText("مبلغ از مانده بیشتر است");
  expect(sent).toHaveLength(0);
  await form.getByLabel("مبلغ (تومان)").fill("");
  await form.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "چند کشو در این شعبه باز است" })).toBeVisible();
  expect(sent).toEqual([{ methodCode: "cash", amount: "200000", shiftId: SHIFT }]);
  expect(s.posted, "ردِ قطعی چیزی ثبت نکرد").toHaveLength(0);
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeDisabled();
});

test("Instagram cash drawer: choose among two; lost response and reload replay the exact drawer/key", async ({ page, api }, testInfo) => {
  server(api);
  allow(api, ["instagram.pos.sell"]);
  const other = "77777777-7777-4777-8777-777777777777";
  api.defaults["GET /shifts/open"] = [SHIFT, other].map((id, i) => ({ id, userName: `صندوق ${i + 1}`, openedAt: "2026-10-27T08:00:00Z" }));
  const sent: Array<{ key: string; body: unknown }> = [];
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route) => {
    sent.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
    api.handlers.set(`GET /invoices/${INV}/payment-intents/${sent[0]!.key}`, async (lookup) => {
      await lookup.fulfill({ json: { state: "not_found", terminal: false } });
    });
    if (sent.length === 1) { await route.abort("failed"); return; }
    await route.fulfill({ status: 200, json: { paymentId: "p1", replayed: true, receivedAmount: "200000", invoice: { ...draft, receivedAmount: "200000" } } });
  });
  await page.addInitScript(([inv, ctx]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: ctx })), [INV, BR]);
  await page.goto(`/?page=pos&pos.branch=${BR}&pos.warehouse=w1`);
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
  await selector(page).getByRole("button", { name: /^نمایش (بیشتر|کمتر)/ }).click();
  await method(page, "نقدی").click();
  const form = page.getByRole("form", { name: "دریافت با نقدی" });
  await expect(form.getByRole("button", { name: "دریافت وجه", exact: true })).toBeDisabled();
  await form.getByLabel("کشوی دریافت نقد").selectOption(other);
  await form.screenshot({ path: testInfo.outputPath("instagram-cash-drawers.png") });
  await form.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByText("نتیجه نامعلوم", { exact: true })).toBeVisible();
  await expect(page.getByLabel("کشوی دریافت نقد")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  // The server's lookup does not see the first request yet; only the same intent may be retried.
  await expect(page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]!.body).toEqual({ methodCode: "cash", amount: "200000", shiftId: other });
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeEnabled();
});
