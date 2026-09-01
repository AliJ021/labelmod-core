/**
 * خواندن بارکد با دوربین.
 *
 * مهم‌ترین ادعا: دوربین یک بارکد را ده‌ها بار در ثانیه می‌بیند و
 * بدون مهار، یک بار گرفتن گوشی جلوی برچسب سی قلم به سبد اضافه
 * می‌کند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BARCODE_FORMATS,
  cameraError,
  hasNativeDetector,
  nativeDetector,
  ScanThrottle,
} from "../src/lib/camera-scan.ts";

describe("مهار تکرار", () => {
  test("اولین خواندن پذیرفته می‌شود", () => {
    const t = new ScanThrottle(1500);
    assert.equal(t.accept("2001234567890", 1000), true);
  });

  test("همان بارکد داخل پنجره، دوباره شمرده نمی‌شود", () => {
    // این همان چیزی است که «یک اسکن، سی قلم» را می‌سازد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    for (let at = 1030; at < 2500; at += 30) {
      assert.equal(t.accept("2001234567890", at), false, `در ${at}`);
    }
  });

  test("بارکد متفاوت، فوراً پذیرفته می‌شود", () => {
    // اسکن پشت‌سرهم دو کالا نباید منتظر پنجره بماند.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    assert.equal(t.accept("2009876543210", 1050), true);
  });

  test("نگه‌داشتن ممتد گوشی پنجره را تمام نمی‌کند", () => {
    // اگر زمان آخرین دیدن به‌روز نمی‌شد، گرفتن ممتد گوشی بعد از
    // ۱٫۵ ثانیه همان قلم را دوباره اضافه می‌کرد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    for (let at = 1100; at < 6000; at += 100) {
      assert.equal(t.accept("2001234567890", at), false, `در ${at}`);
    }
  });

  test("پس از برداشتن گوشی و اسکن دوباره، پذیرفته می‌شود", () => {
    // اسکن **عمدی** دوم همان کالا باید بشمارد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    assert.equal(t.accept("2001234567890", 3000), true, "پس از مکث");
  });

  test("reset حافظه را پاک می‌کند", () => {
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    t.reset();
    assert.equal(t.accept("2001234567890", 1050), true);
  });

  test("پنجره تنظیم‌پذیر است", () => {
    const t = new ScanThrottle(100);
    t.accept("x", 1000);
    assert.equal(t.accept("x", 1050), false);
    assert.equal(t.accept("x", 1200), true);
  });
});

describe("تشخیص توان مرورگر", () => {
  test("کروم اندروید — آشکارساز بومی", () => {
    const g = { BarcodeDetector: class {} } as unknown as Record<string, unknown>;
    assert.equal(hasNativeDetector(g), true);
    assert.notEqual(nativeDetector(g), null);
  });

  test("سافاری — بدون آشکارساز بومی", () => {
    // یعنی کتابخانه باید بار شود؛ و چون `import()` پویاست، کاربر
    // اندروید هرگز دانلودش نمی‌کند.
    assert.equal(hasNativeDetector({}), false);
    assert.equal(nativeDetector({}), null);
  });

  test("فرمت‌ها همان‌هایی‌اند که این فروشگاه چاپ می‌کند", () => {
    // بارکد داخلی این پروژه EAN-13 با پیشوند ۲۰ است.
    assert.ok(BARCODE_FORMATS.includes("ean_13"));
    assert.ok(BARCODE_FORMATS.includes("ean_8"));
  });
});

describe("پیام خطای دوربین", () => {
  test("اجازه داده نشده — رایج‌ترین حالت", () => {
    const err = Object.assign(new Error("x"), { name: "NotAllowedError" });
    assert.match(cameraError(err), /اجازه دوربین/);
  });

  test("دوربینی نیست", () => {
    const err = Object.assign(new Error("x"), { name: "NotFoundError" });
    assert.match(cameraError(err), /پیدا نشد/);
  });

  test("دوربین در اختیار برنامه دیگر", () => {
    const err = Object.assign(new Error("x"), { name: "NotReadableError" });
    assert.match(cameraError(err), /برنامه دیگری/);
  });

  test("هر چیز دیگر، راه جایگزین را می‌گوید", () => {
    // بن‌بست بی‌راه‌حل نه: ورودی دستی بارکد همیشه هست.
    assert.match(cameraError(new Error("?")), /دستی/);
    assert.match(cameraError(null), /دستی/);
  });
});
