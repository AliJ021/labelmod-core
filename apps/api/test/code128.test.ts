/**
 * Code128 برای بارکد ذخیره‌شدهٔ قدیمی — رشته عیناً حفظ می‌شود.
 * رمزگشای مستقل (zxing-wasm) در `apps/web/test/code128-decode.test.ts` است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CODE128_PATTERNS, CODE128_QUIET_MODULES, code128Modules, code128Svg, code128TotalModules } from "../src/catalog/code128.ts";
import { barcodeSymbology, barcodeTotalModules, labelPage, LabelSizeError, type LabelItem } from "../src/catalog/label.ts";
import { makeEan13 } from "../src/catalog/barcode.ts";

const LEGACY = "20514161201032064";

/** SVG → نوار ماژول، از روی هندسهٔ `<rect>`ها (مستقل از رمزگذار). */
function svgModules(svg: string, m: number): string {
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)].map((r) => [Number(r[1]), Number(r[2])] as const);
  const total = Math.round(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1]) / m);
  const bits = Array<string>(total).fill("0");
  for (const [x, w] of rects) for (let k = Math.round(x / m); k < Math.round((x + w) / m); k++) bits[k] = "1";
  return bits.join("").slice(CODE128_QUIET_MODULES, total - CODE128_QUIET_MODULES);
}

describe("Code128 سازگاری", () => {
  test("جدول ۱۰۷ نماد؛ هر نماد ۱۱ ماژول و Stop ۱۳", () => {
    assert.equal(CODE128_PATTERNS.length, 107);
    CODE128_PATTERNS.forEach((p, i) => {
      const sum = [...p].reduce((a, d) => a + Number(d), 0);
      assert.equal(sum, i === 106 ? 13 : 11, `نماد ${i}`);
    });
    assert.equal(new Set(CODE128_PATTERNS).size, 107, "هیچ دو نمادی یکسان نیستند");
  });

  test("کد ۱۷ رقمی دشت: ۱۶۵ ماژول با حاشیهٔ سکوت (۴۱٫۲۵mm در ۰٫۲۵mm) و رشته عیناً روی برچسب", () => {
    assert.equal(code128TotalModules(LEGACY), 165);
    const svg = code128Svg(LEGACY, { moduleMm: 0.25, heightMm: 8 });
    assert.match(svg, /width="41\.25mm"/);
    assert.ok(svg.includes(`>${LEGACY}</text>`), "رشتهٔ خوانا همان رشتهٔ ذخیره‌شده");
    assert.equal(svgModules(svg, 0.25), code128Modules(LEGACY), "میله‌های رسم‌شده همان نوار رمزشده‌اند");
  });

  test("صفرهای ابتدایی و رشتهٔ مختلط حفظ می‌شوند؛ نویسهٔ غیرچاپی رد می‌شود", () => {
    assert.notEqual(code128Modules("0012345678"), code128Modules("12345678"));
    assert.ok(code128Modules("LM-1203A").length > 0);
    assert.throws(() => code128Modules("کد"), /ASCII/);
  });

  test("EAN-13 معتبر همان EAN-13 می‌ماند؛ ۱۳ رقم با رقم کنترل غلط Code128 می‌شود", () => {
    const ean = makeEan13(42);
    assert.equal(barcodeSymbology(ean), "ean13");
    assert.equal(barcodeTotalModules(ean), 113);
    const bad = ean.slice(0, 12) + String((Number(ean[12]) + 1) % 10);
    assert.equal(barcodeSymbology(bad), "code128");
    assert.equal(barcodeSymbology(LEGACY), "code128");
  });

  test("برچسب ۵۰×۳۰ کد قدیمی را با ماژول ۰٫۲۵ چاپ می‌کند؛ ۴۰×۲۵ با پیام کمترین عرض رد می‌شود", () => {
    const item: LabelItem = { barcode: LEGACY, sku: "D-1", productName: "شلوار", brand: null, color: "مشکی", size: "38", priceRial: 12_340_000n, count: 1 };
    const html = labelPage([item], { layout: "roll", shopName: "فروشگاه لیبل مد", rollMm: { width: 50, height: 30 } });
    assert.ok(html.includes(`aria-label="بارکد ${LEGACY}"`));
    assert.match(html, /width="41\.25mm"/);
    assert.throws(() => labelPage([item], { layout: "roll", shopName: "ف", rollMm: { width: 40, height: 25 } }),
      (err: unknown) => err instanceof LabelSizeError && /دست‌کم 43×20/.test(err.message));
  });
});
