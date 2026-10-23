/**
 * صندوق — بازطراحی بصری Batch 2.1: نیازهای مالک محصول (POS-05 تا POS-13) روی صفحهٔ واقعی.
 *
 * ترتیب و هم‌ردیفی از **جعبهٔ رندرشده** سنجیده می‌شود، نه از ترتیب DOM؛ و صداقت
 * خانه‌های بی‌پشتوانه (دیجی‌پی، «لینک پرداخت»، اسنپ‌پیِ تنظیم‌نشده) با شمردن
 * درخواست‌هایی که واقعاً فرستاده شده: هیچ‌کدام نباید هیچ اثر مالی‌ای بسازند.
 * بازطراحی مصوب مالک (۲۰۲۶/۱۰/۱۸) جای POS-05 تا POS-08 را گرفت: روش‌های فعال تراشهٔ
 * چندانتخابی‌اند و ناموجودها در بخش بازشوندهٔ ثانوی با دلیل.
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
const row = (page: Page, name: string) => page.getByRole("form", { name: `دریافت با ${name}` });
const noOverflow = async (page: Page, what: string) => {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll, `${what}: no page-level horizontal overflow`).toBeLessThanOrEqual(size.client);
};

/** «نمایش بیشتر» — دکمهٔ بازشونده؛ نامش وقتی روشی از آن انتخاب شده آن روش را هم می‌گوید. */
const moreToggle = (page: Page) => selector(page).getByRole("button", { name: /^نمایش (بیشتر|کمتر)/ });
const morePanel = (page: Page) => selector(page).locator(".pay-more-panel");
/** نمای بازبینی مالک؛ فقط با `LMC_REVIEW_SCREENSHOT`. */
const shot = async (page: Page, name: string) => {
  if (process.env.LMC_REVIEW_SCREENSHOT) await selector(page).screenshot({ path: test.info().outputPath(`pay-layout-${name}.png`) });
};
async function openMore(page: Page) {
  if ((await moreToggle(page).getAttribute("aria-expanded")) !== "true") await moreToggle(page).click();
  await expect(morePanel(page)).toBeVisible();
}

