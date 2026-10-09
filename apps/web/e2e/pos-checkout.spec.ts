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
/**
 * سبد بازیابی‌شده + پرداخت و نهایی‌سازی ماک، با شمارش آنچه واقعاً فرستاده شد.
 *
 * پرداخت‌ها مثل سرور به **شناسه** (`Idempotency-Key`) ثبت می‌شوند: همان کلید با
 * همان بدنه Replay است، نه ردیف دوم. `intents` همان قرارداد
 * `GET|POST /invoices/:id/payment-intents/:key[/abandon]` است و نهایی‌سازی
 * `settlement` را از وضعیت **همان لحظه** می‌سازد، نه از آنچه صفحه دیده بود.
 */
function pos(api: MockApi, over: Partial<typeof draft> = {}, methods = METHODS) {
  const state = { invoice: { ...draft, ...over }, payments: [] as Array<{ id: string; name: string; amount: string }>, posted: [] as Pay[], keys: [] as string[], finalized: 0, finalizeKeys: [] as string[],
    byKey: new Map<string, { id: string; body: Pay }>(), sealed: new Set<string>(), intentChecks: [] as string[] };
  const received = () => state.payments.reduce((n, p) => n + BigInt(p.amount), BigInt(over.receivedAmount ?? "0")).toString();
  /** ثبت با شناسه — همان کاری که `runOnce` + `client_event_id` می‌کنند. */
  const record = (key: string, body: Pay) => {
    const name = METHODS.find((m) => m.code === body.methodCode)?.name ?? body.methodCode;
    const id = "p" + (state.payments.length + 1);
    state.payments.push({ id, name, amount: body.amount });
    state.byKey.set(key, { id, body });
    return id;
  };
  const settlement = () => {
    const payable = BigInt(state.invoice.payableAmount), got = BigInt(received());
    const paid = got < payable ? got : payable;
    return { payableAmount: payable.toString(), paidAmount: paid.toString(), receivedAmount: got.toString(),
      changeAmount: (got - paid).toString(), dueAmount: (payable - paid).toString() };
  };
  api.defaults["GET /payment-methods"] = { methods };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ME, branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-10-01T07:00:00Z" };
  api.defaults["GET /gift-options"] = { options: [] };
  api.handlers.set(`GET /invoices/${INV}`, async (route) => { await route.fulfill({ json: { ...state.invoice, receivedAmount: received() } }); });
  api.handlers.set(`GET /invoices/${INV}/customer`, async (route) => { await route.fulfill({ json: { customer: state.invoice.customerId ? customer : null } }); });
  api.handlers.set(`GET /invoices/${INV}/payments`, async (route) => { await route.fulfill({ json: { payments: state.payments } }); });
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route) => {
    const body = route.request().postDataJSON() as Pay, key = route.request().headers()["idempotency-key"] ?? "";
    state.posted.push(body); state.keys.push(key);
    const seen = state.byKey.get(key);
    if (seen) { await route.fulfill({ status: 200, json: { paymentId: seen.id, replayed: true, receivedAmount: received(), invoice: state.invoice } }); return; }
    const id = record(key, body);
    await route.fulfill({ status: 201, json: { paymentId: id, replayed: false, receivedAmount: received(), invoice: state.invoice } });
  });
  api.handlers.set(`POST /invoices/${INV}/finalize`, async (route) => {
    state.finalized++; state.finalizeKeys.push(route.request().headers()["idempotency-key"] ?? "");
    await route.fulfill({ json: { ...state.invoice, status: "finalized", number: "MAIN-77", paidAmount: settlement().paidAmount, replayed: false, settlement: settlement() } });
  });
  return Object.assign(state, { record, settlement });
}

/** قرارداد وضعیت قصد پرداخت — مسیرش شناسه دارد، پس با `page.route` (اولویت بر ماک عمومی). */
async function intents(page: Page, s: ReturnType<typeof pos>) {
  await page.route(`**/api/invoices/${INV}/payment-intents/**`, async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/"), abandon = parts.at(-1) === "abandon";
    const key = decodeURIComponent(abandon ? parts.at(-2)! : parts.at(-1)!);
    s.intentChecks.push(`${route.request().method()} ${key}`);
    const hit = s.byKey.get(key);
    if (hit) { await route.fulfill({ json: { state: "recorded", terminal: true, payment: { id: hit.id, methodCode: hit.body.methodCode, amount: hit.body.amount, refNo: hit.body.refNo ?? null, status: "succeeded" } } }); return; }
    if (abandon) s.sealed.add(key);
    await route.fulfill({ json: s.sealed.has(key) ? { state: "abandoned", terminal: true } : { state: "not_found", terminal: false } });
  });
}

