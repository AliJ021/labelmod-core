/**
 * تست کدک پول.
 *
 * این فایل جایی است که «پول هرگز float نیست» از یک توصیه به یک ادعای
 * اجراشدنی تبدیل می‌شود.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MONEY_MAX,
  MoneyError,
  allocate,
  parseMoney,
  serializeMoney,
  toTomanDisplay,
} from "../src/lib/money.ts";

describe("parseMoney", () => {
  test("رشته صحیح را به bigint می‌برد", () => {
    assert.equal(parseMoney("5000000"), 5_000_000n);
    assert.equal(parseMoney("-3000"), -3_000n);
    assert.equal(parseMoney("0"), 0n);
  });

  test("اعشار صفر که پستگرس می‌دهد را می‌پذیرد", () => {
    // sum() روی NUMERIC گاهی «1234.00» برمی‌گرداند
    assert.equal(parseMoney("1234.00"), 1_234n);
    assert.equal(parseMoney("1234.0000"), 1_234n);
  });

  test("اعشار غیرصفر را رد می‌کند — گرد کردن باید صریح باشد", () => {
    assert.throws(() => parseMoney("1234.50"), MoneyError);
    assert.throws(() => parseMoney("0.01"), MoneyError);
  });

  test("number را رد می‌کند، حتی وقتی درست به نظر می‌رسد", () => {
    assert.throws(() => parseMoney(5_000_000), MoneyError);
    assert.throws(() => parseMoney(0), MoneyError);
  });

  test("مبلغی که از دقت number می‌گذرد، سالم می‌ماند", () => {
    const big = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    assert.equal(parseMoney(big), 9_007_199_254_740_993n);
    assert.equal(serializeMoney(parseMoney(big)), big);
    // همان مبلغ از مسیر number خراب می‌شود — دلیل وجود این کدک
    assert.notEqual(String(Number(big)), big);
  });

  test("ورودی بی‌معنا را رد می‌کند", () => {
    for (const bad of ["", "  ", "abc", "1,000", "1e6", "۱۲۳", null, undefined, {}]) {
      assert.throws(() => parseMoney(bad), MoneyError, `باید رد شود: ${String(bad)}`);
    }
  });

  test("از ظرفیت NUMERIC(18,0) بیرون را رد می‌کند", () => {
    assert.equal(parseMoney(String(MONEY_MAX)), MONEY_MAX);
    assert.throws(() => parseMoney(String(MONEY_MAX + 1n)), MoneyError);
  });
});

describe("allocate", () => {
  test("جمع سطرها دقیقاً برابر مبلغ اصلی می‌ماند", () => {
    const parts = allocate(100n, [1n, 1n, 1n]);
    assert.deepEqual(parts, [34n, 33n, 33n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), 100n);
  });

  test("تخفیف فاکتور روی اقلام نامساوی", () => {
    // تخفیف ۱۰۰٬۰۰۰ روی سه قلم ۳۰۰٬۰۰۰ / ۲۰۰٬۰۰۰ / ۱۰۰٬۰۰۰
    // سهم دقیق: ۵۰۰۰۰ و ۳۳۳۳۳٫۳ و ۱۶۶۶۶٫۷ → جمعِ کف‌شده ۹۹٬۹۹۹
    // یک ریال ته‌مانده به سطر اول می‌رود تا جمع دقیقاً ۱۰۰٬۰۰۰ بماند.
    const parts = allocate(100_000n, [300_000n, 200_000n, 100_000n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), 100_000n);
    assert.deepEqual(parts, [50_001n, 33_333n, 16_666n]);
  });

  test("هزار بار با وزن‌های تصادفی: هرگز یک ریال گم نمی‌شود", () => {
    for (let i = 0; i < 1000; i++) {
      const n = 1 + (i % 7);
      const weights = Array.from({ length: n }, (_, k) => BigInt(1 + ((i * 31 + k * 17) % 997)));
      const total = BigInt(1 + ((i * 7919) % 10_000_019));
      const parts = allocate(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0n), total);
      assert.equal(parts.length, weights.length);
    }
  });

  test("مبلغ منفی هم دقیق پخش می‌شود — مرجوعی", () => {
    const parts = allocate(-100n, [1n, 1n, 1n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), -100n);
  });

  test("سطر با وزن صفر، ته‌مانده نمی‌گیرد", () => {
    const parts = allocate(10n, [0n, 3n, 0n]);
    assert.deepEqual(parts, [0n, 10n, 0n]);
  });

  test("ورودی نامعتبر", () => {
    assert.throws(() => allocate(10n, []), MoneyError);
    assert.throws(() => allocate(10n, [0n, 0n]), MoneyError);
    assert.throws(() => allocate(10n, [-1n, 2n]), MoneyError);
  });
});

describe("toTomanDisplay", () => {
  test("ریال به تومان، فقط برای نمایش", () => {
    assert.equal(toTomanDisplay(5_000_000n), "۵۰۰٬۰۰۰".replace(/[۰-۹]/g, (d) =>
      String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
    assert.equal(toTomanDisplay(1_234_560n), "123٬456");
    assert.equal(toTomanDisplay(-1_234_560n), "−123٬456");
  });
});
