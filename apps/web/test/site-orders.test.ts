/**
 * «سفارش‌های سایت» — برچسب وضعیت ثبت در Core و نگاشت وضعیت سایت.
 * ترتیب برچسب‌ها ادعاست: سفارش پرداخت‌شدهٔ خطادار «در انتظار» نیست، و پرداخت‌نشده هرگز «مشکل» نیست.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreState, isOrderStatus, ORDER_STATUS_LABEL, ORDER_STATUSES, orderStatusState, type OrderCore } from "../src/lib/site-orders.ts";
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

test("هر وضعیت سایت برچسب و حالت معنایی دارد؛ ورودی نشانی فقط وضعیت شناخته‌شده را می‌پذیرد", () => {
  for (const s of [...ORDER_STATUSES, "unknown"] as const) {
    assert.ok(ORDER_STATUS_LABEL[s], s);
    assert.ok(STATUS[orderStatusState(s)], s);
  }
  assert.ok(isOrderStatus("on-hold"));
  for (const bad of ["", "trash", "wc-processing", "unknown", "PROCESSING"]) assert.ok(!isOrderStatus(bad), bad);
});

test("منوی «سفارش‌های سایت» فقط با web.orders.view و در گروه کار روزانه", () => {
  const z = ZONES.find(x => x.key === "site-orders");
  assert.deepEqual(z && { anyOf: z.anyOf, group: z.navGroup, mobile: z.mobilePrimary }, { anyOf: ["web.orders.view"], group: "daily", mobile: false });
});
