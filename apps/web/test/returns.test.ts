/**
 * ریاضی مرجوعی.
 *
 * مبلغ بازپرداخت را **کلاینت می‌فرستد**، پس این اعداد روی پولی که
 * از کشو بیرون می‌رود اثر دارند. سقفش را دیتابیس می‌گذارد، ولی عددی
 * که با سند نخواند یعنی صندوق‌دار روی صفحه یک مبلغ می‌بیند و روی
 * سند مبلغ دیگری.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  clampQty,
  hasSelection,
  maxReturnable,
  selectionToLines,
  suggestedRefund,
  type Returnable,
  type Selection,
} from "../src/lib/returns.ts";

const line = (over: Partial<Returnable> = {}): Returnable => ({
  invoiceLineId: "l1",
  soldQty: "2",
  remainingQty: "2",
  netAmount: "2000000",
  ...over,
});

const pick = (pairs: Array<[string, number]>): Selection => new Map(pairs);

describe("چقدر قابل برگشت است", () => {
  test("همان مقدار باقی‌مانده", () => {
    assert.equal(maxReturnable(line({ remainingQty: "3" })), 3);
  });

  test("سطری که کاملاً برگشته", () => {
    assert.equal(maxReturnable(line({ remainingQty: "0" })), 0);
  });

  test("انتخاب بیش از باقی‌مانده بریده می‌شود", () => {
    assert.equal(clampQty(line({ remainingQty: "2" }), 5), 2);
  });

  test("انتخاب منفی یا بی‌معنا صفر است", () => {
    assert.equal(clampQty(line(), -1), 0);
    assert.equal(clampQty(line(), Number.NaN), 0);
  });
});

describe("مبلغ پیشنهادی بازپرداخت", () => {
  test("برگشت کامل، کل مبلغ سطر", () => {
    const l = line({ soldQty: "2", netAmount: "2000000" });
    assert.equal(suggestedRefund([l], pick([["l1", 2]])), 2_000_000n);
  });

  test("برگشت نصف، نصف مبلغ", () => {
    const l = line({ soldQty: "2", netAmount: "2000000" });
    assert.equal(suggestedRefund([l], pick([["l1", 1]])), 1_000_000n);
  });

  test("انتخاب‌نشده چیزی اضافه نمی‌کند", () => {
    assert.equal(suggestedRefund([line()], pick([])), 0n);
    assert.equal(suggestedRefund([line()], pick([["l1", 0]])), 0n);
  });

  test("تخفیف سطر در مبلغ برگشتی لحاظ است", () => {
    // مهم: `netAmount` تخفیف را در خود دارد. اگر اینجا
    // `unitPrice × qty` می‌نوشتیم، مشتری بیشتر از آنچه داده پس
    // می‌گرفت.
    const discounted = line({ soldQty: "2", netAmount: "1500000" });
    assert.equal(suggestedRefund([discounted], pick([["l1", 1]])), 750_000n);
  });

  test("گرد کردن نیم‌به‌بالا، مثل round() پستگرس", () => {
    // ۱۰۰۱ ÷ ۲ = ۵۰۰٫۵ → ۵۰۱. تقسیم bigint به‌تنهایی ۵۰۰ می‌داد و
    // هر سطر یک ریال کم می‌شد.
    const odd = line({ soldQty: "2", netAmount: "1001" });
    assert.equal(suggestedRefund([odd], pick([["l1", 1]])), 501n);
  });

  test("هر سطر جدا گرد می‌شود، نه جمع کل", () => {
    // همان ترتیبی که سرور دارد: هر sale_return_line جداگانه round()
    // می‌خورد و سند از جمعشان ساخته می‌شود.
    const a = line({ invoiceLineId: "a", soldQty: "2", netAmount: "1001" });
    const b = line({ invoiceLineId: "b", soldQty: "2", netAmount: "1001" });
    assert.equal(
      suggestedRefund([a, b], pick([["a", 1], ["b", 1]])),
      1002n,
      "۵۰۱ + ۵۰۱، نه گرد کردن ۱۰۰۱",
    );
  });

  test("چند سطر با تعدادهای متفاوت", () => {
    const a = line({ invoiceLineId: "a", soldQty: "3", netAmount: "3000000" });
    const b = line({ invoiceLineId: "b", soldQty: "1", netAmount: "500000" });
    assert.equal(suggestedRefund([a, b], pick([["a", 2], ["b", 1]])), 2_500_000n);
  });

  test("مبالغ بزرگ دقت را از دست نمی‌دهند", () => {
    const big = line({ soldQty: "1", netAmount: "9007199254740993" });
    assert.equal(suggestedRefund([big], pick([["l1", 1]])), 9_007_199_254_740_993n);
  });

  test("تعداد فروخته صفر، تقسیم بر صفر نمی‌شود", () => {
    const broken = line({ soldQty: "0", netAmount: "1000" });
    assert.equal(suggestedRefund([broken], pick([["l1", 1]])), 0n);
  });
});

describe("انتخاب", () => {
  test("تشخیص انتخاب خالی", () => {
    assert.equal(hasSelection(pick([])), false);
    assert.equal(hasSelection(pick([["a", 0]])), false);
    assert.equal(hasSelection(pick([["a", 0], ["b", 1]])), true);
  });

  test("تبدیل به شکل درخواست، بدون سطرهای صفر", () => {
    const out = selectionToLines(pick([["a", 2], ["b", 0], ["c", 1]]));
    assert.deepEqual(out, [
      { invoiceLineId: "a", qty: "2", restock: true },
      { invoiceLineId: "c", qty: "1", restock: true },
    ]);
  });

  test("تعداد رشته است، نه عدد", () => {
    // همان قاعده سراسری: عدد جاوااسکریپت در مرز API قابل اعتماد نیست.
    const [first] = selectionToLines(pick([["a", 3]]));
    assert.equal(typeof first?.qty, "string");
  });
});
