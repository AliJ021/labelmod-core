/**
 * رسم بارکد و ساخت برچسب — منطق خالص، بدون دیتابیس.
 *
 * ادعای مرکزیِ بخش بارکد: **رفت‌وبرگشت**. هر بارکدی که به میله تبدیل
 * می‌شود باید از همان میله‌ها دوباره به همان رقم‌ها برگردد. رمزگشا
 * جدول‌ها را دوباره نمی‌نویسد — از `indexOf` روی همان‌ها استفاده
 * می‌کند — ولی الگوی زوج/فرد و نگهبان‌ها و جای رقم‌ها را مستقل
 * می‌سنجد. اگر شش رقم چپ و راست جابه‌جا می‌شدند یا الگوی زوج/فرد غلط
 * بود، رفت‌وبرگشت می‌شکست.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ean13Modules,
  decodeEan13Modules,
  ean13Svg,
  EAN13_MODULES,
  BarcodeError,
} from "../src/catalog/barcode-svg.ts";
import { makeEan13, ean13CheckDigit } from "../src/catalog/barcode.ts";
import { esc, labelPage, type LabelItem } from "../src/catalog/label.ts";

describe("رسم EAN-13", () => {
  test("نوار ۹۵ ماژول است و نگهبان‌ها سر جایشان‌اند", () => {
    const m = ean13Modules(makeEan13(1234));
    assert.equal(m.length, EAN13_MODULES);
    assert.equal(m.slice(0, 3), "101", "نگهبان چپ");
    assert.equal(m.slice(45, 50), "01010", "نگهبان میانی");
    assert.equal(m.slice(92, 95), "101", "نگهبان راست");
    assert.match(m, /^[01]+$/);
  });

  test("رفت‌وبرگشت روی هزار بارکد داخلی", () => {
    for (let serial = 0; serial < 1000; serial++) {
      const code = makeEan13(serial);
      assert.equal(
        decodeEan13Modules(ean13Modules(code)),
        code,
        `رفت‌وبرگشت شکست: ${code}`,
      );
    }
  });

  test("رفت‌وبرگشت برای هر ده رقمِ اول — یعنی هر ده الگوی زوج/فرد", () => {
    for (let first = 0; first <= 9; first++) {
      const body = `${first}90123412345`.slice(0, 12);
      const code = body + ean13CheckDigit(body);
      assert.equal(
        decodeEan13Modules(ean13Modules(code)),
        code,
        `الگوی زوج/فرد رقم ${first} شکست`,
      );
    }
  });

  test("نمونه مرجع استاندارد ۵۹۰۱۲۳۴۱۲۳۴۵۷", () => {
    const ref = "5901234123457";
    assert.equal(ean13CheckDigit(ref.slice(0, 12)), ref[12], "رقم کنترل نمونه");
    assert.equal(decodeEan13Modules(ean13Modules(ref)), ref);
  });

  test("رقم اول در میله‌ها کدگذاری نمی‌شود، ولی نوار را عوض می‌کند", () => {
    // همان دوازده رقم آخر، فقط رقم اول فرق دارد → نوار باید فرق کند،
    // چون رقم اول الگوی زوج/فرد شش رقم چپ را تعیین می‌کند.
    const a = "1" + "23456789012";
    const b = "7" + "23456789012";
    const ca = a + ean13CheckDigit(a);
    const cb = b + ean13CheckDigit(b);
    assert.notEqual(ean13Modules(ca).slice(3, 45), ean13Modules(cb).slice(3, 45));
    // …ولی نیمه راست فقط به رقم‌های خودش وابسته است. پنج رقم اولِ آن
    // در هر دو یکی است؛ ششمی رقم کنترل است و طبیعتاً فرق دارد.
    assert.equal(ean13Modules(ca).slice(50, 85), ean13Modules(cb).slice(50, 85));
  });

  test("بارکد نامعتبر رسم نمی‌شود", () => {
    assert.throws(() => ean13Modules("123"), BarcodeError);
    assert.throws(() => ean13Modules("abcdefghijklm"), BarcodeError);
    // رقم کنترل غلط: دقیقاً همان چیزی که نباید چاپ شود
    const good = makeEan13(55);
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    assert.throws(() => ean13Modules(bad), BarcodeError);
  });

  /**
   * هندسه SVG را از خودِ خروجی بازمی‌خواند و دوباره رمزگشایی می‌کند.
   *
   * تست‌های بالا فقط رشته ماژول‌ها را می‌سنجند — یعنی اگر جدول‌ها درست
   * باشند ولی **رسم** خراب باشد (گرد کردن مختصات دو میله را به هم
   * بچسباند، حاشیه آرام جابه‌جا شود، یا میله‌ای دو بار کشیده شود)
   * همه‌شان سبز می‌مانند و بارکد چاپ‌شده خوانده نمی‌شود.
   *
   * اینجا از `x` و `width` هر مستطیل، نوار را بازمی‌سازیم — همان کاری
   * که یک اسکنر با پیکسل‌ها می‌کند، منتها روی مختصات.
   */
  function modulesFromSvg(svg: string, moduleMm: number, quietLeft: number): string {
    const bars = new Array<string>(EAN13_MODULES).fill("0");
    const re = /<rect x="([\d.]+)" y="0" width="([\d.]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(svg)) !== null) {
      const x = Number(m[1]);
      const w = Number(m[2]);
      // هر مستطیل باید دقیقاً یک ماژول پهن باشد
      assert.ok(
        Math.abs(w - moduleMm) < 1e-6,
        `پهنای میله باید یک ماژول باشد، بود ${w}`,
      );
      const idx = Math.round(x / moduleMm) - quietLeft;
      assert.ok(
        idx >= 0 && idx < EAN13_MODULES,
        `میله بیرون از نوار افتاد: x=${x} → ${idx}`,
      );
      assert.equal(bars[idx], "0", `دو میله روی ماژول ${idx} افتادند`);
      bars[idx] = "1";
    }
    return bars.join("");
  }

  test("نوار رسم‌شده دوباره به همان بارکد رمزگشایی می‌شود", () => {
    for (const serial of [0, 1, 42, 999, 123456]) {
      const code = makeEan13(serial);
      const svg = ean13Svg(code, { moduleMm: 0.33 });
      const rebuilt = modulesFromSvg(svg, 0.33, 11);
      assert.equal(rebuilt, ean13Modules(code), `هندسه با کدگذاری نمی‌خواند: ${code}`);
      assert.equal(decodeEan13Modules(rebuilt), code, `از روی رسم خوانده نشد: ${code}`);
    }
  });

  test("پهنای دیگر ماژول هم هندسه را نمی‌شکند", () => {
    const code = makeEan13(777);
    for (const mm of [0.264, 0.3, 0.495]) {
      const rebuilt = modulesFromSvg(ean13Svg(code, { moduleMm: mm }), mm, 11);
      assert.equal(decodeEan13Modules(rebuilt), code, `پهنای ${mm} شکست`);
    }
  });

  test("نویسه‌های نامعتبر در SVG راه پیدا نمی‌کنند", () => {
    const svg = ean13Svg(makeEan13(7));
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.ok(svg.includes("mm"), "اندازه باید میلی‌متر باشد، نه پیکسل");
    assert.ok(!svg.includes("NaN"), "هیچ عدد نامعتبری در خروجی");
    assert.ok(!/\d[eE][+-]?\d/.test(svg), "هیچ عدد با نماد نمایی در خروجی");
    // حاشیه آرام: نوار نباید از لبه صفر شروع شود
    assert.ok(!svg.includes('<rect x="0" y="0" width="0.3'), "حاشیه آرام لازم است");
  });
});