async function open(page: Page, s?: ReturnType<typeof pos>) {
  if (s) await intents(page, s);
  await page.addInitScript(([inv, sh]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: sh })), [INV, SHIFT]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
}
const payPanel = (page: Page) => page.getByRole("complementary", { name: "پرداخت", exact: true });
const selector = (page: Page) => page.getByRole("region", { name: "روش پرداخت" });
const method = (page: Page, name: string) => selector(page).getByRole("button", { name, exact: true });
const moreToggle = (page: Page) => selector(page).getByRole("button", { name: /^روش‌های بیشتر/ });
/** روش‌های غیراصلی (از جمله نقدی) زیر «روش‌های بیشتر»اند (POS-08): اگر بسته است، اول بازش کن. */
async function pick(page: Page, name: string) {
  if (!(await method(page, name).isVisible())) await moreToggle(page).click();
  await method(page, name).click();
}

test("required customer policy blocks new payment until a customer is linked", async ({page, api}) => {
  const s = pos(api);
  api.defaults["GET /pos/policy"] = { requireCustomer: true };
  api.handlers.set(`PATCH /invoices/${INV}/customer`, async route => {
    s.invoice = { ...s.invoice, customerId: "c1" }; await route.fulfill({ json: s.invoice });
  });
  await open(page);
  const mobile = page.getByLabel("موبایل مشتری (الزامی)", { exact: true });
  await expect(mobile).toHaveAttribute("required", "");
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  await payPanel(page).getByRole("button", { name: "ثبت شماره مشتری", exact: true }).click();
  await expect(mobile).toBeFocused();
  await mobile.fill("09121234567");
  await page.getByRole("button", { name: "افزودن مشتری", exact: true }).click();
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  expect(s.posted).toEqual([]);
});

test("customer policy refreshes after returning to the till and can become optional again", async ({page, api}) => {
  pos(api); await open(page);
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  api.defaults["GET /pos/policy"] = { requireCustomer: true };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("موبایل مشتری (الزامی)", { exact: true })).toBeVisible();
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  api.defaults["GET /pos/policy"] = { requireCustomer: false };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("موبایل مشتری", { exact: false })).not.toHaveAttribute("required", "");
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
});

test("changing a required customer never keeps the previous identity or permits a phone-less credit sale", async ({page, api}) => {
  const s = pos(api, { customerId: "c1" });
  api.defaults["GET /pos/policy"] = { requireCustomer: true };
  await open(page);
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  let waiting: Route | undefined;
  api.handlers.set(`GET /invoices/${INV}/customer`, async route => { waiting = route; });
  api.handlers.set(`PATCH /invoices/${INV}/customer`, async route => {
    s.invoice = { ...s.invoice, customerId: "c2" }; await route.fulfill({ json: s.invoice });
  });
  const region = page.getByRole("region", { name: "مشتری", exact: true });
  await region.getByRole("button", { name: "تغییر مشتری", exact: true }).click();
  await page.getByLabel("شمارهٔ مشتری تازه", { exact: true }).fill("09121111111");
  await region.getByRole("button", { name: "تغییر مشتری", exact: true }).click();
  await expect.poll(() => Boolean(waiting)).toBe(true);
  await expect(region).not.toContainText("مریم آزمون");
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  await waiting!.fulfill({ json: { customer: { ...customer, id: "c2", fullName: "مشتری بدون شماره", mobile: null } } });
  await expect(region).toContainText("مشتری بدون شماره");
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toBeDisabled();
  expect(s.posted).toEqual([]);
});

test("unavailable customer policy has an explicit recovery action and never enables anonymous payment", async ({page, api}) => {
  const s = pos(api);
  api.handlers.set("GET /pos/policy", async route => { await route.abort(); });
  await open(page);
  await expect(page.getByText("تنظیمات صندوق خوانده نشد؛ دریافت وجه تا بررسی آن بسته است.", { exact: false })).toBeVisible();
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  api.handlers.delete("GET /pos/policy");
  await page.getByRole("button", { name: "بررسی دوباره", exact: true }).click();
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  expect(s.posted).toEqual([]);
});

test("clicking the line amount opens the existing unit-price editor in Toman", async ({page, api}) => {
  const s=pos(api); const prices:unknown[]=[];
  api.handlers.set(`PATCH /invoices/${INV}/lines/l1/price`,async route=>{
    prices.push(route.request().postDataJSON());
    s.invoice={...s.invoice,lines:s.invoice.lines.map(l=>l.id==='l1'?{...l,unitPrice:'350000',netAmount:'700000'}:l)};
    await route.fulfill({json:s.invoice});
  });
  await open(page);
  await page.getByRole("button", {name:"ویرایش قیمت شلوار کتان", exact:true}).click();
  await expect(page.getByLabel(/قیمت واحد/)).toHaveValue("5000");
  await expect(page.getByRole("button", {name:"تغییر قیمت شلوار کتان", exact:true})).toHaveAttribute("aria-expanded","true");
  await page.getByLabel(/قیمت واحد/).fill("35000");
  await page.getByRole("button",{name:"ثبت قیمت",exact:true}).click();
  await expect.poll(()=>prices).toEqual([{unitPrice:"350000"}]);
  await page.getByRole("button", {name:"ویرایش قیمت شلوار کتان", exact:true}).click();
  await expect(page.getByLabel(/قیمت واحد/)).toHaveValue("35000");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel(/قیمت واحد/)).toHaveCount(0);
});

