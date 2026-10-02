/**
 * منطق خالص دفتر برداشت: تومان → ریال رشته‌ای، صفر فقط در اصلاح، «بی تغییر»
 * پیش از تأیید، و تشخیص «اصلاح نشست» فقط از پاسخ خواندنی سرور.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkAmount, checkText, correctionLanded, correctionPayload, createPayload, tomanDraft } from "../src/lib/withdrawals.ts";

describe("دفتر برداشت — ورودی", () => {
  test("تومان به ریال رشته‌ای؛ رقم فارسی و جداکننده؛ خالی خطا نیست", () => {
    assert.deepEqual(checkAmount("۱۵۰٬۰۰۰", false), { rial: "1500000", error: null });
    assert.deepEqual(checkAmount("", false), { rial: null, error: null });
    assert.equal(checkAmount("12.5", false).rial, null, "اعشار پذیرفته نمی‌شود");
    assert.equal(checkAmount("-5", false).rial, null, "منفی پذیرفته نمی‌شود");
    assert.equal(checkAmount("1".repeat(19), true).rial, null, "بیش از ظرفیت NUMERIC(18,0)");
  });
  test("صفر: در ثبت رد، در اصلاح مدیر مجاز", () => {
    assert.equal(checkAmount("0", false).rial, null);
    assert.ok(checkAmount("0", false).error);
    assert.deepEqual(checkAmount("0", true), { rial: "0", error: null });
  });
  test("دلیل: خالی، بلند و نویسهٔ کنترلی", () => {
    assert.equal(createPayload("100", "   "), null);
    assert.deepEqual(createPayload("100", "  کرایه  "), { amount: "1000", reason: "کرایه" });
    assert.ok(checkText("x".repeat(501), "دلیل"));
    assert.ok(checkText("a‮b", "دلیل"));
    assert.equal(checkText("کرایهٔ پیک", "دلیل"), null);
  });
});

describe("دفتر برداشت — اصلاح", () => {
  const current = { version: 2, amount: "1500000", reason: "کرایه" };
  test("بدنه با شرط نسخهٔ جاری؛ صفر مجاز؛ دلیل اصلاح اجباری", () => {
    assert.deepEqual(correctionPayload(current, { amount: "0", reason: "کرایه", note: "تکراری" }),
      { payload: { expectedVersion: 2, amount: "0", reason: "کرایه", note: "تکراری" }, blocker: null });
    assert.equal(correctionPayload(current, { amount: "0", reason: "کرایه", note: "  " }).payload, null);
  });
  test("بی تغییر پیش از تأیید گفته می‌شود", () => {
    const out = correctionPayload(current, { amount: tomanDraft("1500000"), reason: "کرایه", note: "x" });
    assert.equal(out.payload, null);
    assert.ok(out.blocker);
  });
  test("نتیجهٔ نامعلوم فقط از تاریخچهٔ سرور روشن می‌شود", () => {
    const sent = { expectedVersion: 2, amount: "0", reason: "کرایه", note: "تکراری" };
    const rev = (version: number, amount: string, note: string | null) =>
      ({ version, amount, reason: "کرایه", note, actor: { id: "a", name: "م" }, at: "2026-10-02T10:00:00Z" });
    assert.equal(correctionLanded({ history: [rev(1, "1500000", null), rev(2, "1500000", "x")] }, sent), "absent");
    assert.equal(correctionLanded({ history: [rev(1, "1500000", null), rev(2, "1500000", "x"), rev(3, "0", "تکراری")] }, sent), "landed");
    assert.equal(correctionLanded({ history: [rev(1, "1500000", null), rev(2, "1500000", "x"), rev(3, "9", "دیگری")] }, sent), "superseded");
  });
});
