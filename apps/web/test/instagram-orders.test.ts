import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionsFor, checkConfirm, nextShipping, normalizeUsername, ORDER_STATUS, parseQty, PAYMENT_STATE, rialFromToman, statusView, syncView,
  type OrderDetail,
} from "../src/lib/instagram-orders.ts";
import { ZONES } from "../src/lib/navigation.ts";
import { channelLabel } from "../src/lib/format.ts";

const base = { lines: [{}] as OrderDetail["lines"], shippingState: "not_started" as const };

test("دکمه‌ها همان ماتریس وضعیت سرورند: سبد فقط در پیش‌نویس؛ تأیید فقط در رزرو یا منقضی؛ ارسال فقط پس از نهایی", () => {
  const draft = actionsFor({ ...base, status: "draft", paymentState: "none" });
  assert.deepEqual(draft, { editCart: true, reserve: true, unreserve: false, cancel: true, markPayment: true, confirm: false, ship: false });
  assert.equal(actionsFor({ ...base, lines: [], status: "draft", paymentState: "none" }).reserve, false, "سبد خالی رزرو نمی‌شود");
  const reserved = actionsFor({ ...base, status: "reserved", paymentState: "none" });
  assert.equal(reserved.editCart, false, "سبد رزروشده ویرایش نمی‌شود — اول برگشت به پیش‌نویس");
  assert.equal(reserved.confirm, true);
  assert.equal(actionsFor({ ...base, status: "expired", paymentState: "none" }).confirm, true, "واریز دیررس پس از انقضا با سنجش دوباره");
  // واریز در جریان: نه لغو، نه برگشت؛ تأیید هنوز ممکن.
  const claimed = actionsFor({ ...base, status: "reserved", paymentState: "claimed" });
  assert.deepEqual([claimed.cancel, claimed.unreserve, claimed.confirm], [false, false, true]);
  const fin = actionsFor({ ...base, status: "finalized", paymentState: "confirmed" });
  assert.deepEqual([fin.cancel, fin.confirm, fin.ship, fin.editCart], [false, false, true, false], "پس از نهایی فقط ارسال؛ لغو از مسیر مرجوعی");
  assert.equal(actionsFor({ ...base, status: "finalized", paymentState: "confirmed", shippingState: "delivered" }).ship, false);
  for (const s of ["cancelled", "confirming"] as const) {
    assert.ok(Object.values(actionsFor({ ...base, status: s, paymentState: "none" })).every(v => v === false), s);
  }
});

test("ارسال فقط رو به جلو و یک گام", () => {
  assert.equal(nextShipping("not_started"), "packing");
  assert.equal(nextShipping("ready"), "shipped");
  assert.equal(nextShipping("delivered"), null);
});

test("وضعیت همگام‌سازی سایت صادقانه است: نامعلوم و خاموش هرگز «پذیرفته» نیستند", () => {
  assert.equal(syncView({ state: "sent", at: "2026-10-23T10:00:00Z", error: null }).state, "completed");
  for (const s of ["unknown", "off", "none", "queued", "error", "not_site_warehouse"] as const) {
    assert.notEqual(syncView({ state: s, at: null, error: null }).state, "completed", s);
  }
  assert.equal(syncView({ state: "error", at: null, error: "502" }).state, "failed");
  // حالت ناشناختهٔ آینده از سرور هم «نامعلوم» است.
  assert.equal(syncView({ state: "weird" as never, at: null, error: null }).state, "unknown");
});

test("سنجش فرم تأیید واریز: مبلغ دقیقاً برابر، مرجع، حساب، زمان نه در آینده", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const ok = { payable: "1050000", amountRial: "1050000", refNo: "123456", accountId: "a", paidAt: new Date("2026-10-23T11:00:00Z"), now };
  assert.deepEqual(checkConfirm(ok), { ok: true });
  assert.equal((checkConfirm({ ...ok, amountRial: "1049990" }) as { field: string }).field, "amount", "ناقص");
  assert.equal((checkConfirm({ ...ok, amountRial: "1060000" }) as { field: string }).field, "amount", "اضافه هم تأیید نمی‌شود");
  assert.equal((checkConfirm({ ...ok, amountRial: null }) as { field: string }).field, "amount");
  assert.equal((checkConfirm({ ...ok, refNo: "  " }) as { field: string }).field, "ref");
  assert.equal((checkConfirm({ ...ok, accountId: "" }) as { field: string }).field, "account");
  assert.equal((checkConfirm({ ...ok, paidAt: new Date("2026-10-23T12:30:00Z") }) as { field: string }).field, "paidAt");
  assert.deepEqual(checkConfirm({ ...ok, paidAt: new Date("2026-10-23T12:04:00Z") }), { ok: true }, "پنج دقیقه رواداری ساعت");
});

test("تومان به ریال با رقم فارسی و جداکننده؛ ورودی نامعتبر تهی است نه صفر", () => {
  assert.equal(rialFromToman("۱۰۵٬۰۰۰"), "1050000");
  assert.equal(rialFromToman("105,000"), "1050000");
  assert.equal(rialFromToman(""), null);
  assert.equal(rialFromToman("12.5"), null);
  assert.equal(rialFromToman("-5"), null);
});

test("تعداد قلم: صحیح ۱ تا ۹۹۹، رقم فارسی پذیرفته؛ اعشار و صفر رد", () => {
  assert.equal(parseQty("۳"), 3);
  assert.equal(parseQty(" 12 "), 12);
  assert.equal(parseQty("999"), 999);
  for (const bad of ["0", "1.5", "۱٫۵", "-2", "1000", "", "abc", "01"]) assert.equal(parseQty(bad), null, bad);
});

test("نام کاربری اینستاگرام همان قاعدهٔ سرور", () => {
  assert.deepEqual(normalizeUsername("  @Shop.Buyer_1 "), { ok: true, value: "shop.buyer_1" });
  assert.deepEqual(normalizeUsername(""), { ok: true, value: null });
  assert.equal(normalizeUsername("فروشگاه").ok, false);
  assert.equal(normalizeUsername("a".repeat(31)).ok, false);
});

test("منو و برچسب‌ها: زبانهٔ جدا با دو مجوز؛ کانال اینستاگرام در گزارش برچسب دارد", () => {
  const z = ZONES.find(x => x.key === "instagram-orders");
  assert.deepEqual(z && { anyOf: z.anyOf, group: z.navGroup }, { anyOf: ["instagram.order.manage", "instagram.payment.verify"], group: "daily" });
  assert.equal(channelLabel("instagram"), "اینستاگرام");
  // هر وضعیت برچسب دارد؛ وضعیت تازهٔ سرور بی برچسب نمی‌ماند.
  for (const s of ["draft", "reserved", "expired", "confirming", "finalized", "cancelled"] as const) assert.ok(ORDER_STATUS[s].label);
  for (const s of ["none", "claimed", "review", "confirmed"] as const) assert.ok(PAYMENT_STATE[s].label);
});

test("وضعیت ناشناختهٔ سرور «نامعلوم» با نام خودش است، نه خطای صفحه", () => {
  assert.deepEqual(statusView(ORDER_STATUS, "on_hold"), { label: "on_hold", state: "unknown" });
  assert.deepEqual(statusView(PAYMENT_STATE, "claimed"), PAYMENT_STATE.claimed);
});