test("customer entry precedes product entry on a fresh sale and a fresh phone requires a name before linking", async ({page, api}) => {
  const s=pos(api); s.invoice={...s.invoice,lines:[]};
  let creates=0; const attached: unknown[]=[];
  api.handlers.set("POST /invoices",async route=>{creates++;await route.fulfill({json:s.invoice})});
  api.handlers.set(`PATCH /invoices/${INV}/customer`,async route=>{
    const body=route.request().postDataJSON(); attached.push(body);
    if(!body.fullName) {await route.fulfill({status:409,json:{error:{code:"customer_name_required",message:"نام مشتری تازه را وارد کنید"}}});return;}
    s.invoice={...s.invoice,customerId:"c1"};await route.fulfill({json:s.invoice});
  });
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  const mobile=page.getByLabel("موبایل مشتری",{exact:false});
  const picker=page.getByLabel("نام، کد یا بارکد محصول",{exact:false});
  expect((await mobile.boundingBox())!.y).toBeLessThan((await picker.boundingBox())!.y);
  await mobile.fill("۰۹۱۲۱۲۳۴۵۶۷");await page.getByRole("button",{name:"افزودن مشتری",exact:true}).click();
  await expect(page.getByLabel("نام و نام خانوادگی مشتری")).toBeVisible();
  await expect(page.getByRole("button",{name:"ثبت نام و افزودن مشتری",exact:true})).toBeDisabled();
  expect(s.invoice.customerId).toBeNull();
  await page.getByLabel("نام و نام خانوادگی مشتری").fill("مریم آزمون");
  await page.getByRole("button",{name:"ثبت نام و افزودن مشتری",exact:true}).click();
  await expect(page.getByRole("region",{name:"مشتری"})).toContainText("مریم آزمون");
  expect(creates).toBe(1);
  expect(attached).toEqual([{mobile:"09121234567",requireNameForNew:true},{mobile:"09121234567",requireNameForNew:true,fullName:"مریم آزمون"}]);
});

test("known customer attaches without asking for a replacement name",async({page,api})=>{
  const s=pos(api);
  api.handlers.set(`PATCH /invoices/${INV}/customer`,async route=>{s.invoice={...s.invoice,customerId:"c1"};await route.fulfill({json:s.invoice})});
  await open(page);await page.getByLabel("موبایل مشتری",{exact:false}).fill("09121234567");
  await page.getByRole("button",{name:"افزودن مشتری",exact:true}).click();
  await expect(page.getByRole("region",{name:"مشتری"})).toContainText("مریم آزمون");
  await expect(page.getByLabel("نام و نام خانوادگی مشتری")).toHaveCount(0);
});

test("unnamed existing customer offers correction only with customer.manage",async({page,api})=>{
  pos(api,{customerId:"c1"});
  api.handlers.set(`GET /invoices/${INV}/customer`,async route=>{await route.fulfill({json:{customer:{...customer,fullName:null}}})});
  api.handlers.set("GET /auth/can",async(route,url)=>{await route.fulfill({json:{verdict:url.searchParams.get("operation")==="customer.manage"?"deny":"allow",reason:"",approver:null}})});
  await open(page);
  await expect(page.getByRole("region",{name:"مشتری"})).toContainText("مجوز مدیریت مشتری");
  await expect(page.getByRole("button",{name:"تکمیل نام مشتری",exact:true})).toHaveCount(0);
});

test("manager can complete an existing unnamed customer through the audited customer edit route",async({page,api})=>{
  pos(api,{customerId:"c1"}); let name: string | null=null; const writes:unknown[]=[];
  api.handlers.set(`GET /invoices/${INV}/customer`,async route=>{await route.fulfill({json:{customer:{...customer,fullName:name}}})});
  api.handlers.set("PATCH /customers/c1",async route=>{const body=route.request().postDataJSON();writes.push(body);name=body.fullName;await route.fulfill({json:{...customer,fullName:name}})});
  await open(page);await page.getByRole("button",{name:"تکمیل نام مشتری",exact:true}).click();
  await page.getByLabel("نام و نام خانوادگی مشتری").fill("نام تکمیل‌شده");
  await page.getByRole("button",{name:"ذخیره نام مشتری",exact:true}).click();
  await expect(page.getByRole("region",{name:"مشتری"})).toContainText("نام تکمیل‌شده");
  expect(writes).toEqual([{fullName:"نام تکمیل‌شده"}]);
});

