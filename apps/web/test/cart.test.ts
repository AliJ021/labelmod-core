/**
 * ریاضی پرداخت و مرز تبدیل تومان به ریال.
 *
 * این دو عدد جلوی چشم مشتری روی صفحه‌اند و اشتباهشان یعنی پول کم یا
 * زیاد از کشو.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { canFinalize, changeRial, isSettled, remainingRial, steppedQty } from "../src/lib/cart.ts";
import { rialFromTomanInput, toman } from "../src/lib/money.ts";

describe("مانده و باقی پول", () => {
  test("پرداخت جزئی", () => {
    assert.equal(remainingRial(1_000_000n, 400_000n), 600_000n);
    assert.equal(changeRial(1_000_000n, 400_000n), 0n);
    assert.equal(isSettled(1_000_000n, 400_000n), false);
  });

  test("پرداخت دقیق", () => {
    assert.equal(remainingRial(1_000_000n, 1_000_000n), 0n);
    assert.equal(changeRial(1_000_000n, 1_000_000n), 0n);
    assert.equal(isSettled(1_000_000n, 1_000_000n), true);
  });

  test("پرداخت بیشتر: مانده صفر است، نه منفی", () => {
    // یکی‌کردن این دو یعنی یک عدد منفی روی صفحه که کسی نمی‌داند
    // یعنی چه — «مانده −۵۰٬۰۰۰» به صندوق‌دار چیزی نمی‌گوید.
    assert.equal(remainingRial(1_000_000n, 1_500_000n), 0n);
    assert.equal(changeRial(1_000_000n, 1_500_000n), 500_000n);
    assert.equal(isSettled(1_000_000n, 1_500_000n), true);
  });

  test("فاکتور صفر", () => {
    assert.equal(remainingRial(0n, 0n), 0n);
    assert.equal(isSettled(0n, 0n), true);
  });

  test("مبالغ بزرگ دقت را از دست نمی‌دهند", () => {
    // یک میلیارد تومان = ۱۰ میلیارد ریال، خارج از محدوده امن number.
    const payable = 10_000_000_000_000n;
    assert.equal(remainingRial(payable, payable - 1n), 1n);
  });
});

describe("اجازه نهایی‌سازی", () => {
  const base = { status: "draft", lineCount: 2, payable: 1_000_000n, received: 1_000_000n };

  test("پیش‌نویسِ پرداخت‌شده با سطر", () => {
    assert.equal(canFinalize(base), true);
  });

  test("سبد خالی نهایی نمی‌شود", () => {
    assert.equal(canFinalize({ ...base, lineCount: 0 }), false);
  });

  test("پول ناکافی", () => {
    assert.equal(canFinalize({ ...base, received: 999_999n }), false);
  });

  test("فاکتوری که دیگر پیش‌نویس نیست", () => {
    assert.equal(canFinalize({ ...base, status: "finalized" }), false);
  });
});

describe("تغییر تعداد با + و −", () => {
  test("افزایش و کاهش", () => {
    assert.equal(steppedQty("2", 1), "3");
    assert.equal(steppedQty("3", -1), "2");
  });

  test("رسیدن به صفر یعنی «حذف»، نه تعداد صفر", () => {
    // مسیر حذف عمل دیگری با ردّ حسابرسی متفاوت است؛ سرور هم تعداد
    // صفر را رد می‌کند.
    assert.equal(steppedQty("1", -1), null);
    assert.equal(steppedQty("1", -5), null);
  });

  test("تعداد اعشاری سرور به عدد صحیح بریده می‌شود", () => {
    // API صندوق فقط عدد صحیح می‌پذیرد، ولی دیتابیس اعشاری هم می‌دهد
    // (مثلاً سطری که از مسیر دیگری ساخته شده).
    assert.equal(steppedQty("2.000", 1), "3");
  });

  test("ورودی بی‌معنا", () => {
    assert.equal(steppedQty("abc", 1), null);
  });
});

describe("تومانِ تایپ‌شده → ریال", () => {
  test("رقم لاتین", () => {
    assert.equal(rialFromTomanInput("150000"), 1_500_000n);
  });

  test("رقم فارسی — همان چیزی که صفحه‌کلید فارسی می‌فرستد", () => {
    assert.equal(rialFromTomanInput("۱۵۰۰۰۰"), 1_500_000n);
  });

  test("رقم عربی", () => {
    assert.equal(rialFromTomanInput("١٥٠٠٠٠"), 1_500_000n);
  });

  test("جداکننده هزارگان به هر شکلی", () => {
    assert.equal(rialFromTomanInput("۱۵۰٬۰۰۰"), 1_500_000n);
    assert.equal(rialFromTomanInput("150,000"), 1_500_000n);
    assert.equal(rialFromTomanInput("150 000"), 1_500_000n);
  });

  test("صفر یک مبلغ است، نه «خالی»", () => {
    assert.equal(rialFromTomanInput("0"), 0n);
  });

  test("ورودی ناقص یا بی‌معنا null است", () => {
    assert.equal(rialFromTomanInput(""), null);
    assert.equal(rialFromTomanInput("   "), null);
    assert.equal(rialFromTomanInput("abc"), null);
    assert.equal(rialFromTomanInput("12a3"), null);
  });

  test("اعشار پذیرفته نمی‌شود", () => {
    // «۱۰٫۵ تومان» یعنی ۱۰۵ ریال — در صندوق پوشاک یک اشتباه تایپی
    // است، نه یک قصد.
    assert.equal(rialFromTomanInput("10.5"), null);
    assert.equal(rialFromTomanInput("10٫5"), null);
  });

  test("رفت‌وبرگشت: آنچه تایپ شد، همان چیزی است که نمایش داده می‌شود", () => {
    // صندوق‌دار «۱۵۰٬۰۰۰» تومان تایپ می‌کند؛ API ۱٬۵۰۰٬۰۰۰ ریال
    // می‌گیرد؛ و صفحه دوباره همان «150٬000» تومان را نشان می‌دهد.
    const rial = rialFromTomanInput("۱۵۰٬۰۰۰");
    assert.equal(rial, 1_500_000n);
    assert.equal(toman(rial as bigint), "150٬000");
  });
});
