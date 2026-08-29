/**
 * بارکد داخلی و ترتیب سایز — دو منطق خالص، بدون دیتابیس.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ean13CheckDigit,
  makeEan13,
  isInStoreBarcode,
  serialOf,
  MAX_SERIAL,
} from "../src/catalog/barcode.ts";
import { sizeRank, sortSizes } from "../src/catalog/size-order.ts";

describe("بارکد EAN-13", () => {
  test("رقم کنترل با نمونه‌های شناخته‌شده می‌خواند", () => {
    // نمونه‌های مرجع EAN-13
    assert.equal(ean13CheckDigit("400638133393"), "1");
    assert.equal(ean13CheckDigit("978014300723"), "4");
    assert.equal(ean13CheckDigit("590123412345"), "7");
  });

  test("بارکد ساخته‌شده ۱۳ رقمی و خودسازگار است", () => {
    for (const serial of [0, 1, 42, 999_999, MAX_SERIAL]) {
      const code = makeEan13(serial);
      assert.equal(code.length, 13, `طول برای ${serial}`);
      assert.match(code, /^\d{13}$/);
      assert.equal(ean13CheckDigit(code.slice(0, 12)), code[12]);
      assert.ok(isInStoreBarcode(code));
      assert.equal(serialOf(code), serial);
    }
  });

  test("پیشوند ۲۰ است — محدوده گردش محدود GS1", () => {
    // یعنی هرگز با بارکد واقعی یک تولیدکننده اشتباه گرفته نمی‌شود
    assert.ok(makeEan13(7).startsWith("20"));
  });

  test("هر سریال یک بارکد یکتا می‌دهد", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(makeEan13(i));
    assert.equal(seen.size, 500);
  });

  test("یک رقم خط‌خورده، رقم کنترل را می‌شکند", () => {
    // همان چیزی که بارکدخوان می‌گیرد و نمی‌گذارد کالای دیگری فروخته شود
    const good = makeEan13(12345);
    const digit = Number(good[5]);
    const bad = good.slice(0, 5) + String((digit + 1) % 10) + good.slice(6);
    assert.notEqual(bad, good);
    assert.ok(!isInStoreBarcode(bad), "بارکد دستکاری‌شده باید رد شود");
  });

  test("سریال خارج از محدوده رد می‌شود", () => {
    assert.throws(() => makeEan13(-1));
    assert.throws(() => makeEan13(MAX_SERIAL + 1));
    assert.throws(() => makeEan13(1.5));
  });

  test("بارکد کارخانه‌ای، بارکد داخلی ما نیست", () => {
    assert.ok(!isInStoreBarcode("4006381333931"), "پیشوند ۴۰ مال ماست؟ نه");
    assert.equal(serialOf("4006381333931"), null);
    assert.ok(!isInStoreBarcode("123"));
    assert.ok(!isInStoreBarcode("abcdefghijklm"));
  });
});

describe("ترتیب سایز", () => {
  test("مرتب‌سازی الفبایی را درست می‌کند", () => {
    // ["S","M","L","XL"].sort() می‌دهد L, M, S, XL — همان چیزی که
    // ماتریس موجودی را بی‌فایده می‌کند
    assert.deepEqual(sortSizes(["XL", "S", "L", "M"]), ["S", "M", "L", "XL"]);
  });

  test("زنجیره کامل حرفی", () => {
    assert.deepEqual(
      sortSizes(["XXL", "XS", "L", "XXXL", "M", "S", "XL", "XXS"]),
      ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"],
    );
  });

  test("شکل 2XL و 3XL همان XXL و XXXL است", () => {
    assert.equal(sizeRank("2XL"), sizeRank("XXL"));
    assert.equal(sizeRank("3XL"), sizeRank("XXXL"));
    assert.equal(sizeRank("2XS"), sizeRank("XXS"));
    assert.deepEqual(sortSizes(["3XL", "M", "2XL"]), ["M", "2XL", "3XL"]);
  });

  test("سایز عددی، عددی مرتب می‌شود نه رشته‌ای", () => {
    // ["36","38","40","100"].sort() می‌دهد 100, 36, 38, 40
    assert.deepEqual(sortSizes(["40", "36", "38", "100"]), [
      "36",
      "38",
      "40",
      "100",
    ]);
  });

  test("ارقام فارسی مثل ارقام لاتین رفتار می‌کنند", () => {
    assert.equal(sizeRank("۴۰"), sizeRank("40"));
    assert.deepEqual(sortSizes(["۴۰", "۳۶", "۳۸"]), ["۳۶", "۳۸", "۴۰"]);
  });

  test("فاصله و خط تیره و حروف کوچک مهم نیستند", () => {
    assert.equal(sizeRank(" xl "), sizeRank("XL"));
    assert.equal(sizeRank("X-L"), sizeRank("XL"));
    assert.equal(sizeRank("x l"), sizeRank("XL"));
  });

  test("تک‌سایز اول می‌آید، ناشناخته آخر", () => {
    const out = sortSizes(["قدبلند", "M", "تک سایز", "S"]);
    assert.equal(out[0], "تک سایز");
    assert.deepEqual(out.slice(1, 3), ["S", "M"]);
    assert.equal(out[3], "قدبلند");
  });

  test("سایز تهی ته فهرست می‌نشیند و برنامه را نمی‌شکند", () => {
    const out = sortSizes(["L", null, "S"]);
    assert.deepEqual(out, ["S", "L", null]);
  });

  test("مرتب‌سازی پایدار است — دو بار اجرا، یک نتیجه", () => {
    const input = ["XL", "قدبلند", "S", "کوتاه", "M"];
    assert.deepEqual(sortSizes(input), sortSizes([...input].reverse()));
  });

  test("ورودی را تغییر نمی‌دهد", () => {
    const input = ["XL", "S", "M"];
    sortSizes(input);
    assert.deepEqual(input, ["XL", "S", "M"]);
  });
});