test("configured DigiPay records only explicit manual payment with reference; payment link stays unavailable",async({page,api})=>{
  const s=pos(api);await open(page);await method(page,"دیجی‌پی").click();
  await expect(page.getByRole("radio",{name:"لینک پرداخت",exact:true})).toBeDisabled();
  const receive=page.getByRole("button",{name:"دریافت وجه",exact:true});
  await receive.click();
  expect(s.posted).toEqual([]);
  await expect(page.getByLabel("شماره پیگیری",{exact:true})).toHaveAttribute("aria-invalid","true");
  await expect(page.getByText("شمارهٔ پیگیری لازم است.",{exact:true})).toBeVisible();
  await page.getByLabel("شماره پیگیری",{exact:true}).fill("DIGI-MANUAL-1");
  await receive.click();
  await expect.poll(()=>s.posted).toEqual([{methodCode:"digipay",amount:"200000",refNo:"DIGI-MANUAL-1"}]);
  expect(api.calls.some(c=>/payment-link|providers\//.test(c))).toBe(false);
});

test("proforma prints the saved draft once in the same tab without payment or finalization", async ({ page, api }) => {
  const s = pos(api);
  let prints = 0;
  await page.exposeFunction("recordProformaPrint", () => { prints++; });
  await page.addInitScript(() => {
    if (window.parent !== window) window.print = () => {
      if (!document.body.textContent?.includes("پیش‌فاکتور")) throw new Error("not a proforma");
      Reflect.get(window,"recordProformaPrint")(); window.dispatchEvent(new Event("afterprint"));
    };
  });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  api.handlers.set(`GET /invoices/${INV}/proforma-print`, async route => {
    await ready;
    await route.fulfill({contentType:"text/html",body:'<!doctype html><html><body><div class="sheet">پیش‌فاکتور — شلوار کتان<table class="totals"><tr><td>20,000 تومان</td></tr></table></div><button id="print-btn">چاپ</button></body></html>'});
  });
  await open(page,s);
  const button = page.getByRole("button",{name:"چاپ پیش‌فاکتور",exact:true});
  await expect(button).toBeEnabled();
  const mutations = api.calls.filter(call => !call.startsWith("GET "));
  await button.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect(page.getByRole("button",{name:"در حال آماده‌سازی پیش‌فاکتور…",exact:true})).toBeDisabled();
  await expect(method(page,"کارت‌خوان")).toBeDisabled();
  release();
  await expect.poll(() => prints).toBe(1);
  await expect(button).toBeEnabled();
  expect(api.calls.filter(call => call.endsWith("/proforma-print"))).toHaveLength(1);
  expect(api.calls.filter(call => !call.startsWith("GET "))).toEqual(mutations);
  expect(s.finalized).toBe(0); expect(s.posted).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.locator('iframe[title="پیش‌فاکتور آمادهٔ چاپ"]')).toHaveCount(0);
  await expect(page.locator(".lines li")).toHaveCount(2);
});

test("proforma load failure allows safe retry and an empty draft stays disabled", async ({page,api}) => {
  const s = pos(api); await open(page,s);
  api.handlers.set(`GET /invoices/${INV}/proforma-print`, route => route.fulfill({status:409,json:{error:{code:"invoice_not_draft"}}}));
  const button = page.getByRole("button",{name:"چاپ پیش‌فاکتور",exact:true});
  await button.click();
  await expect(page.getByRole("alert").filter({hasText:"چاپ پیش‌فاکتور آغاز نشد"})).toBeVisible();
  await expect(button).toBeEnabled();
  expect(s.finalized).toBe(0); expect(s.posted).toEqual([]);
  s.invoice = {...s.invoice,lines:[]};
  await page.reload();
  await expect(button).toBeDisabled();
  expect(api.calls.filter(call => call.endsWith("/proforma-print"))).toHaveLength(1);
});

test("cash sale: confirm dialog, one finalize under double click, persistent success with change, print and next sale", async ({ page, api }) => {
  const s = pos(api);
  await open(page);
  await expect(page.locator(".pos-bar .pill")).toHaveText("۲ ردیف · ۳ عدد");
  await expect(payPanel(page).locator(".checkout-payable")).toContainText("20٬000");
  await pick(page, "نقدی");
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
  // تسویهٔ قطعی سرور: دریافتی ۲۵٬۰۰۰ و باقی پول ۵٬۰۰۰ تا «فروش بعدی» دیده می‌مانند.
  await expect(done.locator(".checkout-lines")).toContainText("25٬000");
  await expect(done.getByRole("region", { name: "ریز پرداخت‌ها" })).toContainText("نقدی");
  const print = done.getByRole("button", { name: "چاپ رسید" });
  await expect(print).toBeEnabled();
  expect(api.calls.some(call => call.endsWith("/print")), "ثبت فروش چاپ خودکار ندارد").toBe(false);
  // چاپ دستی است: بی کلیک هیچ پنجره‌ای باز نمی‌شود و وضعیت «ثبت شد» می‌ماند.
  expect(page.context().pages()).toHaveLength(1);
  await done.getByRole("button", { name: "فروش بعدی", exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.getByText("سبد خالی است")).toBeVisible();
  await expect(page.locator(".pos-bar .pill")).toHaveText("۰ ردیف · ۰ عدد");
  // فروش بعدی سبد خالیِ **تازه** است، نه پیش‌نویس فعال: نه قصد معلقی، نه خلاصهٔ موبایل.
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toHaveCount(0);
  await expect(page.locator(".pos-mobile-summary")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("labelmod_open_cart"))).toBe("");
});

test("receipt print stays in the cashier tab, waits for fonts and the embedded logo, and prints once under double click", async ({ page, api }) => {
  const s = pos(api, { receivedAmount: "200000" });
  let prints = 0;
  await page.exposeFunction("recordReceiptPrint", () => { prints++; });
  await page.addInitScript(() => {
    if (window.parent !== window) {
      window.print = () => {
        if (document.fonts.status !== "loaded") throw new Error("receipt fonts not ready");
        // لوگوی جاسازی‌شده باید پیش از چاپ بار و رمزگشایی شده باشد.
        if (!Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)) throw new Error("receipt logo not ready");
        Reflect.get(window, "recordReceiptPrint")();
        window.dispatchEvent(new Event("afterprint"));
      };
    }
  });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  api.handlers.set(`GET /invoices/${INV}/print`, async route => {
    await ready;
    await route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" },
      body: '<!doctype html><html><body><div class="sheet"><img class="logo" alt="لیبل مد" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="><table class="totals"><tr><td>رسید</td></tr></table></div><button id="print-btn">چاپ</button></body></html>' });
  });
  await open(page, s);
  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).click();
  const button = page.getByRole("button", { name: "چاپ رسید", exact: true });
  await expect(button).toBeVisible();
  expect(prints).toBe(0);
  const mutations = api.calls.filter(call => !call.startsWith("GET "));
  await button.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect(page.getByRole("button", { name: "در حال آماده‌سازی چاپ…" })).toBeDisabled();
  expect(prints).toBe(0);
  release();
  await expect.poll(() => prints).toBe(1);
  await expect(button).toBeEnabled();
  expect(page.context().pages()).toHaveLength(1);
  expect(api.calls.filter(call => call.endsWith("/print"))).toHaveLength(1);
  expect(api.calls.filter(call => !call.startsWith("GET "))).toEqual(mutations);
  expect(s.finalized).toBe(1);
  await expect(page.locator('iframe[title="رسید آمادهٔ چاپ"]')).toHaveCount(0);
});

