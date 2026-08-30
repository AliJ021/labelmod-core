/**
 * تبدیل مقدار تنظیم — جایی که ورودی فارسی به JSON درست تبدیل می‌شود.
 *
 * ادعای مرکزی: **کاربر ایرانی «۴۸» می‌نویسد، نه «48»** — و فرمی که
 * این را «عدد نیست» بگیرد، در عمل غیرقابل استفاده است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  describeValue,
  fromInput,
  normalizeDigits,
  toInput,
  type SettingMeta,
} from "../src/lib/settings-value.ts";

const meta = (over: Partial<SettingMeta>): SettingMeta => ({
  kind: "int",
  min: null,
  max: null,
  options: null,
  ...over,
});

describe("تبدیل رقم فارسی", () => {
  test("رقم فارسی و عربی به لاتین می‌شود", () => {
    assert.equal(normalizeDigits("۴۸"), "48");
    assert.equal(normalizeDigits("٤٨"), "48");
    assert.equal(normalizeDigits("  ۱۰  "), "10");
  });

  test("جداکننده هزارگان برداشته می‌شود", () => {
    assert.equal(normalizeDigits("۱٬۲۰۰"), "1200");
    assert.equal(normalizeDigits("1,200"), "1200");
  });

  test("اعشار فارسی به نقطه تبدیل می‌شود", () => {
    assert.equal(normalizeDigits("۷٫۵"), "7.5");
  });
});

describe("ورودی فرم → JSON", () => {
  test("عدد فارسی پذیرفته می‌شود", () => {
    assert.deepEqual(fromInput(meta({ kind: "int" }), "۴۸"), { ok: true, value: 48 });
  });

  test("عدد صحیح، اعشار را رد می‌کند", () => {
    const r = fromInput(meta({ kind: "int" }), "۷٫۵");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /اعشار/);
  });

  test("بازه از فراداده سرور می‌آید، نه از ثابت در کد", () => {
    const m = meta({ kind: "percent", min: 0, max: 100 });
    assert.equal(fromInput(m, "120").ok, false);
    assert.deepEqual(fromInput(m, "9"), { ok: true, value: 9 });
  });

  test("پول رشته می‌ماند، نه number", () => {
    // اگر number می‌شد، مبالغ ریالی بزرگ بی‌صدا گرد می‌شدند.
    const r = fromInput(meta({ kind: "money" }), "۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶");
    assert.deepEqual(r, { ok: true, value: "123456789012345" + "6" });
    assert.equal(typeof (r as { value: unknown }).value, "string");
  });

  test("گزینه ناشناخته رد می‌شود", () => {
    const m = meta({
      kind: "choice",
      options: [
        { value: "per_shift", label: "شیفتی" },
        { value: "per_invoice", label: "فاکتوری" },
      ],
    });
    assert.equal(fromInput(m, "fifo").ok, false);
    assert.deepEqual(fromInput(m, "per_invoice"), { ok: true, value: "per_invoice" });
  });

  test("چندگزینه‌ای فقط اعضای شناخته‌شده را می‌پذیرد", () => {
    const m = meta({
      kind: "multichoice",
      options: [
        { value: "a", label: "الف" },
        { value: "b", label: "ب" },
      ],
    });
    assert.deepEqual(fromInput(m, ["a", "b"]), { ok: true, value: ["a", "b"] });
    assert.equal(fromInput(m, ["a", "z"]).ok, false);
  });

  test("بله/خیر فقط boolean می‌پذیرد", () => {
    assert.deepEqual(fromInput(meta({ kind: "bool" }), true), { ok: true, value: true });
    assert.equal(fromInput(meta({ kind: "bool" }), "true").ok, false);
  });

  test("متن خالی رد می‌شود", () => {
    assert.equal(fromInput(meta({ kind: "text" }), "   ").ok, false);
  });
});

describe("نمایش مقدار", () => {
  test("گزینه با برچسب فارسی خودش دیده می‌شود، نه با کد فنی", () => {
    const m = meta({
      kind: "choice",
      options: [{ value: "last_purchase", label: "آخرین قیمت خرید" }],
    });
    assert.equal(describeValue(m, "last_purchase"), "آخرین قیمت خرید");
  });

  test("بله/خیر فارسی می‌شود", () => {
    assert.equal(describeValue(meta({ kind: "bool" }), true), "فعال");
    assert.equal(describeValue(meta({ kind: "bool" }), false), "غیرفعال");
  });

  test("رفت‌وبرگشت عدد", () => {
    assert.equal(toInput("int", 48), "48");
    assert.deepEqual(fromInput(meta({ kind: "int" }), toInput("int", 48)), {
      ok: true,
      value: 48,
    });
  });
});