describe("برچسب قیمت", () => {
  const base: LabelItem = {
    barcode: makeEan13(42),
    sku: "P-001",
    productName: "پیراهن کلاسیک",
    color: "مشکی",
    size: "L",
    priceRial: 24_000_000n,
    count: 1,
  };

  test("متن خطرناک فرار نمی‌کند", () => {
    assert.equal(esc("<b>"), "&lt;b&gt;");
    assert.equal(esc("a&b"), "a&amp;b");
    assert.equal(esc(`"'`), "&quot;&#39;");
    assert.equal(esc("بی‌خطر"), "بی‌خطر");
  });

  test("نام کالای مخرب، اسکریپت اجرا نمی‌کند", () => {
    const html = labelPage(
      [{ ...base, productName: "<script>alert(1)</script>", color: "\" onload=\"x" }],
      { layout: "a4", shopName: "فروشگاه <img src=x onerror=y>" },
    );
    // نکته: خودِ **متن** «onerror=y» در خروجی می‌ماند و باید بماند —
    // همان چیزی است که کاربر تایپ کرده. چیزی که نباید بماند
    // **نشانه‌گذاری** است: هیچ `<` بازنشده‌ای که مرورگر تگ بخواندش.
    assert.ok(!/<script/i.test(html), "تگ اسکریپت نباید خام بماند");
    assert.ok(!/<img/i.test(html), "تگ تصویر نباید خام بماند");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "باید Escape شده باشد");
    assert.ok(html.includes("&quot; onload=&quot;x"), "فرار از صفت نباید ممکن باشد");
  });

  test("تعداد، برچسب تکراری می‌سازد", () => {
    const html = labelPage([{ ...base, count: 5 }], { layout: "a4", shopName: "ف" });
    assert.equal(html.split('class="label"').length - 1, 5);
  });

  test("قیمت به تومان نمایش داده می‌شود، نه ریال", () => {
    const html = labelPage([base], { layout: "a4", shopName: "ف" });
    // ۲۴٬۰۰۰٬۰۰۰ ریال = ۲٬۴۰۰٬۰۰۰ تومان
    assert.ok(html.includes("2٬400٬000"), "تومان با جداکننده هزارگان");
    assert.ok(html.includes("تومان"));
    assert.ok(!html.includes("24٬000٬000"), "ریال نباید روی برچسب بیاید");
  });

  test("کالای بی‌قیمت، برگه را نمی‌شکند — «بدون قیمت» می‌گیرد", () => {
    const html = labelPage([{ ...base, priceRial: null }], {
      layout: "a4",
      shopName: "ف",
    });
    assert.ok(html.includes("بدون قیمت"));
    assert.ok(!html.includes("NaN"));
  });

  test("کالای بی‌بارکد، SKU را نشان می‌دهد", () => {
    const html = labelPage([{ ...base, barcode: null }], {
      layout: "a4",
      shopName: "ف",
    });
    assert.ok(html.includes("P-001"));
    assert.ok(!html.includes("<svg"), "بارکدی نیست که رسم شود");
  });

  test("چیدمان رول، یک برچسب در هر صفحه با اندازه خواسته‌شده", () => {
    const html = labelPage([{ ...base, count: 3 }], {
      layout: "roll",
      shopName: "ف",
      rollMm: { width: 40, height: 25 },
    });
    assert.ok(html.includes("@page { size: 40mm 25mm"), "اندازه صفحه");
    assert.ok(html.includes("page-break-after: always"));
  });

  test("چیدمان A4 شبکه‌ای است، نه یک‌در‌صفحه", () => {
    const html = labelPage([base], { layout: "a4", shopName: "ف" });
    assert.ok(html.includes("@page { size: A4"));
    assert.ok(html.includes("grid-template-columns"));
    assert.ok(!html.includes("page-break-after: always"));
  });

  test("سند کامل و راست‌به‌چپ است", () => {
    const html = labelPage([base], { layout: "a4", shopName: "ف" });
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes('lang="fa"'));
    assert.ok(html.includes('dir="rtl"'));
    assert.ok(html.trimEnd().endsWith("</html>"));
  });
});