test("receipt with an already failed embedded logo still prints once without changing the sale", async ({ page, api }) => {
  const s = pos(api, { receivedAmount: "200000" });
  let prints = 0;
  await page.exposeFunction("recordReceiptPrint", () => { prints++; });
  await page.addInitScript(() => {
    if (window.parent !== window) window.print = () => {
      const logo = document.querySelector("img");
      if (!logo?.complete || logo.naturalWidth !== 0) throw new Error("expected failed logo");
      Reflect.get(window, "recordReceiptPrint")();
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  api.handlers.set(`GET /invoices/${INV}/print`, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><div class="sheet"><img alt="لیبل مد" src="data:image/png;base64,broken"><table class="totals"><tr><td>رسید</td></tr></table></div><button id="print-btn">چاپ</button></body></html>',
  }));
  await open(page, s);
  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).click();
  const button = page.getByRole("button", { name: "چاپ رسید", exact: true });
  await expect(button).toBeVisible();
  const mutations = api.calls.filter(call => !call.startsWith("GET "));
  await button.click();
  await expect.poll(() => prints).toBe(1);
  await expect(button).toBeEnabled();
  expect(page.context().pages()).toHaveLength(1);
  expect(api.calls.filter(call => !call.startsWith("GET "))).toEqual(mutations);
  expect(s.finalized).toBe(1);
});

test("receipt errors and timeout allow retry without reopening or mutating the sale", async ({ page, api }) => {
  const s = pos(api, { receivedAmount: "200000" });
  let prints = 0;
  await page.exposeFunction("recordReceiptPrint", () => { prints++; });
  await page.addInitScript(() => { window.print = () => { Reflect.get(window, "recordReceiptPrint")(); }; });
  api.handlers.set(`GET /invoices/${INV}/print`, route => route.fulfill({ status: 403, json: { error: { code: "branch_forbidden" } } }));
  await open(page, s);
  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).click();
  const button = page.getByRole("button", { name: "چاپ رسید", exact: true });
  // تصویر جهش‌ها پس از ثبت قطعی گرفته می‌شود، نه هم‌زمان با کلیک تأیید: روی
  // اجراکنندهٔ پربار CI پاسخ نهایی‌سازی دیرتر می‌رسید و تصویر خالی می‌ماند.
  await expect(button).toBeEnabled();
  expect(s.finalized).toBe(1);
  const mutations = api.calls.filter(call => !call.startsWith("GET "));
  await button.click();
  await expect(page.locator(".sale-complete [role=alert]")).toContainText("فروش ثبت شده است");
  await expect(button).toBeEnabled();
  await page.clock.install();
  // An indefinitely loading frame exercises the deadline independently of network error events.
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.handlers.set(`GET /invoices/${INV}/print`, async route => { await pending; await route.abort(); });
  await button.click();
  await expect(page.getByRole("button", { name: "در حال آماده‌سازی چاپ…" })).toBeDisabled();
  await page.clock.runFor(16000);
  await expect(page.locator(".sale-complete [role=alert]")).toContainText("طول کشید");
  await expect(button).toBeEnabled();
  release();
  expect(prints).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
  expect(api.calls.filter(call => !call.startsWith("GET "))).toEqual(mutations);
  expect(s.finalized).toBe(1);
});

