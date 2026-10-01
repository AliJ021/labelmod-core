/**
 * صندوق Batch 2.1 — پرداخت، نسیهٔ صریح، نتیجهٔ نامعلوم، وضعیت «ثبت شد» و چیدمان.
 *
 * API ماک است (fixtures.ts)؛ قواعد مالی سرور در آزمون‌های API و SQL سنجیده
 * می‌شوند. اینجا فقط اینکه صفحه چه می‌فرستد، چه نمی‌فرستد و چه نشان می‌دهد.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, type MockApi } from "./fixtures";

const INV = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const line = (id: string, name: string, qty: string, net: string) => ({ id, lineNo: Number(id.slice(1)), variationId: "66666666-6666-4666-8666-66666666666" + id.slice(1),
  productName: name, sku: "SKU-" + id, qty, unitPrice: (BigInt(net) / BigInt(qty)).toString(), netAmount: net, discountAmount: "0", listPrice: null, priceOverrideReason: null, discountReason: null });
// قابل پرداخت ۲۰۰٬۰۰۰ ریال = ۲۰٬۰۰۰ تومان؛ دو ردیف و سه عدد.
const draft = { id: INV, number: null, branchId: "b1", warehouseId: "w1", shiftId: SHIFT, createdBy: ME, customerId: null as string | null,
  status: "draft", channel: "pos", grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "200000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-01T08:00:00Z",
  lines: [line("l1", "شلوار کتان", "2", "100000"), line("l2", "پیراهن کتان", "1", "100000")] };
const customer = { id: "c1", fullName: "مریم آزمون", mobile: "09121234567", status: "active" };
const METHODS = [
  { code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true },
  { code: "cash", name: "نقدی", kind: "cash", requiresRef: false },
  { code: "credit", name: "نسیه", kind: "credit", requiresRef: false },
  { code: "digipay", name: "دیجی‌پی", kind: "gateway", requiresRef: true },
  { code: "gateway", name: "درگاه پرداخت", kind: "gateway", requiresRef: true },
  { code: "giftcard", name: "کارت هدیه", kind: "gift_card", requiresRef: true },
  { code: "points", name: "امتیاز باشگاه", kind: "points", requiresRef: false },
  { code: "transfer", name: "کارت‌به‌کارت", kind: "transfer", requiresRef: true },
];

interface Pay { methodCode: string; amount: string; refNo?: string }
/** سبد بازیابی‌شده + پرداخت و نهایی‌سازی ماک، با شمارش آنچه واقعاً فرستاده شد. */
function pos(api: MockApi, over: Partial<typeof draft> = {}, methods = METHODS) {
  const state = { invoice: { ...draft, ...over }, payments: [] as Array<{ id: string; name: string; amount: string }>, posted: [] as Pay[], keys: [] as string[], finalized: 0, finalizeKeys: [] as string[] };
  const received = () => state.payments.reduce((n, p) => n + BigInt(p.amount), BigInt(over.receivedAmount ?? "0")).toString();
  api.defaults["GET /payment-methods"] = { methods };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-10-01T07:00:00Z" };
  api.defaults["GET /gift-options"] = { options: [] };
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: { ...state.invoice, receivedAmount: received() } }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: state.invoice.customerId ? customer : null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => { await route.fulfill({ json: { payments: state.payments } }); });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route) => {
    const body = route.request().postDataJSON() as Pay;
    state.posted.push(body); state.keys.push(route.request().headers()["idempotency-key"] ?? "");
    const name = METHODS.find((m) => m.code === body.methodCode)?.name ?? body.methodCode;
    state.payments.push({ id: "p" + state.posted.length, name, amount: body.amount });
    await route.fulfill({ status: 201, json: { paymentId: "p" + state.posted.length, replayed: false, receivedAmount: received(), invoice: state.invoice } });
  });
  api.handlers.set(`POST /invoices/${INV}/finalize`, async (route) => {
    state.finalized++; state.finalizeKeys.push(route.request().headers()["idempotency-key"] ?? "");
    await route.fulfill({ json: { ...state.invoice, status: "finalized", number: "MAIN-77", paidAmount: received(), replayed: false } });
  });
  return state;
}

