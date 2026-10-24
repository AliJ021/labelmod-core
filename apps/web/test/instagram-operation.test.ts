import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearIgOperation, igOperationSlot, isDefinitiveRejection, readIgOperation, writeIgOperation, type IgOperation,
} from "../src/lib/instagram-operation.ts";
import { ApiError } from "../src/lib/api.ts";
import { permOf, tomanFromRial, rialFromToman } from "../src/lib/instagram-orders.ts";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}
const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const op = (over: Partial<IgOperation> = {}): IgOperation => ({ version: 1, actorId: ACTOR, scope: ORDER, kind: "line.add",
  key: "33333333-3333-4333-8333-333333333333", body: { variationId: "44444444-4444-4444-8444-444444444444", qty: 1 }, label: "افزودن کالا (تعداد ۱)", ...over });

test("عملیات پیش از ارسال می‌نشیند، همان را برمی‌گرداند و فقط با همان کلید پاک می‌شود", () => {
  const s = memory();
  assert.equal(readIgOperation(ACTOR, ORDER, s), null);
  writeIgOperation(op(), s);
  assert.deepEqual(readIgOperation(ACTOR, ORDER, s), op());
  // نوشتن دوبارهٔ همان: بی‌اثر. عملیات دیگر روی همان سفارش: رد، و رکورد قبلی دست‌نخورده.
  writeIgOperation(op(), s);
  assert.throws(() => writeIgOperation(op({ key: "55555555-5555-4555-8555-555555555555", body: { variationId: "44444444-4444-4444-8444-444444444444", qty: 2 } }), s), /هنوز روشن نشده/);
  assert.equal(readIgOperation(ACTOR, ORDER, s)?.key, op().key);
  // پاک‌کردن با کلید دیگر (تب دیگری که عملیات تازه‌تری دارد) چیزی را پاک نمی‌کند.
  clearIgOperation(ACTOR, ORDER, "55555555-5555-4555-8555-555555555555", s);
  assert.notEqual(readIgOperation(ACTOR, ORDER, s), null);
  clearIgOperation(ACTOR, ORDER, op().key, s);
  assert.equal(readIgOperation(ACTOR, ORDER, s), null);
});

test("دادهٔ خراب یا ناهمخوان هرگز «نبودن» تعبیر نمی‌شود — ثبت تازه بسته است", () => {
  for (const bad of ["{", "null", JSON.stringify({ ...op(), key: "not-a-uuid" }), JSON.stringify({ ...op(), actorId: "x" }),
    JSON.stringify({ ...op(), kind: "line.qty" }) /* بی lineId */, JSON.stringify({ ...op(), kind: "create" }) /* ساخت روی سفارش */,
    JSON.stringify({ ...op(), kind: "evil" }), JSON.stringify({ ...op(), body: [1] })]) {
    const s = memory(); s.m.set(igOperationSlot(ACTOR, ORDER), bad);
    assert.throws(() => readIgOperation(ACTOR, ORDER, s), /خوانده نشد/, bad);
    assert.throws(() => writeIgOperation(op(), s), /خوانده نشد/, "نوشتن روی دادهٔ خراب هم بسته است");
    assert.equal(s.m.get(igOperationSlot(ACTOR, ORDER)), bad, "داده حفظ شد");
  }
  // ساخت سفارش فقط در دامنهٔ «new».
  const s = memory();
  writeIgOperation(op({ scope: "new", kind: "create", body: { customerMobile: "09121112233" } }), s);
  assert.equal(readIgOperation(ACTOR, "new", s)?.kind, "create");
});

test("ذخیره‌ای که بی‌صدا ننشیند پیش از ارسال خطا می‌دهد", () => {
  const s = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  assert.throws(() => writeIgOperation(op(), s), /پیش از ارسال/);
});

test("فقط ۴xx قطعی رکورد را پاک می‌کند؛ شبکه، ۵xx و «در جریان» نامعلوم‌اند", () => {
  assert.equal(isDefinitiveRejection(new ApiError(409, "stale_version", "x", null)), true);
  assert.equal(isDefinitiveRejection(new ApiError(422, "bad", "x", null)), true);
  assert.equal(isDefinitiveRejection(new ApiError(409, "idempotency_in_flight", "x", null)), false);
  assert.equal(isDefinitiveRejection(new ApiError(502, "bad_gateway", "x", null)), false);
  assert.equal(isDefinitiveRejection(new TypeError("Failed to fetch")), false);
  // اولین ارسال: رد دروازه (نشست، مجوز، CSRF، نرخ) پیش از هر اثری است → قطعی.
  for (const st of [401, 403, 408, 429]) assert.equal(isDefinitiveRejection(new ApiError(st, "x", "x", null)), true, `first ${st}`);
  // تلاش دوباره پس از نتیجهٔ نامعلوم: همان ردها چیزی دربارهٔ تلاش اول نمی‌گویند → نامعلوم می‌ماند.
  for (const st of [401, 403, 408, 429]) assert.equal(isDefinitiveRejection(new ApiError(st, "x", "x", null), true), false, `retry ${st}`);
  // ولی رد کسب‌وکاری پس از جست‌وجوی همان کلید می‌آید → در تلاش دوباره هم قطعی.
  for (const st of [400, 404, 409, 422]) assert.equal(isDefinitiveRejection(new ApiError(st, "x", "x", null), true), true, `retry ${st}`);
  assert.equal(isDefinitiveRejection(new ApiError(409, "idempotency_in_flight", "x", null), true), false);
});

test("مجوز محافظه‌کار: در حال بررسی و نامعلوم هرگز «مجاز» نیستند", () => {
  const v = new Map([["instagram.order.manage", "allow"], ["instagram.payment.verify", "deny"]]);
  assert.equal(permOf({ state: "ready", verdicts: v }, "instagram.order.manage"), "allow");
  assert.equal(permOf({ state: "ready", verdicts: v }, "instagram.payment.verify"), "deny");
  assert.equal(permOf({ state: "loading", verdicts: new Map() }, "instagram.order.manage"), "loading");
  assert.equal(permOf({ state: "degraded", verdicts: new Map() }, "instagram.order.manage"), "unknown");
  assert.equal(permOf({ state: "ready", verdicts: new Map([["x", "unknown"]]) }, "x"), "unknown");
});

test("پیش‌پرکردن کرایه: ریال به تومان و برگشت دقیق", () => {
  for (const rial of ["0", "50000", "1050005", "7"]) assert.equal(rialFromToman(tomanFromRial(rial)), rial);
  assert.equal(tomanFromRial("50000"), "5000");
  assert.equal(tomanFromRial("1050005"), "105000.5");
});
