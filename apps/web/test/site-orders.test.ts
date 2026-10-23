/**
 * «سفارش‌های سایت» — برچسب وضعیت ثبت در Core و نگاشت وضعیت سایت.
 * ترتیب برچسب‌ها ادعاست: سفارش پرداخت‌شدهٔ خطادار «در انتظار» نیست، و پرداخت‌نشده هرگز «مشکل» نیست.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressLines, coreState, isPaymentId, isStatusSlug, moneyView, orderPath, ordersRequest, orderStatusState, type OrderCore,
} from "../src/lib/site-orders.ts";
import { STATUS } from "../src/lib/status.ts";
import { ZONES } from "../src/lib/navigation.ts";

const base: OrderCore = { paymentConfirmed: false, recorded: false, invoiceNumber: null, attempts: 0, hasError: false, stopped: false };

test("وضعیت ثبت در Core: ثبت > متوقف > خطا > در انتظار > پرداخت‌نشده", () => {
  assert.deepEqual(coreState({ ...base, recorded: true, invoiceNumber: "۱۴۰۵-۱", hasError: true, stopped: true }), { state: "completed", label: "ثبت در Core: ۱۴۰۵-۱" });
  assert.deepEqual(coreState({ ...base, recorded: true }), { state: "completed", label: "ثبت در Core" });
  assert.equal(coreState({ ...base, paymentConfirmed: true, stopped: true, hasError: true }).state, "attention");
  assert.deepEqual(coreState({ ...base, paymentConfirmed: true, hasError: true, attempts: 3 }), { state: "warning", label: "خطا در ارسال به Core (3 تلاش)" });
  assert.equal(coreState({ ...base, paymentConfirmed: true }).state, "pending");
  assert.deepEqual(coreState(base), { state: "draft", label: "پرداخت تأیید نشده" });
});

test("وضعیت سایت: هسته‌ای حالت معنایی دارد؛ افزونه‌ای «نامعلوم» است ولی پذیرفته می‌شود", () => {
  for (const s of ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "awaiting-shipment"]) {
    assert.ok(STATUS[orderStatusState(s)], s);
  }
  assert.equal(orderStatusState("processing"), "active");
  assert.equal(orderStatusState("awaiting-shipment"), "unknown", "معنای وضعیت سفارشی را این برنامه نمی‌داند");
  // وضعیت ثبت‌شدهٔ افزونه‌ای (یافتهٔ ریشه) از نشانی پذیرفته است؛ فقط شکل اسلاگ سنجیده می‌شود.
  for (const ok of ["on-hold", "awaiting-shipment", "wc_custom_1"]) assert.ok(isStatusSlug(ok), ok);
  for (const bad of ["", "PROCESSING", "a b", "x".repeat(41), "<b>"]) assert.ok(!isStatusSlug(bad), bad);
  assert.ok(isPaymentId("bacs") && isPaymentId("WC_Gateway-2"));
  assert.ok(!isPaymentId("a b") && !isPaymentId(""));
});

test("مبلغ: ریال دقیق، یا مبلغ اصلی با کد ارز؛ دلار هرگز ریال نمایش داده نمی‌شود", () => {
  assert.deepEqual(moneyView({ amount: "100", rial: "100" }, "IRR"), { kind: "rial", rial: "100" });
  assert.deepEqual(moneyView({ amount: "100", rial: "1000" }, "IRT"), { kind: "rial", rial: "1000" });
  assert.deepEqual(moneyView({ amount: "12.50", rial: null }, "USD"), { kind: "foreign", amount: "12.50", currency: "USD" });
  assert.deepEqual(moneyView({ amount: "12.55", rial: null }, "IRT"), { kind: "foreign", amount: "12.55", currency: "IRT" },
    "تومانِ با کسر ریال، با همان عدد و کد نشان داده می‌شود نه با گردکردن");
  assert.deepEqual(moneyView({ amount: "5", rial: null }, ""), { kind: "foreign", amount: "5", currency: "ارز نامعلوم" });
  assert.deepEqual(moneyView({ amount: null, rial: null }, "IRR"), { kind: "unknown" });
});

test("درخواست فهرست: فیلتر خالی نمی‌رود؛ صفحهٔ فراتر از ۲۰۰ و لنگر می‌روند؛ جست‌وجو فقط در بدنهٔ POST", () => {
  const q = { page: 1, status: null, search: null, from: null, to: null, payment: null, shipping: null, until: null };
  assert.deepEqual(ordersRequest(q), { method: "GET", path: "/web/orders?page=1" });
  assert.deepEqual(ordersRequest({ ...q, page: 201, status: "trash", from: "2026-10-01", to: "2026-10-20", payment: "bacs",
    shipping: "local_pickup", until: 1792000000 }),
  { method: "GET", path: "/web/orders?page=201&status=trash&from=2026-10-01&to=2026-10-20&payment=bacs&shipping=local_pickup&until=1792000000" });
  // بازبینی ریشه روی 2a4e62e: تلفن یا ایمیل نباید در نشانی درخواست باشد، چون لاگ دسترسی Caddy نشانی کامل را نگه می‌دارد.
  const searched = ordersRequest({ ...q, page: 3, search: "09121234567", shipping: "flat_rate", until: 1792000000 });
  assert.deepEqual(searched, { method: "POST", path: "/web/orders/search",
    body: { page: 3, shipping: "flat_rate", until: 1792000000, q: "09121234567" } });
  assert.ok(!searched.path.includes("0912"));
  assert.equal(orderPath(41, 1, 1), "/web/orders/41");
  assert.equal(orderPath(41, 3, 2), "/web/orders/41?items=3&notes=2");
  assert.equal(orderStatusState("trash"), "archived");
});

test("نشانی پستی: میدان خالی حذف می‌شود", () => {
  const empty = { firstName: "", lastName: "", company: "", address1: "", address2: "", city: "", state: "", postcode: "", country: "", phone: "" };
  assert.deepEqual(addressLines(empty), []);
  assert.deepEqual(addressLines({ ...empty, firstName: "سارا", lastName: "رضایی", city: "تهران", postcode: "123", country: "IR" }),
    ["سارا رضایی", "تهران، 123", "IR"]);
});

test("منوی «سفارش‌های سایت» فقط با web.orders.view و در گروه کار روزانه", () => {
  const z = ZONES.find(x => x.key === "site-orders");
  assert.deepEqual(z && { anyOf: z.anyOf, group: z.navGroup, mobile: z.mobilePrimary }, { anyOf: ["web.orders.view"], group: "daily", mobile: false });
});