async function open(page: Page) {
  await page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
}
const payPanel = (page: Page) => page.getByRole("complementary", { name: "پرداخت", exact: true });
const method = (page: Page, name: string) => page.getByRole("region", { name: "روش پرداخت" }).getByRole("button", { name, exact: true });

test("cash sale: confirm dialog, one finalize under double click, persistent success with change, print and next sale", async ({ page, api }) => {
  const s = pos(api);
  await open(page);
  await expect(page.locator(".pos-bar .pill")).toHaveText("۲ ردیف · ۳ عدد");
  await expect(payPanel(page).locator(".checkout-payable")).toContainText("20٬000");
  await method(page, "نقدی").click();
  await page.getByLabel("مبلغ (تومان)", { exact: true }).fill("25000");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect.poll(() => s.posted).toEqual([{ methodCode: "cash", amount: "250000" }]);
  await expect(payPanel(page).locator(".checkout-change")).toContainText("5٬000");

  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "نهایی‌کردن فاکتور" });
  await expect(dialog).toContainText("باقی پول");
  await expect(dialog).toContainText("5٬000");
  await dialog.getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).dblclick();
  const done = page.getByRole("region", { name: /فاکتور MAIN-77 ثبت شد/ });
  await expect(done).toBeVisible();
  expect(s.finalized, "دابل‌کلیک فقط یک نهایی‌سازی می‌فرستد").toBe(1);
  await expect(done.locator(".sale-complete-change")).toContainText("5٬000");
  await expect(done.getByRole("region", { name: "ریز پرداخت‌ها" })).toContainText("نقدی");
  const print = done.getByRole("link", { name: "چاپ رسید" });
  await expect(print).toHaveAttribute("href", `/api/invoices/${INV}/print`);
  await expect(print).toHaveAttribute("target", "_blank");
  // چاپ دستی است: بی کلیک هیچ پنجره‌ای باز نمی‌شود و وضعیت «ثبت شد» می‌ماند.
  expect(page.context().pages()).toHaveLength(1);
  await done.getByRole("button", { name: "فروش بعدی", exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.getByText("سبد خالی است")).toBeVisible();
  await expect(page.locator(".pos-bar .pill")).toHaveText("۰ ردیف · ۰ عدد");
  expect(await page.evaluate(() => localStorage.getItem("labelmod_open_cart"))).toBe("");
});

test("card reader is primary; non-cash overpayment is blocked before any request; a server race maps to an actionable message", async ({ page, api }) => {
  const s = pos(api);
  await open(page);
  const card = method(page, "کارت‌خوان");
  const cardBox = (await card.boundingBox())!, cashBox = (await method(page, "نقدی").boundingBox())!;
  expect(cardBox.width, "کارت‌خوان تمام‌عرض و برجسته").toBeGreaterThan(cashBox.width * 1.5);
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(method(page, "نقدی")).toHaveAttribute("aria-pressed", "false");
  const amount = page.getByLabel("مبلغ (تومان)", { exact: true });
  await expect(amount).toBeFocused();
  await amount.fill("20001");
  await page.getByLabel("شماره پیگیری", { exact: true }).fill("TRACE-1");
  await expect(page.getByText("مبلغ از مانده بیشتر است")).toBeVisible();
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  expect(s.posted, "مبلغ بیش از مانده اصلاً فرستاده نمی‌شود").toEqual([]);

  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    s.posted.push(route.request().postDataJSON() as Pay);
    await route.fulfill({ status: 422, json: { error: { code: "non_cash_overpayment", message: "raw" } } });
  });
  await amount.fill("20000");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "حداکثر مبلغ برای این روش" })).toBeVisible();
  await expect(amount).toHaveValue("20000");
  await expect(card).toBeEnabled();
});