test("card reader is primary; non-cash overpayment is blocked before any request; a server race maps to an actionable message", async ({ page, api }) => {
  const s = pos(api);
  await open(page);
  const card = method(page, "کارت‌خوان");
  const cardBox = (await card.boundingBox())!, digiBox = (await method(page, "دیجی‌پی").boundingBox())!;
  expect(cardBox.width, "کارت‌خوان تمام‌عرض و برجسته").toBeGreaterThan(digiBox.width * 1.5);
  await expect(method(page, "نقدی"), "نقدی در ردیف اصلی نیست").toBeHidden();
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
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
  await moreToggle(page).click();
  await expect(method(page, "نقدی"), "فقط یک روش انتخاب‌شده").toHaveAttribute("aria-pressed", "false");
});

const unresolvedText = "سرور هنوز پرداختی با شناسهٔ همین درخواست ندارد";
const pending = (page: Page) => page.evaluate((me) => localStorage.getItem(`labelmod_pending_payment_v1:${me}`), ME);

test("response lost: the exact intent is found recorded by its own key; no second request; controls unlock", async ({ page, api }) => {
  const s = pos(api);
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    const key = route.request().headers()["idempotency-key"] ?? "";
    s.keys.push(key); s.posted.push(route.request().postDataJSON() as Pay);
    s.record(key, route.request().postDataJSON() as Pay); // سرور ثبت کرد…
    await route.abort("connectionreset");                  // …و پاسخ گم شد.
  });
  await open(page, s);
  await pick(page, "نقدی");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toBeVisible();
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeDisabled();
  // پیش از بررسی، ارسال دوباره‌ای پیشنهاد نمی‌شود.
  await expect(page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true })).toHaveCount(0);
  expect(JSON.parse((await pending(page))!).key, "قصد پیش از ارسال پایدار شد").toBe(s.keys[0]);
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.locator(".pos-alert").filter({ hasText: "پیش‌تر ثبت شده بود" })).toBeVisible();
  expect(s.intentChecks, "همان شناسهٔ ارسال پرسیده شد").toEqual([`GET ${s.keys[0]}`]);
  expect(s.posted).toHaveLength(1);
  expect(s.payments).toHaveLength(1);
  expect(await pending(page), "حالت نهایی، قصد پایدار را پاک می‌کند").toBeNull();
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeEnabled();
});

test("same-amount collision: another payment of the same amount and method does not resolve this intent; retry keeps the key", async ({ page, api }) => {
  const s = pos(api);
  let lose = true;
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    const key = route.request().headers()["idempotency-key"] ?? "", body = route.request().postDataJSON() as Pay;
    s.keys.push(key); s.posted.push(body);
    if (lose) { lose = false; await route.abort("connectionreset"); return; } // هرگز به سرور نرسید
    const id = s.byKey.get(key)?.id ?? s.record(key, body);
    await route.fulfill({ status: 201, json: { paymentId: id, replayed: false, receivedAmount: (BigInt(s.payments.reduce((n, p) => n + BigInt(p.amount), 0n))).toString(), invoice: s.invoice } });
  });
  await open(page, s);
  await method(page, "کارت‌خوان").click();
  await page.getByLabel("مبلغ (تومان)", { exact: true }).fill("10000");
  await page.getByLabel("شماره پیگیری", { exact: true }).fill("REF-A");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toBeVisible();
  // تب یا دستگاه دیگر: پرداخت B با همان مبلغ و همان روش، شناسهٔ دیگر. جمع دریافتی دقیقاً به اندازهٔ A بالا رفت.
  s.record("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { methodCode: "card", amount: "100000", refNo: "REF-B" });
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.getByText(unresolvedText)).toBeVisible();
  await expect(page.getByText("پیش‌تر ثبت شده بود")).toHaveCount(0);
  await expect(page.getByText("سرور تأیید کرد")).toHaveCount(0);
  await expect(method(page, "کارت‌خوان"), "قصد A باز است؛ روش و مبلغ قفل").toBeDisabled();
  await expect(moreToggle(page), "روش‌های بیشتر هم قفل").toBeDisabled();
  await expect(page.getByRole("button",{name:"چاپ پیش‌فاکتور",exact:true})).toBeDisabled();
  expect(s.intentChecks).toEqual([`GET ${s.keys[0]}`]);
  await page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true }).click();
  await expect(page.locator(".pos-alert").filter({ hasText: "با همان شناسه ثبت شد" })).toBeVisible();
  expect(s.keys[1], "همان شناسه").toBe(s.keys[0]);
  expect(s.posted[1], "همان بدنه").toEqual(s.posted[0]);
  expect(s.payments.map((p) => p.amount), "A یک بار و B یک بار").toEqual(["100000", "100000"]);
  await expect(method(page, "کارت‌خوان")).toBeEnabled();
  await expect(moreToggle(page)).toBeEnabled();
});

