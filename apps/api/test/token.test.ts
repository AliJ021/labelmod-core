import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hashToken, newToken, sessionCookieOptions } from "../src/auth/token.ts";
import { safeEqual } from "../src/auth/password.ts";

describe("توکن نشست", () => {
  test("۳۲ بایت آنتروپی و یکتا", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = newToken();
      assert.equal(Buffer.from(t, "base64url").length, 32);
      assert.ok(!seen.has(t), "توکن تکراری ساخته شد");
      seen.add(t);
    }
  });

  test("هش، شکلی است که قید دیتابیس می‌پذیرد", () => {
    const h = hashToken(newToken());
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test("هش قطعی است ولی برگشت‌پذیر نیست", () => {
    const t = newToken();
    assert.equal(hashToken(t), hashToken(t));
    assert.notEqual(hashToken(t), t);
  });

  test("کوکی: HttpOnly، SameSite=Strict، و Secure در تولید", () => {
    const prod = sessionCookieOptions({ secure: true, maxAgeSeconds: 3600 });
    assert.equal(prod.httpOnly, true);
    assert.equal(prod.sameSite, "strict");
    assert.equal(prod.secure, true);
    assert.equal(prod.path, "/");

    const dev = sessionCookieOptions({ secure: false, maxAgeSeconds: 3600 });
    assert.equal(dev.secure, false);
    assert.equal(dev.httpOnly, true, "HttpOnly حتی در توسعه روشن می‌ماند");
  });
});

describe("مقایسه زمان‌ثابت", () => {
  test("برابر و نابرابر", () => {
    assert.equal(safeEqual("123456", "123456"), true);
    assert.equal(safeEqual("123456", "123457"), false);
    assert.equal(safeEqual("123456", "12345"), false, "طول متفاوت باید false بدهد نه خطا");
    assert.equal(safeEqual("", ""), true);
  });
});
