/**
 * تبدیل `base64url` — رایج‌ترین باگ WebAuthn سمت وب.
 *
 * `btoa`/`atob` استاندارد `base64` می‌دهند و WebAuthn `base64url`
 * می‌خواهد. تفاوتشان سه کاراکتر است (`+`↔`-`، `/`↔`_`، و `=` پایانی)
 * و نتیجه اشتباه‌گرفتنشان یک امضای **معتبر** است که سرور ردش می‌کند،
 * بدون هیچ پیام مفیدی. تستی که فقط رفت‌وبرگشتِ خودش را بسنجد این را
 * نمی‌گیرد — پس اینجا بردار ثابت با هر دو کاراکتر ویژه هست.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { __base64url } from "../src/lib/webauthn.ts";

const { fromBase64Url, toBase64Url } = __base64url;

function bytes(...n: number[]): ArrayBuffer {
  return new Uint8Array(n).buffer;
}

describe("base64url", () => {
  test("کاراکتر ۶۲ و ۶۳ را url-safe می‌نویسد، نه base64 استاندارد", () => {
    // این سه بایت در base64 استاندارد `+/8=` می‌شوند. اگر خروجی `+`
    // یا `/` داشته باشد، مراسم روی سرور رد می‌شود.
    const out = toBase64Url(bytes(0xfb, 0xff, 0xfc));
    assert.equal(out, "-__8");
    assert.doesNotMatch(out, /[+/=]/);
  });

  test("پایانه `=` نمی‌گذارد", () => {
    assert.equal(toBase64Url(bytes(1)), "AQ");
    assert.equal(toBase64Url(bytes(1, 2)), "AQI");
    assert.equal(toBase64Url(bytes(1, 2, 3)), "AQID");
  });

  test("ورودی بدون padding را می‌خواند — سرور padding نمی‌فرستد", () => {
    assert.deepEqual(Array.from(fromBase64Url("AQ")), [1]);
    assert.deepEqual(Array.from(fromBase64Url("AQI")), [1, 2]);
    assert.deepEqual(Array.from(fromBase64Url("AQID")), [1, 2, 3]);
  });

  test("`-` و `_` را همان ۶۲ و ۶۳ می‌فهمد", () => {
    assert.deepEqual(Array.from(fromBase64Url("-__8")), [0xfb, 0xff, 0xfc]);
  });

  test("رفت و برگشت، برای هر ۲۵۶ بایت", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    assert.deepEqual(Array.from(fromBase64Url(toBase64Url(all.buffer))), Array.from(all));
  });

  test("خروجی یک ArrayBuffer واقعی است، نه حافظه اشتراکی", () => {
    // `BufferSource` در DOM حافظه اشتراکی را نمی‌پذیرد؛ اگر این
    // بشکند، `navigator.credentials` ورودی را رد می‌کند.
    assert.ok(fromBase64Url("AQID").buffer instanceof ArrayBuffer);
  });
});
