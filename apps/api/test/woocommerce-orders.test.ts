/**
 * قرارداد «سفارش‌های سایت» سمت Core (قرارداد ۲): امضا، مسیر، سقف بدنه، سنجش سخت پاسخ، هویت سایت، دامنه،
 * بازتاب صفحه/لنگر/فیلتر، و تبدیل پول فقط با ارز خودِ سفارش.
 * شبکه‌ای لمس نمی‌شود؛ `read` ساختگی همان امضایی را می‌سنجد که افزونه می‌سنجد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { lineDiscount, makeWooOrdersReader, toRial, type WooOrdersQuery } from "../src/platform/woocommerce-orders.ts";
import { resolveSafeTarget } from "../src/worker/web-push.ts";
import type { readPinnedJson } from "../src/platform/woocommerce-diagnostics.ts";

const site = { siteUrl: "https://shop.example.test/store", secret: randomBytes(32).toString("hex"),
  branchId: "00000000-0000-7000-8000-000000000001", warehouseId: "00000000-0000-7000-8000-000000000101" };
const resolve = async (url: string) => resolveSafeTarget(url, async () => ["203.0.113.4"]);
const env = { protocol: 2, siteUrl: site.siteUrl, branchId: site.branchId, warehouseId: site.warehouseId };
const core = { paymentConfirmed: true, recorded: true, invoiceNumber: "۱۴۰۵-۱", attempts: 1, hasError: false, stopped: false };
const order = {
  id: 41, number: "41", status: "processing", statusLabel: "در حال انجام", createdAt: "2026-10-20T08:00:00Z",
  currency: "IRR", total: "12000000", itemCount: 2, customerName: "مشتری", customerType: "guest",
  paymentMethodId: "zarinpal", paymentMethod: "زرین‌پال", core,
};
const UNTIL = 1792000000;
const filters = { status: null, search: false, dateFrom: null, dateTo: null, paymentMethod: null };
const list = (over: Record<string, unknown> = {}) => ({ ...env, page: 1, perPage: 20, until: UNTIL, filters,
  statuses: [{ slug: "processing", label: "در حال انجام" }, { slug: "awaiting-shipment", label: "منتظر ارسال" }],
  paymentMethods: [{ id: "zarinpal", title: "زرین‌پال" }], total: 1, pages: 1, orders: [order], ...over });
const q = (over: Partial<WooOrdersQuery> = {}): WooOrdersQuery => ({ page: 1, status: null, search: null, dateFrom: null,
  dateTo: null, paymentMethod: null, until: null, ...over });
const addr = { firstName: "سارا", lastName: "رضایی", company: "", address1: "خیابان ۱", address2: "", city: "تهران",
  state: "THR", postcode: "1234567890", country: "IR", phone: "09121234567" };
const detail = (over: Record<string, unknown> = {}) => ({
  ...order, core: { ...core, scheduled: false, missingSku: 0, missingMapping: 1 },
  billing: { ...addr, email: "sara@example.test" }, shipping: addr, customerNote: "زنگ نزنید",
  payment: { methodId: "zarinpal", method: "زرین‌پال", transactionId: "A1B2", paidAt: "2026-10-20T08:01:00Z" },
  totals: { subtotal: "12500000", discount: "1000000", discountTax: "0", shipping: "500000", shippingTax: "0", tax: "0",
    total: "12000000", refunded: "0" },
  items: { page: 1, perPage: 25, total: 1, rows: [{ id: 7, name: "پیراهن - آبی، M", sku: "S-1", quantity: 2,
    attributes: [{ key: "رنگ", value: "آبی" }], subtotal: "12500000", subtotalTax: "0", total: "11500000", tax: "0",
    productExists: true, mapped: true }] },
  fees: [{ name: "بسته‌بندی", total: "0", tax: "0" }],
  shippingLines: [{ method: "پیک", total: "500000", tax: "0" }],
  coupons: [{ code: "off10", discount: "1000000", discountTax: "0" }],
  refunds: [], refundsTruncated: false,
  notes: { page: 1, perPage: 20, hasMore: false, rows: [{ id: 3, createdAt: "2026-10-20T08:02:00Z", content: "پرداخت تأیید شد",
    customerNote: false, addedBy: "system" }] },
  ...over,
});
type Read = typeof readPinnedJson;
const reader = (respond: (payload: unknown) => { status: number; body: unknown }, seen?: unknown[], bytes = 131072) =>
  makeWooOrdersReader({ resolve, read: (async (target, body, headers, _send, maxBytes) => {
    assert.equal(target.url.pathname, "/store/wp-json/lmc/v1/orders");
    assert.deepEqual(target.ips, ["203.0.113.4"]);
    assert.equal(maxBytes, bytes, "سقف بدنه");
    const expected = createHmac("sha256", site.secret).update(`${headers["x-lmc-timestamp"]}.${headers["x-lmc-nonce"]}.${body}`).digest("hex");
    assert.equal(headers["x-lmc-signature"], "sha256=" + expected);
    seen?.push(JSON.parse(body));
    return respond(JSON.parse(body));
  }) as Read });
const detailReader = (respond: (payload: unknown) => { status: number; body: unknown }, seen?: unknown[]) => reader(respond, seen, 262144);

test("toRial: فقط IRR (×۱) و IRT (×۱۰)، با bigint؛ هر ارز دیگر یا کسر ریال نامعلوم", () => {
  // یافتهٔ ریشه روی b363e0a: IRR ۱۰۰ باید ۱۰۰ بماند و دلار هرگز ریال خوانده نشود.
  assert.equal(toRial("100", "IRR"), "100");
  assert.equal(toRial("100", "IRT"), "1000");
  assert.equal(toRial("12.5", "IRT"), "125");
  assert.equal(toRial("12.55", "IRT"), null, "کسر ریال حدس زده نمی‌شود");
  assert.equal(toRial("12.50", "IRR"), null);
  assert.equal(toRial("12.00", "IRR"), "12");
  assert.equal(toRial("100", "USD"), null, "بی قرارداد تبدیل، دلار ریال نیست");
  for (const c of ["", "irr", "EUR", "IRRR"]) assert.equal(toRial("100", c), null, c);
  assert.equal(toRial(null, "IRR"), null);
  assert.equal(toRial("-25", "IRT"), "-250");
  assert.equal(toRial("-0.0", "IRT"), "0");
  // فراتر از Number.MAX_SAFE_INTEGER، دقیق.
  assert.equal(toRial("999999999999999999", "IRT"), "9999999999999999990");
  assert.equal(toRial("123456789012345678.9", "IRT"), "1234567890123456789");
  for (const bad of ["1e3", " 1", "1.", ".5", "0x10", "1,000"]) assert.equal(toRial(bad, "IRR"), null, bad);
});

test("lineDiscount: تفاوت دقیق اعشاری، بی float", () => {
  assert.equal(lineDiscount("12500000", "11500000"), "1000000");
  assert.equal(lineDiscount("10.1", "9.95"), "0.15");
  assert.equal(lineDiscount("0.3", "0.1"), "0.2", "0.3 − 0.1 در float برابر 0.19999999999999998 است");
  assert.equal(lineDiscount("5", "7"), "-2");
  assert.equal(lineDiscount(null, "7"), null);
});

test("فهرست: صفحه، ۲۰تایی، لنگر و فیلترها امضاشده می‌روند؛ میدان اضافه به مرورگر نمی‌رسد", async () => {
  const seen: unknown[] = [];
  const query = q({ page: 3, status: "on-hold", search: "09121234567", dateFrom: "2026-10-01", dateTo: "2026-10-20",
    paymentMethod: "zarinpal", until: UNTIL });
  const r = await reader(() => ({ status: 200, body: list({ page: 3, filters: { status: "on-hold", search: true,
    dateFrom: "2026-10-01", dateTo: "2026-10-20", paymentMethod: "zarinpal" },
  orders: [{ ...order, billingPhone: "09129999999", email: "x@example.test", ip: "198.51.100.7" }], extra: "secret" }) }), seen)
    .page(site, query);
  assert.deepEqual(seen, [{ page: 3, perPage: 20, status: "on-hold", search: "09121234567", dateFrom: "2026-10-01",
    dateTo: "2026-10-20", paymentMethod: "zarinpal", until: UNTIL }]);
  assert.equal(r.state, "ready");
  const json = JSON.stringify(r);
  for (const leak of ["09129999999", "x@example.test", "198.51.100.7", "secret", "siteUrl"]) assert.ok(!json.includes(leak), leak);
  assert.ok(r.state === "ready" && r.until === UNTIL && r.statuses.length === 2 && r.paymentMethods[0]!.id === "zarinpal");
  // بی فیلتر، فقط صفحه و اندازه می‌رود؛ لنگر از پاسخ می‌آید.
  seen.length = 0;
  const first = await reader(() => ({ status: 200, body: list() }), seen).page(site, q());
  assert.deepEqual(seen, [{ page: 1, perPage: 20 }]);
  assert.equal(first.state === "ready" && first.until, UNTIL);
});

test("صفحهٔ فراتر از ۲۰۰ (بیش از ۴۰۰۰ سفارش) خوانده می‌شود", async () => {
  // یافتهٔ ریشه: PAGE_MAX=200 تاریخچهٔ پس از ۴۰۰۰ سفارش را دست‌نیافتنی می‌کرد.
  const seen: unknown[] = [];
  const r = await reader(() => ({ status: 200, body: list({ page: 201, total: 4500, pages: 225 }) }), seen).page(site, q({ page: 201, until: UNTIL }));
  assert.deepEqual(seen, [{ page: 201, perPage: 20, until: UNTIL }]);
  assert.ok(r.state === "ready" && r.page === 201 && r.pages === 225);
});

test("پول فهرست: ارز خود سفارش؛ IRR ۱۰۰ همان ۱۰۰، IRT ×۱۰، دلار مبلغ اصلی بی ریال", async () => {
  const body = list({ orders: [
    { ...order, id: 1, currency: "IRR", total: "100" },
    { ...order, id: 2, currency: "IRT", total: "100" },
    { ...order, id: 3, currency: "USD", total: "100.50" },
    { ...order, id: 4, currency: "", total: "100" },
    { ...order, id: 5, currency: "IRT", total: null },
  ] });
  const r = await reader(() => ({ status: 200, body })).page(site, q());
  assert.equal(r.state, "ready");
  if (r.state !== "ready") return;
  assert.deepEqual(r.orders.map(o => [o.currency, o.total]), [
    ["IRR", { amount: "100", rial: "100" }],
    ["IRT", { amount: "100", rial: "1000" }],
    ["USD", { amount: "100.50", rial: null }],
    ["", { amount: "100", rial: null }],
    ["IRT", { amount: null, rial: null }],
  ]);
});

test("هویت سایت، شعبه و انبار باید همان تنظیمات Core باشند", async () => {
  for (const [over, code] of [
    [{ siteUrl: "https://evil.example.test/store" }, "site_mismatch"],
    [{ siteUrl: "https://shop.example.test/other" }, "site_mismatch"],
    [{ branchId: "00000000-0000-7000-8000-000000000002" }, "scope_mismatch"],
    [{ warehouseId: "" }, "scope_mismatch"],
  ] as const) {
    const r = await reader(() => ({ status: 200, body: list(over) })).page(site, q());
    assert.equal(r.state === "unavailable" && r.code, code, JSON.stringify(over));
  }
});

test("پاسخ خارج از قرارداد یا بازتاب نادرست «نامعلوم» است، نه فهرست", async () => {
  const base = q({ status: "processing", until: UNTIL });
  const okFilters = { ...filters, status: "processing" };
  const ok = (over: Record<string, unknown> = {}) => list({ filters: okFilters, ...over });
  assert.equal((await reader(() => ({ status: 200, body: ok() })).page(site, base)).state, "ready", "کنترل مثبت");
  for (const [i, body] of [
    ok({ orders: [{ ...order, total: 12000000 }] }),               // پول عدد، نه رشته
    ok({ orders: [{ ...order, total: "1.5e3" }] }),
    ok({ orders: [{ ...order, currency: "usd" }] }),
    ok({ orders: [{ ...order, status: "Processing <b>" }] }),
    ok({ orders: Array.from({ length: 51 }, () => order) }),
    ok({ page: 2 }),                                               // صفحهٔ دیگری برگشت
    ok({ perPage: 50 }),
    ok({ until: UNTIL + 1 }),                                      // لنگر دیگری
    ok({ filters }),                                               // فیلتر وضعیت اعمال نشد
    ok({ filters: { ...okFilters, search: true } }),               // جست‌وجویی که نخواسته بودیم
    ok({ filters: { ...okFilters, dateFrom: "2026-01-01" } }),
    ok({ filters: { ...okFilters, paymentMethod: "cod" } }),
    { ...ok(), protocol: 1 },
    null,
  ].entries()) {
    const r = await reader(() => ({ status: 200, body })).page(site, base);
    assert.equal(r.state === "unavailable" && r.code, "invalid_response", `مورد ${i}`);
  }
});

test("جزئیات: آدرس، اقلام، کوپن، یادداشت و پول با ارز سفارش؛ تخفیف سطر دقیق", async () => {
  const seen: unknown[] = [];
  const ok = await detailReader(() => ({ status: 200, body: { ...env, order: detail({ secretMeta: "_lmc_hidden" }) } }), seen).order(site, 41, 1, 1);
  assert.deepEqual(seen, [{ orderId: 41 }]);
  assert.equal(ok.state, "ready");
  if (ok.state !== "ready") return;
  const o = ok.order;
  assert.equal(o.billing.email, "sara@example.test", "تماس مشتری برای مدیر حذف نمی‌شود");
  assert.equal(o.shipping.city, "تهران");
  assert.deepEqual(o.items.rows[0]!.discount, { amount: "1000000", rial: "1000000" });
  assert.deepEqual(o.items.rows[0]!.attributes, [{ key: "رنگ", value: "آبی" }]);
  assert.deepEqual(o.totals.total, { amount: "12000000", rial: "12000000" });
  assert.deepEqual(o.coupons[0]!.discount, { amount: "1000000", rial: "1000000" });
  assert.equal(o.notes.rows[0]!.content, "پرداخت تأیید شد");
  assert.equal(o.core.missingMapping, 1);
  assert.ok(!JSON.stringify(ok).includes("_lmc_hidden"), "میدان اضافه دور ریخته می‌شود");

  const usd = await detailReader(() => ({ status: 200, body: { ...env, order: detail({ currency: "USD",
    totals: { subtotal: "10.10", discount: "0.15", discountTax: "0", shipping: "0", shippingTax: "0", tax: "0", total: "9.95", refunded: "0" },
    items: { page: 1, perPage: 25, total: 1, rows: [{ id: 7, name: "x", sku: "", quantity: 1, attributes: [], subtotal: "10.10",
      subtotalTax: "0", total: "9.95", tax: "0", productExists: false, mapped: false }] } }) } })).order(site, 41, 1, 1);
  assert.ok(usd.state === "ready");
  if (usd.state !== "ready") return;
  assert.deepEqual(usd.order.totals.total, { amount: "9.95", rial: null }, "دلار بی قرارداد تبدیل ریال نمی‌شود");
  assert.deepEqual(usd.order.items.rows[0]!.discount, { amount: "0.15", rial: null });

  const irt = await detailReader(() => ({ status: 200, body: { ...env, order: detail({ currency: "IRT" }) } })).order(site, 41, 1, 1);
  assert.ok(irt.state === "ready" && irt.order.totals.total.rial === "120000000");
});

test("جزئیات: صفحهٔ اقلام و یادداشت امضاشده می‌رود و باید بازتاب شود", async () => {
  const seen: unknown[] = [];
  const body = (itemsPage: number, notesPage: number) => ({ ...env, order: detail({
    items: { ...detail().items, page: itemsPage, total: 60 }, notes: { ...detail().notes, page: notesPage, hasMore: true } }) });
  const r = await detailReader(() => ({ status: 200, body: body(3, 2) }), seen).order(site, 41, 3, 2);
  assert.deepEqual(seen, [{ orderId: 41, itemsPage: 3, notesPage: 2 }]);
  assert.ok(r.state === "ready" && r.order.items.page === 3 && r.order.notes.hasMore);
  for (const [i, n] of [[1, 2], [3, 1]] as const) {
    const bad = await detailReader(() => ({ status: 200, body: body(i, n) })).order(site, 41, 3, 2);
    assert.equal(bad.state === "unavailable" && bad.code, "invalid_response", `${i}/${n}`);
  }
});

test("جزئیات: شناسهٔ دیگر یا اقلام بدشکل پذیرفته نمی‌شود", async () => {
  const other = await detailReader(() => ({ status: 200, body: { ...env, order: detail({ id: 42 }) } })).order(site, 41, 1, 1);
  assert.equal(other.state === "unavailable" && other.code, "invalid_response");
  const rows = detail().items.rows;
  for (const row of [{ ...rows[0], quantity: -1 }, { ...rows[0], total: 11500000 }, { ...rows[0], attributes: "رنگ" }]) {
    const bad = await detailReader(() => ({ status: 200, body: { ...env, order: detail({ items: { ...detail().items, rows: [row] } }) } }))
      .order(site, 41, 1, 1);
    assert.equal(bad.state === "unavailable" && bad.code, "invalid_response", JSON.stringify(row).slice(0, 80));
  }
});

test("۴۰۴: «سفارش نیست» از افزونه جدا از «مسیر نیست» از وردپرس", async () => {
  const notFound = await detailReader(() => ({ status: 404, body: { code: "lmc_order_not_found", message: "x" } })).order(site, 9, 1, 1);
  assert.deepEqual(notFound, { state: "not_found" });
  const noRoute = await detailReader(() => ({ status: 404, body: { code: "rest_no_route" } })).order(site, 9, 1, 1);
  assert.equal(noRoute.state === "unavailable" && noRoute.code, "plugin_route");
  const listNoRoute = await reader(() => ({ status: 404, body: { code: "lmc_order_not_found" } })).page(site, q());
  assert.equal(listNoRoute.state === "unavailable" && listNoRoute.code, "plugin_route", "فهرست ۴۰۴ همیشه یعنی مسیر نیست");
});

test("۴۰۰ افزونه (فیلتر ناشناخته) «درخواست پذیرفته نشد» است، نه «افزونه خاموش است»", async () => {
  const r = await reader(() => ({ status: 400, body: { code: "lmc_bad_orders_query" } })).page(site, q({ status: "retired-status" }));
  assert.equal(r.state === "unavailable" && r.code, "bad_query");
});

test("شکست امضا، تغییر مسیر و نبود کلید همان پیام‌های دروازهٔ مشترک‌اند", async () => {
  const r401 = await reader(() => ({ status: 403, body: null })).page(site, q());
  assert.equal(r401.state === "unavailable" && r401.code, "authentication");
  const r302 = await reader(() => ({ status: 302, body: null })).page(site, q());
  assert.equal(r302.state === "unavailable" && r302.code, "redirect");
  const r500 = await detailReader(() => ({ status: 500, body: null })).order(site, 1, 1, 1);
  assert.equal(r500.state === "unavailable" && r500.code, "remote_unavailable");
  const none = await makeWooOrdersReader({ resolve, read: async () => assert.fail("بی کلید نباید متصل شود") })
    .page({ ...site, secret: undefined }, q());
  assert.equal(none.state === "unavailable" && none.code, "missing_secret");
  const unsafe = await makeWooOrdersReader({ resolve, read: async () => assert.fail("نشانی ناامن نباید متصل شود") })
    .page({ ...site, siteUrl: "http://shop.example.test" }, q());
  assert.equal(unsafe.state === "unavailable" && unsafe.code, "unsafe_target");
});
