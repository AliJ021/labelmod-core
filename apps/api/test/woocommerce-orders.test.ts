/**
 * قرارداد «سفارش‌های سایت» سمت Core: امضا، مسیر، سقف بدنه، سنجش سخت پاسخ، هویت سایت و دامنه.
 * شبکه‌ای لمس نمی‌شود؛ `read` ساختگی همان امضایی را می‌سنجد که افزونه می‌سنجد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { makeWooOrdersReader } from "../src/platform/woocommerce-orders.ts";
import { resolveSafeTarget } from "../src/worker/web-push.ts";
import type { readPinnedJson } from "../src/platform/woocommerce-diagnostics.ts";

const site = { siteUrl: "https://shop.example.test/store", secret: randomBytes(32).toString("hex"),
  branchId: "00000000-0000-7000-8000-000000000001", warehouseId: "00000000-0000-7000-8000-000000000101" };
const resolve = async (url: string) => resolveSafeTarget(url, async () => ["203.0.113.4"]);
const env = { protocol: 1, siteUrl: site.siteUrl, branchId: site.branchId, warehouseId: site.warehouseId };
const order = {
  id: 41, number: "41", status: "processing", createdAt: "2026-10-20T08:00:00Z", totalRial: "12000000", itemCount: 2,
  customerName: "مشتری", paymentMethod: "زرین‌پال",
  core: { paymentConfirmed: true, recorded: true, invoiceNumber: "۱۴۰۵-۱", attempts: 1, hasError: false, stopped: false },
};
const list = (over: Record<string, unknown> = {}) => ({ ...env, page: 1, perPage: 20, status: null, total: 1, pages: 1, orders: [order], ...over });
type Read = typeof readPinnedJson;
const reader = (respond: (payload: unknown) => { status: number; body: unknown }, seen?: unknown[]) =>
  makeWooOrdersReader({ resolve, read: (async (target, body, headers, _send, maxBytes) => {
    assert.equal(target.url.pathname, "/store/wp-json/lmc/v1/orders");
    assert.deepEqual(target.ips, ["203.0.113.4"]);
    assert.equal(maxBytes, 131072, "سقف بدنهٔ فهرست، نه ۳۲ کیلوبایت تشخیص");
    const expected = createHmac("sha256", site.secret).update(`${headers["x-lmc-timestamp"]}.${headers["x-lmc-nonce"]}.${body}`).digest("hex");
    assert.equal(headers["x-lmc-signature"], "sha256=" + expected);
    seen?.push(JSON.parse(body));
    return respond(JSON.parse(body));
  }) as Read });

test("فهرست: صفحه، ۲۰تایی و فیلتر وضعیت امضاشده می‌روند؛ میدان اضافه به مرورگر نمی‌رسد", async () => {
  const seen: unknown[] = [];
  const r = await reader(() => ({ status: 200, body: list({ page: 3, status: "on-hold",
    orders: [{ ...order, billingPhone: "09121234567", email: "x@example.test" }], extra: "secret" }) }), seen).page(site, 3, "on-hold");
  assert.deepEqual(seen, [{ page: 3, perPage: 20, status: "on-hold" }]);
  assert.equal(r.state, "ready");
  const json = JSON.stringify(r);
  for (const leak of ["09121234567", "x@example.test", "secret", "siteUrl"]) assert.ok(!json.includes(leak), leak);
  assert.deepEqual(await reader(() => ({ status: 200, body: list() })).page(site, 1, null).then(x => x.state), "ready");
});

test("هویت سایت، شعبه و انبار باید همان تنظیمات Core باشند", async () => {
  for (const [over, code] of [
    [{ siteUrl: "https://evil.example.test/store" }, "site_mismatch"],
    [{ siteUrl: "https://shop.example.test/other" }, "site_mismatch"],
    [{ branchId: "00000000-0000-7000-8000-000000000002" }, "scope_mismatch"],
    [{ warehouseId: "" }, "scope_mismatch"],
  ] as const) {
    const r = await reader(() => ({ status: 200, body: list(over) })).page(site, 1, null);
    assert.equal(r.state === "unavailable" && r.code, code, JSON.stringify(over));
  }
});

test("پاسخ خارج از قرارداد «نامعلوم» است، نه فهرست", async () => {
  for (const body of [
    list({ orders: [{ ...order, totalRial: 12000000 }] }),        // پول عدد، نه رشته
    list({ orders: [{ ...order, totalRial: "12.5" }] }),
    list({ orders: [{ ...order, status: "trash" }] }),
    list({ orders: Array.from({ length: 51 }, () => order) }),
    list({ page: 2 }),                                             // صفحهٔ دیگری برگشت
    list({ status: "completed" }),                                 // فیلتر اعمال نشد
    { ...list(), protocol: 2 },
    null,
  ]) {
    const r = await reader(() => ({ status: 200, body })).page(site, 1, null);
    assert.equal(r.state === "unavailable" && r.code, "invalid_response", JSON.stringify(body)?.slice(0, 80));
  }
});

test("۴۰۴: «سفارش نیست» از افزونه جدا از «مسیر نیست» از وردپرس", async () => {
  const notFound = await reader(() => ({ status: 404, body: { code: "lmc_order_not_found", message: "x" } })).order(site, 9);
  assert.deepEqual(notFound, { state: "not_found" });
  const noRoute = await reader(() => ({ status: 404, body: { code: "rest_no_route" } })).order(site, 9);
  assert.equal(noRoute.state === "unavailable" && noRoute.code, "plugin_route");
  const listNoRoute = await reader(() => ({ status: 404, body: { code: "lmc_order_not_found" } })).page(site, 1, null);
  assert.equal(listNoRoute.state === "unavailable" && listNoRoute.code, "plugin_route", "فهرست ۴۰۴ همیشه یعنی مسیر نیست");
});

test("جزئیات: شناسهٔ دیگر یا اقلام بدشکل پذیرفته نمی‌شود", async () => {
  const detail = { ...order, items: [{ name: "پیراهن", sku: "S", quantity: 2, totalRial: "8000000" }], itemsTruncated: false,
    shippingRial: "500000", discountRial: null };
  const seen: unknown[] = [];
  const ok = await reader(() => ({ status: 200, body: { ...env, order: detail } }), seen).order(site, 41);
  assert.deepEqual(seen, [{ orderId: 41 }]);
  assert.equal(ok.state === "ready" && ok.order.items[0]!.totalRial, "8000000");
  const other = await reader(() => ({ status: 200, body: { ...env, order: { ...detail, id: 42 } } })).order(site, 41);
  assert.equal(other.state === "unavailable" && other.code, "invalid_response");
  const bad = await reader(() => ({ status: 200, body: { ...env, order: { ...detail, items: [{ name: "x", sku: "", quantity: -1, totalRial: null }] } } })).order(site, 41);
  assert.equal(bad.state === "unavailable" && bad.code, "invalid_response");
});

test("شکست امضا، تغییر مسیر و نبود کلید همان پیام‌های دروازهٔ مشترک‌اند", async () => {
  const r401 = await reader(() => ({ status: 403, body: null })).page(site, 1, null);
  assert.equal(r401.state === "unavailable" && r401.code, "authentication");
  const r302 = await reader(() => ({ status: 302, body: null })).page(site, 1, null);
  assert.equal(r302.state === "unavailable" && r302.code, "redirect");
  const r500 = await reader(() => ({ status: 500, body: null })).order(site, 1);
  assert.equal(r500.state === "unavailable" && r500.code, "remote_unavailable");
  const none = await makeWooOrdersReader({ resolve, read: async () => assert.fail("بی کلید نباید متصل شود") })
    .page({ ...site, secret: undefined }, 1, null);
  assert.equal(none.state === "unavailable" && none.code, "missing_secret");
  const unsafe = await makeWooOrdersReader({ resolve, read: async () => assert.fail("نشانی ناامن نباید متصل شود") })
    .page({ ...site, siteUrl: "http://shop.example.test" }, 1, null);
  assert.equal(unsafe.state === "unavailable" && unsafe.code, "unsafe_target");
});