test("layout: card reader alone full width, then SnapPay | DigiPay side by side, then «نمایش بیشتر» with the rest; none preselected", async ({ page, api }) => {
  mock(api, [...METHODS, SNAPPAY]);
  await open(page);
  const tiles = selector(page).locator(".pay-tiles .pay-tile");
  // ترتیب ثابت مصوب مالک؛ دیجی‌پیِ تنظیم‌نشده هم دیده می‌شود ولی غیرفعال و با دلیل.
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAccessibleName("کارت‌خوان");
  await expect(tiles.nth(1)).toHaveAccessibleName("اسنپ‌پی");
  await expect(tiles.nth(2)).toHaveAccessibleName("دیجی‌پی");
  await expect(selector(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  await expect(method(page, "کارت‌خوان")).not.toHaveAttribute("aria-disabled", "true");
  await expect(method(page, "دیجی‌پی")).toHaveAttribute("aria-disabled", "true");
  await expect(method(page, "دیجی‌پی")).toContainText("برای این شعبه تنظیم نشده");

  const group = (await selector(page).locator(".pay-tiles").boundingBox())!;
  const card = (await tiles.nth(0).boundingBox())!, snap = (await tiles.nth(1).boundingBox())!, digi = (await tiles.nth(2).boundingBox())!;
  expect(Math.abs(card.width - group.width), "کارت‌خوان تمام‌عرض است").toBeLessThanOrEqual(1);
  expect(snap.y, "ارائه‌دهنده‌ها زیر کارت‌خوان").toBeGreaterThanOrEqual(card.y + card.height - 1);
  expect(Math.abs(snap.y - digi.y), "اسنپ‌پی و دیجی‌پی در یک ردیف").toBeLessThanOrEqual(1);
  expect(snap.x, "راست‌چین: اسنپ‌پی سمت راست دیجی‌پی").toBeGreaterThan(digi.x);
  expect(Math.abs(snap.width - digi.width), "دو ستون برابر").toBeLessThanOrEqual(1);
  expect(snap.width + digi.width, "هیچ‌کدام تمام‌عرض نیست").toBeLessThanOrEqual(group.width);
  for (const t of [card, snap, digi]) expect(t.height, "هدف لمسی").toBeGreaterThanOrEqual(44);
  for (let i = 0; i < 3; i++) {
    const clipped = await tiles.nth(i).evaluate((el) => [...el.querySelectorAll<HTMLElement>(".pay-tile-name, .pay-tile-caption")]
      .some((n) => n.scrollWidth > n.clientWidth + 1));
    expect(clipped, "نام و دلیل خانه بریده نمی‌شوند").toBe(false);
  }

  // بقیه زیر «نمایش بیشتر»، بسته و پس از ردیف ارائه‌دهنده‌ها.
  await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(morePanel(page)).toBeHidden();
  for (const name of ["نقدی", "کارت‌به‌کارت", "درگاه پرداخت"]) await expect(method(page, name)).toBeHidden();
  expect((await moreToggle(page).boundingBox())!.y).toBeGreaterThanOrEqual(snap.y + snap.height - 1);
  await shot(page, "collapsed");
  await openMore(page);
  await shot(page, "more-open");
  await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(morePanel(page).locator(".pay-chip")).toHaveText(["نقدی", "کارت‌به‌کارت", "درگاه پرداخت"]);
  for (const name of ["امتیاز باشگاه", "کارت هدیه", "لینک پرداخت"]) await expect(method(page, name), `${name} انتخاب‌شدنی نیست`).toHaveCount(0);
  const overflow = await morePanel(page).evaluate((el) => getComputedStyle(el).overflowY);
  expect(["visible", "clip"], "بخش بیشتر اسکرول تودرتو ندارد").toContain(overflow);
  await noOverflow(page, "layout");
});

test("multi-select across rows: tile and More method each get their own amount row; collapsing More keeps the selected row visible and named; Escape closes More and returns focus", async ({ page, api }) => {
  const s = mock(api);
  await open(page);
  await method(page, "کارت‌خوان").click();
  await expect(row(page, "کارت‌خوان").getByLabel("مبلغ (تومان)", { exact: true })).toBeFocused();
  await row(page, "کارت‌خوان").getByLabel("مبلغ (تومان)", { exact: true }).fill("12000");
  // صفحه‌کلید: دکمهٔ «نمایش بیشتر» با Enter باز می‌شود و تراشه با Enter انتخاب.
  await moreToggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "true");
  await method(page, "نقدی").focus();
  await page.keyboard.press("Enter");
  await expect(method(page, "نقدی")).toHaveAttribute("aria-pressed", "true");
  await expect(method(page, "کارت‌خوان")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "نقدی").getByLabel("مبلغ (تومان)", { exact: true })).toBeFocused();
  const forms = selector(page).getByRole("form");
  await expect(forms).toHaveCount(2);
  await expect(forms.nth(0)).toHaveAccessibleName("دریافت با کارت‌خوان");
  await expect(forms.nth(1)).toHaveAccessibleName("دریافت با نقدی");
  // Escape از درون بخش، آن را می‌بندد و تمرکز را به دکمه برمی‌گرداند.
  await method(page, "نقدی").focus();
  await page.keyboard.press("Escape");
  await expect(moreToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(moreToggle(page)).toBeFocused();
  await expect(morePanel(page)).toBeHidden();
  // روش انتخاب‌شده از «بیشتر» با بستن گم نمی‌شود: ردیف مبلغش دیده می‌شود و دکمه نامش را می‌برد.
  await expect(row(page, "نقدی")).toBeVisible();
  await expect(row(page, "نقدی")).toContainText("دریافت با");
  await expect(row(page, "نقدی").getByLabel("مبلغ (تومان)", { exact: true })).toBeVisible();
  await expect(moreToggle(page).locator(".pay-more-current")).toHaveText(["نقدی"]);
  await expect(row(page, "کارت‌خوان").getByLabel("مبلغ (تومان)", { exact: true }), "مبلغ قالب‌بندی‌شده دست نخورد").toHaveValue("12,000");
  await shot(page, "mixed-more-collapsed");
  // برداشتن از درون بخش، فقط همان ردیف را برمی‌دارد.
  await openMore(page);
  await method(page, "نقدی").click();
  await expect(row(page, "نقدی")).toHaveCount(0);
  await expect(moreToggle(page).locator(".pay-more-current")).toHaveCount(0);
  await expect(row(page, "کارت‌خوان").getByLabel("مبلغ (تومان)", { exact: true }), "ورودی ردیف دیگر دست نخورد").toHaveValue("12,000");
  expect(s.posted, "انتخاب و برداشتن هیچ درخواستی نمی‌سازد").toEqual([]);
  await noOverflow(page, "two rows");
});

test("unavailable: DigiPay tile is disabled with its reason on the tile; the rest list their reasons under «نمایش بیشتر»; never selectable, never a request", async ({ page, api }) => {
  const s = mock(api, [...METHODS, SNAPPAY]);
  await open(page);
  const digi = method(page, "دیجی‌پی");
  await expect(digi).toBeVisible();
  await expect(digi).toHaveAttribute("aria-disabled", "true");
  await expect(digi).toHaveAccessibleDescription(/برای این شعبه تنظیم نشده/);
  await digi.click({ force: true });
  await expect(digi).not.toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toHaveCount(0);
  const off = selector(page).locator(".pay-unavailable");
  await expect(off).toBeHidden();
  await openMore(page);
  await expect(off.locator(".pay-unavailable-head")).toHaveText("ناموجود (3)");
  await expect(off.getByRole("listitem").filter({ hasText: "لینک پرداخت" })).toContainText("ساخت لینک پرداخت هنوز در سرور پیاده نشده است");
  for (const name of ["امتیاز باشگاه", "کارت هدیه"]) await expect(off.getByRole("listitem").filter({ hasText: name })).toContainText("ابتدا مشتری را به فاکتور وصل کنید.");
  await expect(off.getByRole("button"), "در بخش ناموجود هیچ دکمه یا گزینهٔ انتخابی نیست").toHaveCount(0);
  await expect(off.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toHaveCount(0);
  expect(s.posted, "هیچ کدام از خانه‌های ناموجود درخواستی نساخت").toEqual([]);
  // اسنپ‌پی تنظیم‌شده «حضوری» است و با شمارهٔ پیگیری واقعاً فرستاده می‌شود.
  await method(page, "اسنپ‌پی").click();
  await expect(row(page, "اسنپ‌پی")).toContainText("حضوری");
  await row(page, "اسنپ‌پی").getByLabel("شماره پیگیری", { exact: true }).fill("SNP-1");
  await row(page, "اسنپ‌پی").getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect.poll(() => s.posted).toEqual([{ methodCode: "snappay", amount: "200000", refNo: "SNP-1" }]);
  expect(api.calls.filter((c) => /digipay|payment-link/i.test(c)), "هیچ مسیر ساختگی دیجی‌پی یا لینک پرداخت").toEqual([]);
});

test("credit is a separate checkout action after the payment methods and before finalize, never inside the selector", async ({ page, api }) => {
  mock(api);
  await open(page);
  const credit = page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true });
  await expect(credit).toBeVisible();
  await expect(selector(page).getByRole("button", { name: /نسیه/ })).toHaveCount(0);
  // نوار اقدام پایین ستون پرداخت چسبان است؛ ترتیب طبیعی در انتهای صفحه سنجیده می‌شود، نه وسط اسکرول.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const more = (await selector(page).locator(".pay-more").boundingBox())!, c = (await credit.boundingBox())!;
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
  await openMore(page);
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
