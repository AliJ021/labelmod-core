/**
 * ستون پرداخت پس از بازطراحی مصوب مالک: مبلغ روش انتخاب‌شده و «دریافت وجه» کامل دیده می‌شوند
 * و پایان چسبان یا خلاصهٔ موبایل رویشان نمی‌افتد — در دسکتاپ، دسکتاپ کوتاه (۷۶۸ ارتفاع)، ۷۶۸
 * کوتاه، و پرداخت ترکیبی. جایگزین آزمون هندسهٔ `.pay-scroll` (همان تله‌ای که حذف شد).
 * پول و Caret در pos-usability («money grouping») همچنان سنجیده می‌شوند. API ماک است.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, type MockApi } from "./fixtures";
import { expectUncovered } from "./uncovered.ts";

const INV = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const line = (i: number) => ({ id: `l${i}`, lineNo: i, variationId: `66666666-6666-4666-8666-6666666666${String(10 + i)}`,
  productName: `کالای آزمون ${i}`, sku: `SKU-${i}`, qty: "1", unitPrice: "100000", netAmount: "100000", discountAmount: "0",
  listPrice: null, priceOverrideReason: null, discountReason: null });
const draft = { id: INV, number: null, branchId: "b1", warehouseId: "w1", shiftId: SHIFT, createdBy: ME, customerId: null,
  status: "draft", channel: "pos", grossAmount: "600000", discountAmount: "0", netAmount: "600000", taxAmount: "0", shippingAmount: "0",
  payableAmount: "600000", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-01T08:00:00Z",
  lines: [1, 2, 3, 4, 5, 6].map(line) };

function mock(api: MockApi, requireCustomer = false) {
  const posted: Array<{ methodCode: string; amount: string; refNo?: string }> = [];
  let received = 0n;
  api.defaults["GET /payment-methods"] = { methods: [
    { code: "card", name: "کارت‌خوان", kind: "card_reader", requiresRef: true },
    { code: "cash", name: "نقدی", kind: "cash", requiresRef: false },
    { code: "transfer", name: "کارت‌به‌کارت", kind: "transfer", requiresRef: true },
  ] };
  api.defaults["GET /pos/policy"] = { requireCustomer, creditEnabled: true };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-10-01T07:00:00Z" };
  api.defaults["GET /gift-options"] = { options: [] };
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: { ...draft, receivedAmount: received.toString() } }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => {
    await route.fulfill({ json: { payments: posted.map((p, i) => ({ id: `p${i}`, name: p.methodCode, amount: p.amount })) } });
  });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    const body = route.request().postDataJSON() as (typeof posted)[number];
    posted.push(body); received += BigInt(body.amount);
    await route.fulfill({ status: 201, json: { paymentId: `p${posted.length}`, replayed: false, receivedAmount: received.toString(),
      invoice: { ...draft, receivedAmount: received.toString() } } });
  });
  return { posted };
}
async function open(page: Page) {
  await page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.locator(".lines li").first()).toContainText("کالای آزمون");
}
const selector = (page: Page) => page.getByRole("region", { name: "روش پرداخت" });
const chip = (page: Page, name: string) => selector(page).getByRole("button", { name, exact: true });
const row = (page: Page, name: string) => page.getByRole("form", { name: `دریافت با ${name}` });

// اندازه‌ها را خودِ آزمون می‌گذارد؛ یک پروژهٔ هر موتور و تم کافی است (۱۴۴۰ و ۷۶۸ ماتریس).
test.beforeEach(({ browserName: _engine }, info) => { test.skip(!/-(1440|768)$/.test(info.project.name), "اندازه‌ها در خودِ آزمون"); });

for (const size of [{ width: 1440, height: 960 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 768, height: 600 }]) {
  test(`mixed tender ${size.width}×${size.height}: every selected amount and its receive action are fully visible and uncovered; payloads exact`, async ({ page, api }) => {
    const s = mock(api);
    await page.setViewportSize(size);
    await open(page);
    await chip(page, "کارت‌خوان").click();
    const card = row(page, "کارت‌خوان").getByLabel("مبلغ (تومان)", { exact: true });
    await expect(card).toBeFocused();
    await expectUncovered(card, "مبلغ کارت‌خوان پس از انتخاب");
    await card.fill("25000");
    await row(page, "کارت‌خوان").getByLabel("شماره پیگیری", { exact: true }).fill("TR-1");
    await chip(page, "نقدی").click();
    const cash = row(page, "نقدی").getByLabel("مبلغ (تومان)", { exact: true });
    await expect(cash).toBeFocused();
    await expectUncovered(cash, "مبلغ نقدی (ردیف دوم)");
    await cash.fill("35000");
    for (const name of ["کارت‌خوان", "نقدی"]) {
      const btn = row(page, name).getByRole("button", { name: "دریافت وجه", exact: true });
      await btn.focus();
      await expectUncovered(btn, `دریافت وجه ${name}`);
    }
    // ردیف اول حتی پس از کار روی ردیف دوم، با فوکوس دوباره کامل دیده می‌شود.
    await card.focus();
    await expectUncovered(card, "مبلغ کارت‌خوان پس از بازگشت");
    await row(page, "کارت‌خوان").getByRole("button", { name: "دریافت وجه", exact: true }).click();
    await expect.poll(() => s.posted).toEqual([{ methodCode: "card", amount: "250000", refNo: "TR-1" }]);
    // ردیف پرداخت‌شده برداشته شد؛ ورودی نقد (پرداخت ترکیبی) ماند.
    await expect(row(page, "کارت‌خوان")).toHaveCount(0);
    await expect(cash).toHaveValue("35,000");
    await row(page, "نقدی").getByRole("button", { name: "دریافت وجه", exact: true }).click();
    await expect.poll(() => s.posted.at(-1)).toEqual({ methodCode: "cash", amount: "350000" });
    const finalize = page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true });
    await finalize.focus();
    await expectUncovered(finalize, "نهایی‌کردن");
    const size2 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size2.scroll, "بی اسکرول افقی").toBeLessThanOrEqual(size2.client);
    // هیچ اسکرول تودرتویی در ستون پرداخت نمانده است.
    const nested = await page.locator(".pay").evaluate((pay) => [pay, ...pay.querySelectorAll("*")].filter((el) => {
      const st = getComputedStyle(el); return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1;
    }).map((el) => el.className));
    expect(nested, "ستون پرداخت اسکرول تودرتو ندارد").toEqual([]);
    if (process.env.LMC_REVIEW_SCREENSHOT) await page.screenshot({ path: test.info().outputPath(`pay-${size.width}x${size.height}.png`), fullPage: true });
  });
}

test("required customer: the phone field stays visible and payment chips are locked until a customer is linked", async ({ page, api }) => {
  mock(api, true);
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page);
  const phone = page.getByLabel("موبایل مشتری", { exact: false }).first();
  await expect(phone).toBeVisible();
  await phone.focus();
  await expectUncovered(phone, "موبایل مشتری");
  await expect(chip(page, "کارت‌خوان")).toBeDisabled();
});