test("reload during unknown: the intent is restored locked with its key; status checks that key; a same-key retry replays instead of duplicating", async ({ page, api }) => {
  const s = pos(api);
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    const key = route.request().headers()["idempotency-key"] ?? "", body = route.request().postDataJSON() as Pay;
    s.keys.push(key); s.posted.push(body);
    const seen = s.byKey.get(key);
    if (seen) { await route.fulfill({ status: 200, json: { paymentId: seen.id, replayed: true, receivedAmount: "200000", invoice: s.invoice } }); return; }
    await route.abort("connectionreset"); // در راه — هنوز Commit نشده
  });
  await open(page, s);
  await pick(page, "نقدی");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toBeVisible();
  const before = JSON.parse((await pending(page))!) as { key: string; amount: string; methodCode: string };
  expect(before).toMatchObject({ key: s.keys[0], amount: "200000", methodCode: "cash", state: "unresolved" });

  await page.reload();
  await expect(page.locator(".lines li").first()).toContainText("شلوار کتان");
  await expect(page.getByRole("button", { name: "بررسی وضعیت", exact: true })).toBeVisible();
  await expect(page.locator(".pay-intent")).toContainText("20٬000");
  await expect(method(page, "کارت‌خوان")).toBeDisabled();
  await expect(moreToggle(page), "روش قفل‌شدهٔ قصد پس از Reload هم روی «بیشتر» دیده می‌شود").toBeDisabled();
  await expect(moreToggle(page)).toContainText("نقدی");
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeDisabled();
  expect(s.posted, "Reload خودش چیزی نمی‌فرستد").toHaveLength(1);
  expect(JSON.parse((await pending(page))!).key, "کلید تازه ساخته نشد").toBe(before.key);

  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.getByText(unresolvedText)).toBeVisible();
  expect(s.intentChecks).toEqual([`GET ${before.key}`]);
  // نسخهٔ در راه حالا Commit می‌شود؛ ارسال دوبارهٔ همان قصد Replay می‌گیرد، نه ردیف دوم.
  s.record(before.key, s.posted[0]!);
  await page.getByRole("button", { name: "ارسال دوبارهٔ همین پرداخت", exact: true }).click();
  await expect(page.locator(".pos-alert").filter({ hasText: "با همان شناسه ثبت شد" })).toBeVisible();
  expect(s.keys).toEqual([before.key, before.key]);
  expect(s.payments).toHaveLength(1);
  expect(await pending(page)).toBeNull();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeEnabled();
});

test("unresolved intent the cashier says never happened is sealed on the server by its key before a new intent is allowed", async ({ page, api }) => {
  const s = pos(api);
  let first = true;
  api.handlers.set(`POST /invoices/${INV}/payments`, async (route: Route) => {
    const key = route.request().headers()["idempotency-key"] ?? "", body = route.request().postDataJSON() as Pay;
    s.keys.push(key); s.posted.push(body);
    if (first) { first = false; await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "x" } } }); return; }
    const id = s.record(key, body);
    await route.fulfill({ status: 201, json: { paymentId: id, replayed: false, receivedAmount: "200000", invoice: s.invoice } });
  });
  await open(page, s);
  await method(page, "کارت‌خوان").click();
  await page.getByLabel("شماره پیگیری", { exact: true }).fill("REF-X");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.getByText(unresolvedText)).toBeVisible();
  await page.getByRole("button", { name: "این پرداخت انجام نشده", exact: true }).click();
  await expect(page.locator(".pos-alert").filter({ hasText: "هرگز ثبت نمی‌شود" })).toBeVisible();
  expect(s.intentChecks).toEqual([`GET ${s.keys[0]}`, `POST ${s.keys[0]}`]);
  expect(await pending(page)).toBeNull();
  await pick(page, "نقدی");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect.poll(() => s.payments.length).toBe(1);
  expect(s.keys[1], "قصد تازه، کلید تازه").not.toBe(s.keys[0]);
  expect(s.posted[1]).toEqual({ methodCode: "cash", amount: "200000" });
});

test("SaleComplete shows the server settlement: a payment from another tab before finalize changes received and change", async ({ page, api }) => {
  const s = pos(api);
  await open(page, s);
  await pick(page, "نقدی");
  await page.getByRole("button", { name: "دریافت وجه", exact: true }).click();
  await expect(page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true })).toBeEnabled();
  // تصویر S صفحه: دریافتی ۲۰٬۰۰۰، باقی پول صفر. تب دیگر ۳٬۰۰۰ تومان نقد دیگر می‌گیرد.
  s.record("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { methodCode: "cash", amount: "30000" });
  await page.getByRole("button", { name: "نهایی‌کردن فاکتور", exact: true }).click();
  await page.getByRole("dialog", { name: "نهایی‌کردن فاکتور" }).getByRole("button", { name: "تأیید و نهایی‌کردن", exact: true }).click();
  const done = page.getByRole("region", { name: /فاکتور MAIN-77 ثبت شد/ });
  await expect(done.locator(".sale-complete-change")).toContainText("3٬000");
  await expect(done.locator(".checkout-lines")).toContainText("23٬000");
  await expect(done.locator(".checkout-lines")).toContainText("20٬000");
});

