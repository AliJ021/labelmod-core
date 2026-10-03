/**
 * صندوق — بازطراحی بصری Batch 2.1: نیازهای مالک محصول (POS-05 تا POS-13) روی صفحهٔ واقعی.
 *
 * ترتیب و هم‌ردیفی از **جعبهٔ رندرشده** سنجیده می‌شود، نه از ترتیب DOM؛ و صداقت
 * خانه‌های بی‌پشتوانه (دیجی‌پی، «لینک پرداخت»، اسنپ‌پیِ تنظیم‌نشده) با شمردن
 * درخواست‌هایی که واقعاً فرستاده شده: هیچ‌کدام نباید هیچ اثر مالی‌ای بسازند.
 * API ماک است (fixtures.ts)؛ قواعد مالی سرور در آزمون‌های API و SQL‌اند.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, type MockApi } from "./fixtures";

const INV = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const line = (id: string, name: string, qty: string, net: string) => ({ id, lineNo: Number(id.slice(1)), variationId: "66666666-6666-4666-8666-66666666666" + id.slice(1),
  productName: name, sku: "SKU-" + id, qty, unitPrice: (BigInt(net) / BigInt(qty)).toString(), netAmount: net, discountAmount: "0", listPrice: null, priceOverrideReason: null, discountReason: null });
const draft = { id: INV, number: null, branchId: "b1", warehouseId: "w1", shiftId: SHIFT, createdBy: ME, customerId: null as string | null,
  status: "draft", channel: "pos", grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "200000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-01T08:00:00Z",
  lines: [line("l1", "شلوار کتان", "2", "100000"), line("l2", "پیراهن کتان", "1", "100000")] };
const SNAPPAY = { code: "snappay", name: "اسنپ‌پی — ثبت دستی تأییدشده", kind: "gateway", requiresRef: true };
const METHODS = [
  { code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true },
  { code: "cash", name: "نقدی", kind: "cash", requiresRef: false },
  { code: "credit", name: "نسیه", kind: "credit", requiresRef: false },
  { code: "gateway", name: "درگاه پرداخت", kind: "gateway", requiresRef: true },
  { code: "giftcard", name: "کارت هدیه", kind: "gift_card", requiresRef: true },
  { code: "points", name: "امتیاز باشگاه", kind: "points", requiresRef: false },
  { code: "transfer", name: "کارت‌به‌کارت", kind: "transfer", requiresRef: true },
];

function mock(api: MockApi, methods = METHODS) {
  const posted: Array<{ methodCode: string; amount: string; refNo?: string }> = [];
  api.defaults["GET /payment-methods"] = { methods };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-10-01T07:00:00Z" };
  api.defaults["GET /gift-options"] = { options: [] };
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: draft }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => { await route.fulfill({ json: { payments: [] } }); });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    posted.push(route.request().postDataJSON() as (typeof posted)[number]);
    await route.fulfill({ status: 201, json: { paymentId: "p1", replayed: false, receivedAmount: "200000", invoice: draft } });
  });
  return { posted };
}
async function open(page: Page, cart = true) {
  if (cart) await page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  if (cart) await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
  else await expect(page.getByText("سبد خالی است")).toBeVisible();
}
const selector = (page: Page) => page.getByRole("region", { name: "روش پرداخت" });
const method = (page: Page, name: string) => selector(page).getByRole("button", { name, exact: true });
const moreToggle = (page: Page) => selector(page).getByRole("button", { name: /^روش‌های بیشتر/ });
const box = async (page: Page, name: string) => (await method(page, name).boundingBox())!;
const noOverflow = async (page: Page, what: string) => {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll, `${what}: no page-level horizontal overflow`).toBeLessThanOrEqual(size.client);
};

test("payment hierarchy: card reader full row first, SnapPay | DigiPay equal on one row, then More; cash not in the primary area", async ({ page, api }) => {
  mock(api, [...METHODS, SNAPPAY]);
  await open(page);
  const card = await box(page, "کارت‌خوان"), snap = await box(page, "اسنپ‌پی"), digi = await box(page, "دیجی‌پی");
  const more = (await moreToggle(page).boundingBox())!;
  expect(card.y + card.height, "ردیف ۱ بالای ردیف ۲").toBeLessThanOrEqual(Math.min(snap.y, digi.y) + 1);
  expect(Math.abs(snap.y - digi.y), "اسنپ‌پی و دیجی‌پی هم‌ردیف").toBeLessThan(1);
  expect(Math.abs(snap.height - digi.height), "هم‌ارتفاع").toBeLessThan(1);
  expect(Math.abs(snap.width - digi.width), "هم‌وزن").toBeLessThan(1);
  // RTL: اسنپ‌پی در آغاز ردیف (راست)، دیجی‌پی پس از آن.
  expect(snap.x, "اسنپ‌پی سمت آغاز (راست) ردیف").toBeGreaterThan(digi.x);
  expect(card.width, "کارت‌خوان تمام‌عرض: هم‌پهنای کل ردیف دوم").toBeGreaterThanOrEqual(snap.width + digi.width);
  expect(more.y, "روش‌های بیشتر پس از ردیف دوم").toBeGreaterThanOrEqual(snap.y + snap.height - 1);
  await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "false");
  for (const name of ["نقدی", "کارت‌به‌کارت", "درگاه پرداخت", "امتیاز باشگاه", "کارت هدیه"]) await expect(method(page, name), `${name} پنهان تا بازشدن «بیشتر»`).toBeHidden();
  // کارت‌خوان دردسترس «غیرفعال» دیده نمی‌شود: نه disabled، نه aria-disabled.
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  await expect(method(page, "کارت‌خوان")).not.toHaveAttribute("aria-disabled", "true");
});

test("More is collapsed by default and opens as an inline disclosure (desktop) or a bottom sheet (phone); picking closes it and shows the choice", async ({ page, api }) => {
  mock(api);
  await open(page);
  const narrow = page.viewportSize()!.width < 600;
  await moreToggle(page).click();
  if (narrow) await expect(page.getByRole("dialog", { name: "روش‌های بیشتر" })).toBeVisible();
  else await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "true");
  for (const name of ["نقدی", "کارت‌به‌کارت", "درگاه پرداخت", "امتیاز باشگاه", "کارت هدیه"]) await expect(method(page, name)).toBeVisible();
  await noOverflow(page, "More open");
  await page.keyboard.press("Escape");
  await expect(method(page, "نقدی")).toBeHidden();
  await expect(moreToggle(page)).toBeFocused();
  await moreToggle(page).click();
  await method(page, "نقدی").click();
  await expect(method(page, "نقدی")).toBeHidden();
  await expect(moreToggle(page), "روش انتخاب‌شده روی دکمهٔ «بیشتر» دیده می‌شود").toContainText("نقدی");
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toBeFocused();
});

test("DigiPay and the payment-link channel are visible but unavailable: explicit reason, never selectable, never a request", async ({ page, api }) => {
  const s = mock(api, [...METHODS, SNAPPAY, { code: "digipay", name: "دیجی‌پی", kind: "gateway", requiresRef: true }]);
  await open(page);
  const digi = method(page, "دیجی‌پی");
  await expect(digi).toHaveAttribute("aria-disabled", "true");
  await expect(digi).toContainText("ناموجود");
  const reasonId = (await digi.getAttribute("aria-describedby"))!.split(" ")[1]!;
  await expect(page.locator(`[id="${reasonId}"]`), "دلیل کامل به دکمه وصل است").toHaveText(/هنوز به سیستم وصل نشده/);
  await digi.click({ force: true });
  await expect(digi).not.toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: /کانال پرداخت دیجی‌پی/ })).toHaveCount(0);
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toHaveCount(0);

  await method(page, "اسنپ‌پی").click();
  const channel = page.getByRole("group", { name: "کانال پرداخت اسنپ‌پی" });
  await expect(channel.getByRole("radio", { name: "حضوری" })).toBeChecked();
  const link = channel.getByRole("radio", { name: "لینک پرداخت" });
  await expect(link).toBeDisabled();
  await expect(link).not.toBeChecked();
  await expect(channel).toContainText("ساخت لینک پرداخت هنوز در سرور پیاده نشده است");
  await link.click({ force: true });
  await expect(link).not.toBeChecked();
  expect(s.posted, "هیچ کدام از خانه‌های ناموجود درخواستی نساخت").toEqual([]);
  // «حضوری» همان ثبت دستی تأییدشده است و با شمارهٔ پیگیری واقعاً فرستاده می‌شود.
  await page.getByLabel("شماره پیگیری", { exact: true }).fill("SNP-1");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect.poll(() => s.posted).toEqual([{ methodCode: "snappay", amount: "200000", refNo: "SNP-1" }]);
  expect(api.calls.filter((c) => /digipay|payment-link/i.test(c)), "هیچ مسیر ساختگی دیجی‌پی یا لینک پرداخت").toEqual([]);
});

test("credit is a separate checkout action after the payment methods and before finalize, never inside the selector", async ({ page, api }) => {
  mock(api);
  await open(page);
  const credit = page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true });
  await expect(credit).toBeVisible();
  await expect(selector(page).getByRole("button", { name: /نسیه/ })).toHaveCount(0);
  const more = (await moreToggle(page).boundingBox())!, c = (await credit.boundingBox())!;
  const fin = (await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).boundingBox())!;
  expect(c.y, "نسیه پس از روش‌های پرداخت").toBeGreaterThan(more.y);
  expect(fin.y, "نهایی‌کردن آخرین عمل").toBeGreaterThanOrEqual(c.y);
});

test("empty cart: compact empty state, payable is unknown not zero, finalize is unmistakably disabled with its reason", async ({ page, api }) => {
  mock(api);
  await open(page, false);
  const empty = page.locator(".cart-empty");
  await expect(empty).toContainText("بارکد را اسکن کنید");
  expect((await empty.boundingBox())!.height, "حالت خالی فشرده است، نه یک قاب بزرگ تهی").toBeLessThan(200);
  await noOverflow(page, "empty cart");
  if (page.viewportSize()!.width >= 900) {
    const pay = page.getByRole("complementary", { name: "پرداخت", exact: true });
    await expect(pay.locator(".checkout-payable")).not.toContainText("0");
    await expect(pay.locator(".checkout-payable .money--unknown")).toHaveCount(1);
    const fin = page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true });
    await expect(fin).toBeDisabled();
    await expect(pay).toContainText("برای نهایی‌کردن، ابتدا کالا به سبد اضافه کنید.");
    // نه برنج: پس‌زمینهٔ CTA غیرفعال با رنگ برنج (عمل اصلی) یکی نیست.
    const [bg, accent] = await fin.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent)";
      document.body.append(probe);
      const a = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(el).backgroundColor, a];
    });
    expect(bg, "CTA غیرفعال برنجی نیست").not.toBe(accent);
    await expect(selector(page).getByRole("button", { name: "کارت‌خوان", exact: true })).toBeDisabled();
  }
});

test("populated cart and the settled state keep the page within the viewport width", async ({ page, api }) => {
  mock(api, [...METHODS, SNAPPAY]);
  await open(page);
  await noOverflow(page, "populated");
  await method(page, "اسنپ‌پی").click();
  await noOverflow(page, "SnapPay channel open");
  await expect(method(page, "اسنپ‌پی")).toHaveAttribute("aria-pressed", "true");
});

// ── پیش‌نویسِ بی‌سطر با سابقهٔ پرداخت (یافتهٔ Astra، P2) ─────────────────────
//
// «سبد خالیِ تازه» با «پیش‌نویسی که آخرین سطرش حذف شده ولی پرداختی دارد یا قصدش
// نامعلوم است» یکی نیست. اولی چیزی برای نشان دادن ندارد؛ دومی باید راه بررسی همان
// قصد و مبلغ‌های شناخته‌شده‌اش را در همهٔ عرض‌ها و پس از Reload نگه دارد.
const one = { ...draft, lines: [draft.lines[0]!], grossAmount: "100000", netAmount: "100000", payableAmount: "100000" };
const empty = { ...draft, lines: [], grossAmount: "0", netAmount: "0", payableAmount: "0" };

test("unknown payment intent survives removing the last line: recovery stays reachable on every width and after reload", async ({ page, api }) => {
  mock(api);
  let current: typeof draft = one;
  const posted: string[] = [];
  const checks: string[] = [];
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: current }); });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    posted.push(route.request().headers()["idempotency-key"] ?? "");
    await route.abort("connectionreset"); // پاسخ گم شد؛ سرور ثبت نکرده
  });
  api.handlers.set(`DELETE /invoices/${INV}/lines/l1`, async (route) => { current = empty; await route.fulfill({ json: empty }); });
  await page.route(`**/api/invoices/${INV}/payment-intents/**`, async (route) => {
    checks.push(`${route.request().method()} ${decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!)}`);
    await route.fulfill({ json: { state: "not_found", terminal: false } });
  });
  await open(page);
  if (!(await method(page, "نقدی").isVisible())) await moreToggle(page).click();
  await method(page, "نقدی").click();
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  const check = page.getByRole("button", { name: "بررسی وضعیت", exact: true });
  await expect(check).toBeVisible();
  // حذف آخرین سطر در حالی که نتیجهٔ پرداخت روشن نیست — سرور اجازه می‌دهد.
  await page.getByRole("button", { name: "حذف شلوار کتان" }).click();
  await expect(page.locator(".lines li")).toHaveCount(0);
  await expect(check, "راه بررسی همان قصد پس از حذف آخرین سطر دیده می‌ماند").toBeVisible();
  await expect(page.locator(".pay-intent")).toContainText("10٬000");
  await noOverflow(page, "zero-line draft with unknown intent");
  expect(posted, "هیچ ارسال خودکاری نیست").toHaveLength(1);

  await page.reload();
  await expect(page.getByText("سبد خالی است")).toBeVisible();
  await expect(check, "پس از Reload هم همان قصد با همان شناسه قابل بررسی است").toBeVisible();
  expect(posted, "Reload چیزی نمی‌فرستد").toHaveLength(1);
  await check.click();
  await expect(page.getByText("سرور هنوز پرداختی با شناسهٔ همین درخواست ندارد")).toBeVisible();
  expect(checks, "همان شناسهٔ ارسال پرسیده شد").toEqual([`GET ${posted[0]}`]);
  await expect(page.getByRole("button", { name: "این پرداخت انجام نشده", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true })).toBeVisible();
  expect(posted, "بررسی وضعیت ارسال دوباره نیست").toHaveLength(1);
});

test("a zero-line draft that already received money shows the known amounts, not dashes", async ({ page, api }) => {
  mock(api);
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: { ...empty, receivedAmount: "50000" } }); });
  await page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.getByText("سبد خالی است")).toBeVisible();
  const pay = page.getByRole("complementary", { name: "پرداخت", exact: true });
  await expect(pay, "پرداخت ثبت‌شده روی پیش‌نویس، ستون پرداخت را در همهٔ عرض‌ها نگه می‌دارد").toBeVisible();
  await expect(pay.locator(".checkout-payable .money--unknown"), "قابل پرداختِ شناخته‌شده «—» نیست").toHaveCount(0);
  await expect(pay.locator(".checkout-payable")).toContainText("0");
  await expect(pay.locator(".checkout-lines--state")).toContainText("5٬000");
  await expect(pay.getByRole("region", { name: "پرداخت‌های ثبت‌شده" })).toBeVisible();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }), "بی سطر نهایی نمی‌شود").toBeDisabled();
  await noOverflow(page, "zero-line draft with money");
});

test("a fresh empty cart stays quiet: no draft, no payment history, payable unknown, payment column hidden below 900", async ({ page, api }) => {
  mock(api);
  await open(page, false);
  const pay = page.getByRole("complementary", { name: "پرداخت", exact: true });
  if (page.viewportSize()!.width < 900) {
    await expect(pay).toBeHidden();
    await expect(page.locator(".pos-mobile-summary")).toBeHidden();
  } else {
    await expect(pay.locator(".checkout-payable .money--unknown")).toHaveCount(1);
  }
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toHaveCount(0);
});