test("ambiguous payment: status check finds it recorded, unlocks without a second request", async ({ page, api }) => {
  const s = pos(api);
  let calls = 0;
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    calls++;
    s.payments.push({ id: "p1", name: "نقدی", amount: "200000" });
    await route.abort("connectionreset");
  });
  await open(page);
  await method(page, "نقدی").click();
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toBeVisible();
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.locator(".pos-alert").filter({ hasText: "پیش‌تر ثبت شده بود" })).toBeVisible();
  expect(calls).toBe(1);
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeEnabled();
});

test("credit is a checkout outcome: attached customer shown, no credit or DigiPay in the selector, no payment row, server rule mapped", async ({ page, api }) => {
  const s = pos(api, { customerId: "c1", receivedAmount: "50000" });
  let first = true;
  api.handlers.set(`POST /invoices/${INV}/finalize`, async (route: Route) => {
    s.finalized++; s.finalizeKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (first) { first = false; await route.fulfill({ status: 422, json: { error: { code: "credit_needs_customer", message: "raw" } } }); return; }
    await route.fulfill({ json: { ...s.invoice, status: "finalized", number: "MAIN-78", paidAmount: "50000", replayed: false } });
  });
  await open(page);
  const who = page.getByRole("region", { name: "مشتری" });
  await expect(who).toContainText("مریم آزمون");
  await expect(who).toContainText("09121234567");
  const selector = page.getByRole("region", { name: "روش پرداخت" });
  await selector.getByRole("button", { name: "روش‌های بیشتر" }).click();
  await expect(selector.getByRole("button", { name: "نسیه" })).toHaveCount(0);
  await expect(selector.getByText("دیجی‌پی")).toHaveCount(0);
  await expect(selector.getByRole("button", { name: "درگاه پرداخت", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "ثبت نسیه", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ثبت فروش نسیه" });
  await expect(dialog).toContainText("مریم آزمون");
  await expect(dialog).toContainText("15٬000");
  await dialog.getByRole("button", { name: "تأیید و ثبت نسیه", exact: true }).click();
  await expect(dialog).toContainText("برای فروش نسیه ابتدا مشتری را انتخاب کنید.");
  await dialog.getByRole("button", { name: "تأیید و ثبت نسیه", exact: true }).click();
  const done = page.getByRole("region", { name: /فاکتور MAIN-78 ثبت شد/ });
  await expect(done).toContainText("نسیه به حساب مشتری");
  await expect(done).toContainText("15٬000");
  expect(s.posted, "نسیه هیچ ردیف پرداختی نمی‌سازد").toEqual([]);
  expect(s.finalized).toBe(2);
  expect(s.finalizeKeys[1], "ردِ قطعی کلید را عوض نمی‌کند").toBe(s.finalizeKeys[0]);
});

test("credit without a customer guides to attaching one; points and gift card stay disabled with a visible reason until then", async ({ page, api }) => {
  const s = pos(api);
  api.handlers.set(`PATCH /invoices/${INV}/customer`, async (route: Route) => {
    s.invoice = { ...s.invoice, customerId: "c1" };
    await route.fulfill({ json: s.invoice });
  });
  await open(page);
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toHaveCount(0);
  const selector = page.getByRole("region", { name: "روش پرداخت" });
  await selector.getByRole("button", { name: "روش‌های بیشتر" }).click();
  for (const name of ["امتیاز باشگاه", "کارت هدیه"]) await expect(selector.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(selector.getByText("ابتدا مشتری را به فاکتور وصل کنید.").first()).toBeVisible();
  await page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true }).click();
  const mobile = page.getByLabel("موبایل مشتری", { exact: false });
  await expect(mobile).toBeFocused();
  await mobile.fill("۰۹۱۲۱۲۳۴۵۶۷");
  await page.getByRole("button", { name: "افزودن مشتری", exact: true }).click();
  await expect(page.getByRole("region", { name: "مشتری" })).toContainText("مریم آزمون");
  for (const name of ["امتیاز باشگاه", "کارت هدیه"]) await expect(selector.getByRole("button", { name, exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toBeVisible();
});

test("credit is hidden without sale.credit; SnapPay appears only when the server lists it for this branch", async ({ page, api }) => {
  pos(api, { customerId: "c1" });
  api.handlers.set("GET /auth/can", async (route: Route, url: URL) => {
    await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "sale.credit" ? "deny" : "allow", approver: null, reason: "" } });
  });
  await open(page);
  await expect(page.getByRole("region", { name: "مشتری" })).toContainText("مریم آزمون");
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true })).toHaveCount(0);
  expect(api.calls).toContain("GET /payment-methods?branchId=b1");
  await expect(page.getByRole("button", { name: /اسنپ‌پی/ })).toHaveCount(0);

  api.defaults["GET /payment-methods"] = { methods: [...METHODS, { code: "snappay", name: "اسنپ‌پی — ثبت دستی تأییدشده", kind: "gateway", requiresRef: true }] };
  await page.reload();
  const snapp = method(page, "اسنپ‌پی — ثبت دستی تأییدشده");
  await expect(snapp).toBeVisible();
  await snapp.click();
  await expect(page.getByText("ثبت دستی پرداختی که در اسنپ‌پی تأیید شده است")).toBeVisible();
});

