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
import { esc, labelGeometry, labelPage, LabelSizeError, barcodeFitsWidth, minRollWidthFor, ROLL_MIN_HEIGHT_MM, ROLL_MIN_WIDTH_MM, ROLL_PRESETS_MM, type LabelItem } from "../src/catalog/label.ts";
import { LABEL_BRAND, LabelRowError, labelCalibrationPage, rollRowProblem, rollRowSlots, type RollRow } from "../src/catalog/label.ts";

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
    assert.ok(html.includes("2,400,000"), "Toman with Latin digits and grouping");
    assert.ok(html.includes("تومان"));
    assert.ok(!html.includes("24,000,000"), "ریال نباید روی برچسب بیاید");
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
    // شکست پیش از برچسب دوم به بعد؛ «پس از هر برچسب» یک لیبل سفید آخر می‌ساخت.
    assert.ok(html.includes(".label + .label { break-before: page; }"));
    assert.ok(!html.includes("page-break-after"), "برچسب آخر صفحهٔ خالی نمی‌سازد");
    assert.equal((html.match(/<div class="label">/g) ?? []).length, 3);
  });

  test("چیدمان A4 شبکه‌ای است، نه یک‌در‌صفحه", () => {
    const html = labelPage([base], { layout: "a4", shopName: "ف" });
    assert.ok(html.includes("@page { size: A4"));
    assert.ok(html.includes("grid-template-columns"));
    assert.ok(!html.includes("page-break-after: always"));
    assert.ok(!html.includes("break-before: page"));
  });

  test("سند کامل و راست‌به‌چپ است", () => {
    const html = labelPage([base], { layout: "a4", shopName: "ف" });
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes('lang="fa"'));
    assert.ok(html.includes('dir="rtl"'));
    assert.ok(html.trimEnd().endsWith("</html>"));
  });
});

