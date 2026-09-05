/**
 * TOTP — با **بردارهای آزمون خودِ RFC 6238**.
 *
 * این تنها راه معناداری است که می‌شود یک پیاده‌سازی TOTP را سنجید.
 * تستی که خودش کد را با همان تابع تولید کند، فقط ثابت می‌کند تابع با
 * خودش سازگار است — نه اینکه با Google Authenticator سازگار باشد.
 *
 * بردارها از پیوست B سند RFC 6238 می‌آیند، با راز
 * «12345678901234567890» (۲۰ بایت ASCII) و الگوریتم SHA-1.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUri,
  totp,
  verifyTotp,
} from "../src/auth/totp.ts";

/** راز نمونه RFC 6238 — ASCII «12345678901234567890». */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("Base32", () => {
  test("رفت و برگشت", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "abcde", "hello world"]) {
      const buf = Buffer.from(s, "utf8");
      assert.deepEqual(base32Decode(base32Encode(buf)), buf, `«${s}»`);
    }
  });

  test("بردار RFC 4648", () => {
    assert.equal(base32Encode(Buffer.from("f")), "MY");
    assert.equal(base32Encode(Buffer.from("fo")), "MZXQ");
    assert.equal(base32Encode(Buffer.from("foo")), "MZXW6");
    assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  });

  test("فاصله و = نادیده گرفته می‌شوند", () => {
    // اپ‌ها راز را با فاصله نشان می‌دهند و کاربر همان را کپی می‌کند.
    assert.deepEqual(base32Decode("MZXW 6YTB OI=="), Buffer.from("foobar"));
  });

  test("کاراکتر نامعتبر خطا می‌دهد", () => {
    assert.throws(() => base32Decode("MZXW1"), /Base32/);
  });
});

describe("TOTP — بردارهای RFC 6238", () => {
  /**
   * جدول پیوست B، فقط سطرهای SHA-1.
   *
   * ⚠️ سطر ۲۰۰۰۰۰۰۰۰۰ عمداً هست: شماره گام آنجا از محدوده امن
   *    عدد صحیح ۳۲ بیتی رد می‌شود و پیاده‌سازی‌هایی که با `<<`
   *    نوشته شده‌اند دقیقاً همان‌جا می‌شکنند.
   */
  const VECTORS: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  for (const [seconds, expected] of VECTORS) {
    test(`t=${seconds} → ${expected}`, () => {
      assert.equal(totp(RFC_SECRET, new Date(seconds * 1000), { digits: 6 }), expected);
    });
  }
});

describe("سنجش کد", () => {
  const at = new Date(1111111111 * 1000);

  test("کد همین لحظه پذیرفته می‌شود", () => {
    assert.equal(verifyTotp(RFC_SECRET, "050471", at), true);
  });

  test("یک گام قبل و بعد پذیرفته می‌شوند — انحراف ساعت گوشی", () => {
    const before = totp(RFC_SECRET, new Date((1111111111 - 30) * 1000));
    const after = totp(RFC_SECRET, new Date((1111111111 + 30) * 1000));
    assert.equal(verifyTotp(RFC_SECRET, before, at), true);
    assert.equal(verifyTotp(RFC_SECRET, after, at), true);
  });

  test("دو گام فاصله رد می‌شود — پنجره بی‌دلیل باز نمی‌ماند", () => {
    const far = totp(RFC_SECRET, new Date((1111111111 + 90) * 1000));
    assert.equal(verifyTotp(RFC_SECRET, far, at), false);
  });

  test("کد غلط، کوتاه، بلند و غیرعددی همه رد می‌شوند", () => {
    for (const bad of ["000000", "12345", "1234567", "abcdef", "", "05047 1a"]) {
      assert.equal(verifyTotp(RFC_SECRET, bad, at), false, `«${bad}»`);
    }
  });

  test("فاصله داخل کد پذیرفته می‌شود", () => {
    // اپ‌ها کد را «۰۵۰ ۴۷۱» نشان می‌دهند و کاربر همان را کپی می‌کند.
    assert.equal(verifyTotp(RFC_SECRET, "050 471", at), true);
  });
});

describe("راز و URI", () => {
  test("راز تازه ۲۰ بایت است و هر بار فرق می‌کند", () => {
    const a = newTotpSecret();
    const b = newTotpSecret();
    assert.notEqual(a, b);
    assert.equal(base32Decode(a).length, 20);
  });

  test("URI هم مسیر و هم پارامتر issuer را دارد", () => {
    // بعضی اپ‌ها اولی را می‌خوانند و بعضی دومی؛ نبودِ هرکدام یعنی
    // حساب در فهرست کاربر «ناشناس» دیده شود.
    const uri = otpauthUri({ secret: "ABCD", account: "ali", issuer: "لیبل مد" });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /issuer=/);
    assert.match(uri, /secret=ABCD/);
    assert.match(uri, /algorithm=SHA1/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });
});