test("credit is a checkout outcome: attached customer shown, no credit in the selector, configured DigiPay manual only, no payment row, server rule mapped", async ({ page, api }) => {
  const s = pos(api, { customerId: "c1", receivedAmount: "50000" });
  let first = true;
  api.handlers.set(`POST /invoices/${INV}/finalize`, async (route: Route) => {
    s.finalized++; s.finalizeKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (first) { first = false; await route.fulfill({ status: 422, json: { error: { code: "credit_needs_customer", message: "raw" } } }); return; }
    await route.fulfill({ json: { ...s.invoice, status: "finalized", number: "MAIN-78", paidAmount: s.settlement().paidAmount, replayed: false, settlement: s.settlement() } });
  });
  await open(page, s);
  const who = page.getByRole("region", { name: "مشتری" });
  await expect(who).toContainText("مریم آزمون");
  await expect(who).toContainText("09121234567");
  const sel = selector(page);
  await moreToggle(page).click();
  await expect(sel.getByRole("button", { name: "نسیه" })).toHaveCount(0);
  await expect(sel.getByRole("button", { name: "درگاه پرداخت", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); // روی تلفن برگهٔ مودال است؛ پشتش inert است
  // انتخاب دیجی‌پی تنظیم‌شده فقط فرم دستی را باز می‌کند؛ پرداخت خودکار ندارد.
  const digi = method(page, "دیجی‌پی");
  await digi.click();
  await expect(digi).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/ثبت دستی پرداختی که در دیجی‌پی تأیید شده/)).toBeVisible();
  expect(s.posted).toEqual([]);

  await page.getByRole("button", { name: "ثبت نسیه", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ثبت فروش نسیه" });
  await expect(dialog).toContainText("مریم آزمون");
  await expect(dialog).toContainText("15٬000");
  await dialog.getByRole("button", { name: "تأیید و ثبت نسیه", exact: true }).click();
  await expect(dialog).toContainText("برای فروش نسیه ابتدا مشتری را انتخاب کنید.");
  // پیش از تلاش دوم، تب دیگر ۱۰٬۰۰۰ تومان کارت ثبت می‌کند: بدهی قطعی ۵٬۰۰۰ است، نه ۱۵٬۰۰۰ تصویر صفحه.
  s.record("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { methodCode: "card", amount: "100000", refNo: "T" });
  await dialog.getByRole("button", { name: "تأیید و ثبت نسیه", exact: true }).click();
  const done = page.getByRole("region", { name: /فاکتور MAIN-78 ثبت شد/ });
  const credit = done.locator(".checkout-lines div").filter({ hasText: "نسیه به حساب مشتری" });
  await expect(credit).toContainText("5٬000");
  await expect(credit).not.toContainText("15٬000");
  await expect(done.locator(".checkout-lines div").filter({ hasText: "دریافت‌شده" })).toContainText("15٬000");
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
  const sel = selector(page);
  await moreToggle(page).click();
  for (const name of ["امتیاز باشگاه", "کارت هدیه"]) await expect(sel.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(sel.getByText("ابتدا مشتری را به فاکتور وصل کنید.").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true }).click();
  const mobile = page.getByLabel("موبایل مشتری", { exact: false });
  await expect(mobile).toBeFocused();
  await mobile.fill("۰۹۱۲۱۲۳۴۵۶۷");
  await page.getByRole("button", { name: "افزودن مشتری", exact: true }).click();
  await expect(page.getByRole("region", { name: "مشتری" })).toContainText("مریم آزمون");
  if (!(await method(page, "کارت هدیه").isVisible())) await moreToggle(page).click();
  for (const name of ["امتیاز باشگاه", "کارت هدیه"]) await expect(sel.getByRole("button", { name, exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toBeVisible();
});

test("credit is hidden without sale.credit; SnapPay is selectable only when the server lists it for this branch", async ({ page, api }) => {
  pos(api, { customerId: "c1" });
  api.handlers.set("GET /auth/can", async (route: Route, url: URL) => {
    await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "sale.credit" ? "deny" : "allow", approver: null, reason: "" } });
  });
  await open(page);
  await expect(page.getByRole("region", { name: "مشتری" })).toContainText("مریم آزمون");
  await expect(page.getByRole("button", { name: "ثبت نسیه", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "وصل کردن مشتری برای نسیه", exact: true })).toHaveCount(0);
  expect(api.calls).toContain("GET /payment-methods?branchId=b1");
  // جای اسنپ‌پی همیشه هست (POS-06)، ولی بی ردیف سرور برای این شعبه ناموجود است و دلیلش را می‌گوید.
  const off = method(page, "اسنپ‌پی");
  await expect(off).toBeVisible();
  await expect(off).toBeDisabled();
  await expect(selector(page)).toContainText("برای این شعبه تنظیم نشده");
  await off.click({ force: true });
  await expect(page.getByLabel("مبلغ (تومان)", { exact: true })).toHaveCount(0);

  api.defaults["GET /payment-methods"] = { methods: [...METHODS, { code: "snappay", name: "اسنپ‌پی — ثبت دستی تأییدشده", kind: "gateway", requiresRef: true }] };
  await page.reload();
  const snapp = method(page, "اسنپ‌پی");
  await expect(snapp).toBeEnabled();
  await snapp.click();
  await expect(snapp).toHaveAttribute("aria-pressed", "true");
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

  await pick(page, "نقدی");
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
    if (width === own.width) await page.screenshot({ path: test.info().outputPath("pos-ux-review.png"), fullPage: true });
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