describe("اندازهٔ برچسب", () => {
  test("printed text uses Latin digits without changing the stored barcode or inputs", () => {
    const item: LabelItem = { barcode: "20514161201032064", sku: "کد-۱۲", productName: "مدل ۱۴۰۵ <جدید>",
      brand: "برند ٢", color: "رنگ ۳", size: "۳۶", priceRial: 43_800_005n, count: 1 };
    for (const layout of ["roll", "a4"] as const) {
      const html = labelPage([item], { layout, shopName: "لیبل مد ۱", rollMm: { width: 50, height: 30 } });
      const body = html.slice(html.indexOf("<body>"));
      assert.doesNotMatch(body, /[۰-۹٠-٩]/);
      assert.match(body, /4,380,000\.5/);
      assert.match(body, /مدل 1405 &lt;جدید&gt;/);
      assert.match(body, /برند 2/);
      assert.match(body, /20514161201032064/);
    }
    assert.equal(item.size, "۳۶");
    assert.equal(item.productName, "مدل ۱۴۰۵ <جدید>");
    const fallback = labelPage([{ ...item, barcode: null }], { layout: "roll", shopName: "فروشگاه" });
    assert.match(fallback, /کد-12/);
  });
  const item: LabelItem = {
    barcode: makeEan13(7), sku: "P-7", productName: "مانتو کتان بلند با نام بسیار طولانی برای آزمون شکست سطر",
    color: "سرمه‌ای", size: "XL", priceRial: 12_345_675n, count: 1,
  };
  const svgWidth = (html: string) => Number(/<svg[^>]*width="([\d.]+)mm"/.exec(html)?.[1]);

  test("در هر اندازهٔ آماده، بارکد کامل با حاشیهٔ سکوت داخل عرض برچسب جا می‌شود", () => {
    for (const p of ROLL_PRESETS_MM) {
      const html = labelPage([item], { layout: "roll", shopName: "ف", rollMm: p });
      const w = svgWidth(html);
      assert.ok(w > 0, `بارکد رسم شد ${p.width}×${p.height}`);
      assert.ok(w <= p.width - 1, `${p.width}×${p.height}: بارکد ${w}mm از عرض بیرون زد`);
      const g = labelGeometry("roll", p.width, p.height);
      assert.equal(g.scanRisk, false, `${p.width}mm نباید هشدار اسکن بگیرد`);
      assert.ok([0.25, 0.375].includes(g.moduleMm), "ماژول مضرب نقطهٔ ۲۰۳dpi است");
    }
  });

  test("کمترین عرض: بارکد کامل با حاشیهٔ سکوت در عرض داخلی جا می‌شود و رقم‌ها همان بارکد ثبت‌شده‌اند", () => {
    const html = labelPage([item], { layout: "roll", shopName: "ف", rollMm: { width: ROLL_MIN_WIDTH_MM, height: 20 } });
    assert.ok(svgWidth(html) <= ROLL_MIN_WIDTH_MM - 1, "۰٫۵mm حاشیهٔ هر طرف");
    assert.equal(labelGeometry("roll", ROLL_MIN_WIDTH_MM, 20).moduleMm, 0.25);
    const digits = [...html.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((m) => m[1]).join("");
    assert.equal(digits, item.barcode, "رقم‌های چاپی همان بارکد ثبت‌شده‌اند");
    for (const w of [20, 25, 29]) {
      assert.equal(labelGeometry("roll", w, 30).fits, false, `${w}mm نباید پذیرفته شود`);
      assert.throws(() => labelPage([item], { layout: "roll", shopName: "ف", rollMm: { width: w, height: 30 } }), LabelSizeError);
    }
  });

  test("ترتیب مرجع: فروشگاه، بارکد (رقم‌ها زیر میله)، دو سطر شرح با برند/رنگ/سایز، قیمت درشت پایین", () => {
    const html = labelPage([{ ...item, brand: "برند <ب>" }], { layout: "roll", shopName: "فروشگاه لیبل مد", rollMm: { width: 58, height: 40 } });
    const label = html.slice(html.indexOf('<div class="label">'));
    const order = ["shop", "code", "desc", "price"].map((c) => label.indexOf(`<div class="${c}"`));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)), `ترتیب ردیف‌ها: ${order.join(",")}`);
    assert.match(label, /<div class="desc"><span class="l">مانتو کتان[^<]*<\/span><span class="l">برند &lt;ب&gt; · سرمه‌ای · XL<\/span>/);
    assert.match(html, /\.label > div \{ flex: none;/, "هیچ ردیفی فشرده نمی‌شود");
    assert.match(html, /\.desc \.l \{ display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
    const g50 = labelGeometry("roll", 50, 30);
    assert.ok(g50.showShop && g50.nameLines === 2 && g50.barHeightMm >= 6, "۵۰×۳۰ مرجع: فروشگاه + دو سطر شرح + بارکد");
    assert.equal(g50.moduleMm, 0.375, "۵۰×۳۰: بارکد پهن");
    const g40 = labelGeometry("roll", 40, 25);
    assert.ok(g40.showShop, "۴۰×۲۵: فروشگاه می‌ماند");
    assert.ok(!labelGeometry("roll", 30, 20).showShop, "۳۰×۲۰: نام فروشگاه پیش از بارکد کنار می‌رود");
  });

  test("بودجهٔ ارتفاع: در هر اندازهٔ معتبر همهٔ ردیف‌ها کامل جا می‌شوند و شرح فقط سطر کامل دارد", () => {
    for (let w = ROLL_MIN_WIDTH_MM; w <= 120; w += 1) {
      for (let h = ROLL_MIN_HEIGHT_MM; h <= 120; h += 1) {
        const g = labelGeometry("roll", w, h);
        assert.ok(g.fits, `${w}×${h} باید جا شود`);
        const rows = [g.showShop ? g.rows.shop : null, g.rows.code, g.rows.desc, g.rows.price]
          .filter((v): v is number => v !== null);
        const used = g.padY[0] + g.padY[1] + 0.4 * (rows.length - 1) + rows.reduce((a, b) => a + b, 0);
        assert.ok(used <= h + 1e-9, `${w}×${h}: ردیف‌ها ${used.toFixed(2)}mm از ارتفاع بیشترند`);
        assert.ok(g.barHeightMm >= 5, `${w}×${h}: میلهٔ ${g.barHeightMm}mm`);
        assert.ok(Math.abs(g.rows.desc - g.nameLines * g.fontMm * 1.3) < 0.01, `${w}×${h}: ردیف شرح نیم‌سطر دارد`);
        assert.ok(g.moduleMm * 113 <= w - 1 + 1e-9, `${w}×${h}: حاشیهٔ سکوت بیرون می‌زند`);
      }
    }
  });

  test("ارتفاع کمتر از کمینه برچسب ناخوانا نمی‌سازد؛ خطای ۴۲۲ با پیام روشن", () => {
    for (let h = 10; h < ROLL_MIN_HEIGHT_MM; h++) {
      assert.equal(labelGeometry("roll", 50, h).fits, false, `${h}mm نباید پذیرفته شود`);
    }
    assert.throws(() => labelPage([item], { layout: "roll", shopName: "ف", rollMm: { width: 50, height: 10 } }),
      (err: unknown) => err instanceof LabelSizeError && err.statusCode === 422 && /دست‌کم 30×20/.test(err.message));
  });

  test("A4 هم در همان بودجه جا می‌شود", () => {
    const g = labelGeometry("a4", 70, 37);
    assert.ok(g.fits && g.showShop && g.nameLines === 2 && g.moduleMm === 0.3);
  });

  test("قیمت به تومان دقیق است؛ ریال کسری گم نمی‌شود", () => {
    const html = labelPage([item], { layout: "a4", shopName: "ف" });
    assert.ok(html.includes("1,234,567.5"), "Exact fractional Toman uses Latin digits");
  });

  test("هندسه تعداد ماژول واقعی بارکد را می‌گیرد و زیر ۰٫۲۵mm نمی‌رود", () => {
    assert.equal(barcodeFitsWidth(165, 50), true);
    assert.equal(barcodeFitsWidth(165, 42), false);
    assert.equal(minRollWidthFor(165), 43);
    assert.equal(minRollWidthFor(113), 30);
    const g = labelGeometry("roll", 50, 30, 165);
    assert.ok(g.fits && g.moduleMm === 0.25, "۵۰×۳۰ مرجع: ماژول ۰٫۲۵mm");
    assert.equal(labelGeometry("roll", 50, 30).moduleMm, 0.375, "EAN-13 همان قبلی");
    assert.equal(labelGeometry("roll", 30, 20, 165).fits, false);
  });
});


describe("رول دو‌ستونه (BIXOLON XD3-40t، ۵۰×۳۰)", () => {
  // پهنای لاینر و فاصله نمونه‌اند (اندازه‌گیری مالک هنوز نیامده)، نه پیش‌فرض محصول.
  const ROW: RollRow = { columns: 2, gapMm: 3, mediaWidthMm: 106, offsetXMm: 0, startSlot: 1 };
  const SIZE = { width: 50, height: 30 };
  const mk = (sku: string, count: number, over: Partial<LabelItem> = {}): LabelItem => ({
    barcode: makeEan13(Number(sku.replace(/\D/g, "")) || 1), sku, productName: `کالا ${sku}`, color: "مشکی", size: "M", priceRial: 1_000_000n, count, ...over,
  });
  const page = (items: LabelItem[], row: RollRow = ROW) => labelPage(items, { layout: "roll", shopName: LABEL_BRAND, rollMm: SIZE, rollRow: row });
  /** [ردیف][ستون] → SKU یا «-» برای خانهٔ خالی، از خودِ HTML. */
  const cells = (html: string) => [...html.matchAll(/<div class="slot( slot--empty)?" data-slot="(\d)" style="left:([\d.-]+)mm">(?:<div class="label">[\s\S]*?<span class="l">کالا (LM-\d+))?/g)]
    .map((m) => ({ empty: m[1] !== undefined, slot: Number(m[2]), left: Number(m[3]), sku: m[4] ?? null }));
  const rows = (html: string) => (html.match(/<div class="row" data-row=/g) ?? []).length;

  test("کنترل منفی: رندرر قدیمی (بی rollRow) برای ۵۰×۳۰ هر لیبل را یک صفحهٔ ۵۰mm می‌کند، نه یک ردیف کامل", () => {
    const old = labelPage([mk("LM-1", 2)], { layout: "roll", shopName: LABEL_BRAND, rollMm: SIZE });
    assert.match(old, /@page \{ size: 50mm 30mm; margin: 0; \}/);
    assert.match(old, /\.label \+ \.label \{ break-before: page; \}/);
    assert.doesNotMatch(old, /class="row"|class="slot/);
    const now = page([mk("LM-1", 2)]);
    assert.match(now, /@page \{ size: 106mm 30mm; margin: 0; \}/, "صفحه = کل ردیف (پهنای لاینر)، جدا از اندازهٔ لیبل");
    assert.match(now, /\.slot \{ position: absolute; top: 0; width: 50mm; height: 30mm; \}/);
    assert.doesNotMatch(now, /\.label \+ \.label/);
  });

  test("خانه‌ها: ستون ۱ چپ فیزیکی، فاصله و حاشیهٔ دو طرف دقیق؛ ردیف ltr و لیبل rtl", () => {
    assert.deepEqual(rollRowSlots(50, ROW), { spanMm: 103, leftMm: [1.5, 54.5] });
    assert.deepEqual(rollRowSlots(50, { ...ROW, offsetXMm: -1.25 }).leftMm, [0.25, 53.25]);
    const html = page([mk("LM-1", 2)]);
    assert.match(html, /\.row \{ position: relative; direction: ltr;/);
    assert.match(html, /\.slot > \.label \{ direction: rtl; \}/);
    assert.deepEqual(cells(html).map((c) => [c.slot, c.left]), [[1, 1.5], [2, 54.5]]);
  });

  for (const n of [1, 2, 3, 5, 500]) {
    test(`${n} لیبل: ترتیب، بی تکرار/گم‌شدن، ردیف آخر ناقص و بی صفحهٔ خالی اضافه`, () => {
      const items = n === 500 ? Array.from({ length: 200 }, (_, i) => mk(`LM-${i + 1}`, i < 100 ? 3 : 2)) : [mk("LM-1", n)];
      const html = page(items);
      const c = cells(html);
      const want = items.flatMap((i) => Array<string>(i.count).fill(i.sku));
      assert.equal(want.length, n);
      assert.equal(rows(html), Math.ceil(n / 2));
      assert.deepEqual(c.filter((x) => !x.empty).map((x) => x.sku), want, "ترتیب درخواست، یک‌به‌یک");
      assert.equal(c.filter((x) => x.empty).length, n % 2, "فقط خانهٔ آخر ردیف فرد خالی است");
      assert.equal((html.match(/break-before: page/g) ?? []).length, 1, "شکست فقط میان ردیف‌ها (.row + .row)");
      assert.equal((html.match(/class="label"/g) ?? []).length, n);
    });
  }

  test("خانهٔ شروع ۲ روی رول نیمه‌مصرف: ۳ لیبل = ۲ ردیف، خانهٔ اول ردیف اول خالی، ترتیب تنوع‌ها حفظ", () => {
    const html = page([mk("LM-7", 1), mk("LM-8", 2)], { ...ROW, startSlot: 2 });
    assert.deepEqual(cells(html).map((x) => x.sku), [null, "LM-7", "LM-8", "LM-8"]);
    assert.equal(rows(html), 2);
    // startSlot ۲ با تعداد زوج یعنی ردیف آخر ناقص — باز هم بی ردیف خالی.
    const two = page([mk("LM-9", 2)], { ...ROW, startSlot: 2 });
    assert.deepEqual(cells(two).map((x) => x.sku), [null, "LM-9", "LM-9", null]);
  });

  test("محتوای دشوار در ردیف: نام بلند، بی‌قیمت، بی‌بارکد، EAN-13 و کد قدیمی ۱۷ رقمی Code128", () => {
    const html = page([
      mk("LM-1", 1, { productName: "شلوار پارچه‌ای رگولار با نام بسیار طولانی ".repeat(3) }),
      mk("LM-2", 1, { priceRial: null }),
      mk("LM-3", 1, { barcode: null }),
      mk("LM-4", 1, { barcode: "12345678901234567" }),
    ]);
    assert.equal((html.match(/class="label"/g) ?? []).length, 4);
    assert.match(html, /بدون قیمت/);
    assert.match(html, /class="nobarcode">LM-3</);
    assert.match(html, /<svg[^>]*>/);
  });

  test("عنوان بالای بارکد دقیقاً «Label Mod» انگلیسی و LTR است", () => {
    const html = page([mk("LM-1", 1)]);
    assert.equal(LABEL_BRAND, "Label Mod");
    assert.match(html, /<div class="shop" dir="ltr" lang="en">Label Mod<\/div>/);
    assert.doesNotMatch(html, /لیبل مد/);
  });

  test("اعتبارسنجی: پهنای چاپ‌پذیر ۱۰۴ از پهنای کاغذ ۱۱۸ جداست؛ هیچ Fit یا برش پنهانی نیست", () => {
    assert.equal(rollRowProblem(50, ROW), null);
    assert.equal(rollRowProblem(50, { ...ROW, gapMm: 4, mediaWidthMm: 110 }), null, "۱۰۴ دقیقاً مرز");
    assert.match(rollRowProblem(50, { ...ROW, gapMm: 5, mediaWidthMm: 112 })!, /پهنای چاپ‌پذیر 104/, "۱۰۵ > ۱۰۴ حتی با کاغذ پهن‌تر");
    assert.match(rollRowProblem(50, { ...ROW, mediaWidthMm: 100 })!, /پهنای کاغذ \(100\) از کل ردیف/);
    assert.match(rollRowProblem(50, { ...ROW, mediaWidthMm: 119 })!, /بین 15 و 118/);
    assert.match(rollRowProblem(50, { ...ROW, offsetXMm: 2 })!, /بیرون از کاغذ/, "حاشیهٔ ۱٫۵ + ۲ > لبه");
    assert.match(rollRowProblem(50, { ...ROW, offsetXMm: 11 })!, /جابه‌جایی افقی/);
    // کاغذ پهن‌تر از ۱۰۴: جابه‌جایی نمی‌تواند لیبل را از پنجرهٔ چاپ‌پذیر وسط کاغذ بیرون ببرد.
    assert.match(rollRowProblem(50, { ...ROW, mediaWidthMm: 118, offsetXMm: -7 })!, /پهنای چاپ‌پذیر 104 میلی‌متر \(وسطِ کاغذ\)/);
    assert.equal(rollRowProblem(50, { ...ROW, mediaWidthMm: 118, offsetXMm: -0.5 }), null);
    assert.equal(rollRowProblem(50, { ...ROW, offsetXMm: -0.5 }), null, "لبهٔ پنجره (۱mm از چپ در کاغذ ۱۰۶) هنوز مجاز است");
    assert.match(rollRowProblem(50, { ...ROW, gapMm: -1 })!, /فاصلهٔ میان/);
    assert.match(rollRowProblem(50, { ...ROW, startSlot: 3 })!, /خانهٔ شروع/);
    assert.match(rollRowProblem(50, { ...ROW, columns: 0 })!, /تعداد ستون/);
    assert.match(rollRowProblem(50, { ...ROW, gapMm: Number.NaN })!, /نامعتبر/);
    assert.match(rollRowProblem(50, { ...ROW, mediaWidthMm: Number.POSITIVE_INFINITY })!, /نامعتبر/);
    assert.throws(() => page([mk("LM-1", 1)], { ...ROW, gapMm: 5, mediaWidthMm: 112 }), (e) => e instanceof LabelRowError && e.statusCode === 422);
  });

  test("ردیف کالیبراسیون: یک صفحه، یک قاب در هر خانه، بی کالا", () => {
    const html = labelCalibrationPage(SIZE, ROW);
    assert.equal(rows(html), 1);
    assert.equal((html.match(/class="calib"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /class="label"|<svg/);
    assert.match(html, /ردیف کالیبراسیون/);
    assert.match(html, /@page \{ size: 106mm 30mm; margin: 0; \}/);
    assert.throws(() => labelCalibrationPage(SIZE, { ...ROW, mediaWidthMm: 90 }), LabelRowError);
  });
});


describe("عنوان بزرگ‌تر و قیمت کوچک‌تر، بی تغییر بارکد (خواستهٔ مالک ۱۴۰۵/۰۷/۲۱)", () => {
  test("ماژول، ارتفاع میله و ردیف بارکد هر اندازه دقیقاً همان main پیش از این تغییر است", () => {
    // مقدارهای ثبت‌شده از a5cac0a (پیش از تغییر قلم‌ها).
    const before: Array<[number, number, number, number, number, boolean, number]> = [
      [30, 20, 0.25, 6.8, 10, false, 1], [40, 25, 0.25, 5.2, 8.4, true, 2], [40, 30, 0.25, 9.1, 12.3, true, 2],
      [50, 25, 0.375, 5.2, 8.4, true, 2], [50, 30, 0.375, 6.7, 9.9, true, 2], [58, 40, 0.375, 13.6, 16.8, true, 2], [60, 40, 0.375, 13.6, 16.8, true, 2]];
    for (const [w, h, mod, bar, code, shop, lines] of before) {
      const g = labelGeometry("roll", w, h);
      assert.deepEqual([g.moduleMm, g.barHeightMm, g.rows.code, g.showShop, g.nameLines], [mod, bar, code, shop, lines], `${w}×${h}`);
      // ۲۰۳dpi: ماژول مضرب صحیح نقطهٔ ۰٫۱۲۵mm است.
      assert.equal(Number.isInteger(g.moduleMm / 0.125), true, `${w}×${h} module ${g.moduleMm}`);
    }
    const a4 = labelGeometry("a4", 70, 37);
    assert.deepEqual([a4.moduleMm, a4.barHeightMm], [0.3, 12]);
  });

  test("قلم «Label Mod» ۱٫۲ برابر و قیمت حداکثر ۱٫۴ برابر قلم پایه؛ ارتفاع ردیف‌ها همان بودجه", () => {
    const g = labelGeometry("roll", 50, 30);
    const html = labelPage([{ barcode: makeEan13(77), sku: "A", productName: "شال", color: null, size: null, priceRial: 1_000_000n, count: 1 }],
      { layout: "roll", shopName: "Label Mod", rollMm: { width: 50, height: 30 } });
    assert.match(html, new RegExp(`\\.shop \\{ height: ${g.rows.shop}mm; line-height: ${g.rows.shop}mm; font-size: ${(g.fontMm * 1.2).toFixed(2)}mm;`));
    const price = Number(/<div class="price" style="font-size:([\d.]+)mm">/.exec(html)![1]);
    assert.equal(price, Number((g.fontMm * 1.4).toFixed(2)), "قیمت کوتاه با اندازهٔ درخواست‌شده چاپ می‌شود");
    assert.ok(price * 1.12 <= g.rows.price + 1e-9, "قیمت در ارتفاع ردیف خودش جا می‌شود");
  });
});
