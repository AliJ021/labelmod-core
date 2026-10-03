/**
 * رمزگشای مستقل برای Code128 برچسب — همان zxing-wasm 3.1.3 که اسکنر دوربین
 * دارد (وابستگی تازه‌ای نیست). نوار از خودِ SVG برچسب (هندسهٔ `<rect>`ها)
 * به تصویر سیاه‌وسفید تبدیل و خوانده می‌شود، پس رمزگذار و رسم هر دو سنجیده
 * می‌شوند. رشته باید **عیناً** همان رشتهٔ ذخیره‌شده باشد.
 *
 * ⚠️ ماژول‌های `apps/api` با مسیر رشته‌ای بار می‌شوند: ایمیج وب آن پوشه را
 *    ندارد و `tsc` بیلد وب نباید دنبالش کند.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const wasm = readFileSync(fileURLToPath(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm")));
prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer } });

interface LabelModule {
  labelPage(items: unknown[], opts: { layout: "roll"; shopName: string; rollMm: { width: number; height: number } }): string;
}

/** SVG بارکد برچسب → تصویر: ۴ پیکسل برای هر ماژول، ۶۰ پیکسل ارتفاع. */
function rasterize(svg: string, moduleMm: number) {
  const width = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1]);
  const modules = Math.round(width / moduleMm);
  const px = 4, h = 60, w = modules * px;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const r of svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)) {
    const from = Math.round(Number(r[1]) / moduleMm) * px, to = Math.round((Number(r[1]) + Number(r[2])) / moduleMm) * px;
    for (let y = 0; y < h; y++) for (let x = from; x < to; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  }
  return { data, width: w, height: h, colorSpace: "srgb" as const };
}

for (const value of ["20514161201032064", "0012345678", "LM-1203A"]) {
  test(`Code128 روی برچسب ۵۰×۳۰ با zxing-wasm همان «${value}» خوانده می‌شود`, async () => {
    const labelModule = "../../api/src/catalog/label.ts";
    const { labelPage } = (await import(labelModule)) as LabelModule;
    const html = labelPage([{ barcode: value, sku: "S", productName: "کالا", brand: null, color: null, size: null, priceRial: 1_000_000n, count: 1 }],
      { layout: "roll", shopName: "ف", rollMm: { width: 50, height: 30 } });
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)![0];
    // کوچک‌ترین میله یک ماژول است؛ برچسب ۵۰mm ماژول ۰٫۲۵ یا ۰٫۳۷۵ می‌گیرد.
    const moduleMm = Math.min(...[...svg.matchAll(/<rect x="[\d.]+" y="0" width="([\d.]+)"/g)].map((r) => Number(r[1])));
    assert.ok([0.25, 0.375].includes(moduleMm), `ماژول ${moduleMm}`);
    const results = await readBarcodes(rasterize(svg, moduleMm) as unknown as ImageData, { formats: ["Code128"], tryHarder: true });
    assert.equal(results[0]?.text, value);
    assert.equal(results[0]?.format, "Code128");
  });
}