test("keyboard: Enter picks a method and focuses the amount; Escape closes the price panel and the finalize dialog", async ({ page, api }) => {
  pos(api);
  await open(page);
  await method(page, "کارت‌خوان").focus();
  await page.keyboard.press("Enter");
  await expect(method(page, "کارت‌خوان")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toBeFocused();

  await page.getByRole("button", { name: "تغییر قیمت شلوار کتان" }).click();
  await expect(page.getByLabel(/قیمت واحد/)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel(/قیمت واحد/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "تغییر قیمت شلوار کتان" })).toHaveAttribute("aria-expanded", "false");

  await method(page, "نقدی").click();
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  const finalize = page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true });
  await expect(finalize).toBeEnabled();
  await finalize.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "نهایی‌کردن فاکتور" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "نهایی‌کردن فاکتور" })).toHaveCount(0);
});

test("layout: no page overflow, two columns from 900 with finalize in view, mobile summary below 900", async ({ page, api }) => {
  pos(api);
  await open(page);
  const own = page.viewportSize()!;
  // هر پروژه عرض خودش را می‌سنجد (ماتریس ۶ عرض × ۲ موتور × ۲ تم)؛ ۳۹۰ و ۴۱۲ که در
  // ماتریس نیستند، فقط در پروژه‌های ۳۷۵ و بی ناوبری دوباره سنجیده می‌شوند.
  const widths = own.width === 375 ? [375, 390, 412] : [own.width];
  for (const width of widths) {
    await page.setViewportSize({ width, height: own.height });
    await page.evaluate(() => window.scrollTo(0, 0));
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, `${width}: no page-level horizontal overflow`).toBeLessThanOrEqual(size.client);
    const cart = (await page.locator(".cart").boundingBox())!, pay = (await payPanel(page).boundingBox())!;
    const finalize = page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true });
    if (width >= 900) {
      expect(Math.abs(cart.y - pay.y), `${width}: cart and payment side by side`).toBeLessThan(2);
      await expect(finalize, `${width}: finalize visible without scrolling`).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(finalize, `${width}: payment panel stays in view (sticky)`).toBeInViewport();
      await expect(page.locator(".pos-mobile-summary")).toBeHidden();
    } else {
      expect(pay.y, `${width}: payment below the cart`).toBeGreaterThan(cart.y);
      const summary = page.getByRole("complementary", { name: "خلاصهٔ پرداخت" });
      await expect(summary).toBeVisible();
      await expect(summary).toContainText("۲ ردیف · ۳ عدد");
      await summary.getByRole("button", { name: "رفتن به پرداخت" }).click();
      await expect(method(page, "کارت‌خوان")).toBeInViewport();
    }
  }
});
