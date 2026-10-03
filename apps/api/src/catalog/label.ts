/**
 * برچسب قیمت — صفحه آماده چاپ.
 *
 * چرا HTML و نه PDF: هیچ وابستگی تازه‌ای لازم ندارد (بند ۵
 * `SECURITY.md`)، از هر مرورگری روی هر چاپگری چاپ می‌شود، و اندازه‌ها
 * به **میلی‌متر** است نه پیکسل — پس آنچه چاپ می‌شود همان است که
 * اندازه‌گیری شده.
 *
 * ⚠️ **هر مقدار متنی اینجا از دیتابیس می‌آید و ریشه‌اش ورودی کاربر است**
 *    — نام کالا، رنگ، سایز. این صفحه از دامنه خودمان سرو می‌شود، پس
 *    یک `<script>` داخل نام کالا یعنی XSS ماندگار. دو لایه دفاع:
 *    ۱. هر درج متنی از `esc()` رد می‌شود.
 *    ۲. هدر CSP روی پاسخ، `script-src` را کاملاً می‌بندد. این صفحه
 *       اصلاً جاوااسکریپت لازم ندارد، پس بستن کامل هزینه‌ای ندارد و
 *       اگر لایه اول جایی نشت کرد، لایه دوم هنوز ایستاده است.
 */
import { ean13Svg } from "./barcode-svg.ts";
import { toTomanDisplay } from "../lib/money.ts";

/** هدر امنیتی صفحه برچسب. بدون جاوااسکریپت، بدون منبع بیرونی. */
export const LABEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export interface LabelItem {
  barcode: string | null;
  sku: string;
  productName: string;
  color: string | null;
  size: string | null;
  /** ریال. نمایش روی برچسب به تومان است — برچسب، لایه UI است. */
  priceRial: bigint | null;
  count: number;
}

export type LabelLayout = "a4" | "roll";

export interface LabelPageOptions {
  layout: LabelLayout;
  shopName: string;
  /** فقط برای `roll` — اندازه یک برچسب به میلی‌متر. */
  rollMm?: { width: number; height: number } | undefined;
}

const A4 = { cols: 3, rows: 8, w: 70, h: 37, marginTop: 4.5, marginLeft: 0 };

/**
 * اندازه‌های رایج رول لیبل‌زن (عرض × ارتفاع، میلی‌متر). فقط پیشنهادند؛
 * اندازهٔ دلخواه در بازهٔ مسیر API (عرض ۲۰ تا ۱۲۰، ارتفاع ۱۰ تا ۱۲۰) هم
 * پذیرفته می‌شود. فهرست واحد وب در `apps/web/src/lib/label-sizes.ts` است.
 */
export const ROLL_PRESETS_MM: ReadonlyArray<{ width: number; height: number }> = [
  { width: 30, height: 20 }, { width: 40, height: 25 }, { width: 40, height: 30 },
  { width: 50, height: 25 }, { width: 50, height: 30 }, { width: 58, height: 40 },
  { width: 60, height: 40 },
];

/** طول کامل EAN-13 با حاشیهٔ سکوت (۱۱ + ۹۵ + ۷ ماژول). */
const EAN13_TOTAL_MODULES = 113;

export interface LabelGeometry {
  /** پهنای یک ماژول بارکد به میلی‌متر. */
  moduleMm: number;
  /** ارتفاع میله‌ها به میلی‌متر (بدون ردیف رقم‌ها). */
  barHeightMm: number;
  /** اندازهٔ پایهٔ قلم به میلی‌متر. */
  fontMm: number;
  /** نام فروشگاه روی برچسب کوتاه جا نمی‌شود. */
  showShop: boolean;
  /** ماژول زیر ۰٫۲۵mm را بسیاری از اسکنرها نمی‌خوانند. */
  scanRisk: boolean;
  /** سطرهای نام کالا — روی برچسب کوتاه یک سطر، تا روی رنگ و قیمت نیفتد. */
  nameLines: number;
}

/**
 * هندسهٔ برچسب از روی اندازهٔ آن — بارکد هرگز از لبه بیرون نمی‌زند.
 *
 * ⚠️ **مقدار بارکد هرگز عوض نمی‌شود؛ فقط مقیاسش.** روی رول حرارتی
 *    ماژول به مضرب نقطهٔ چاپگر ۲۰۳dpi (۰٫۱۲۵mm) گرد می‌شود — ۰٫۳۷۵ یا
 *    ۰٫۲۵ — چون پهنای غیرصحیح نقطه، میله‌ها را نامساوی و اسکن را ناپایدار
 *    می‌کند. روی برگهٔ A4 (چاپگر لیزری) همان ۰٫۳ قبلی می‌ماند.
 */
export function labelGeometry(layout: LabelLayout, width: number, height: number): LabelGeometry {
  if (layout === "a4") {
    return { moduleMm: 0.3, barHeightMm: 12, fontMm: 3, showShop: true, scanRisk: false, nameLines: 2 };
  }
  // نیم میلی‌متر حاشیه هر طرف برای بارکد؛ متن حاشیهٔ بیشتری دارد.
  const usable = width - 1;
  const moduleMm = [0.375, 0.25].find((m) => m * EAN13_TOTAL_MODULES <= usable)
    ?? Math.floor((usable / EAN13_TOTAL_MODULES) * 1000) / 1000;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const showShop = height >= 28;
  return {
    moduleMm,
    barHeightMm: Math.round(clamp(height * 0.34, 5, 14) * 10) / 10,
    fontMm: Math.round(clamp(Math.min(height / 9, width / 15), 2, 3.4) * 10) / 10,
    showShop,
    scanRisk: moduleMm < 0.25,
    nameLines: height >= 30 ? 2 : 1,
  };
}

/** قیمت به تومان، بی‌آنکه ریالِ کسری گم شود. */
function priceToman(rial: bigint): string {
  const fraction = (rial < 0n ? -rial : rial) % 10n;
  return fraction === 0n ? toTomanDisplay(rial) : `${toTomanDisplay(rial)}٫${fraction}`;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function labelHtml(item: LabelItem, shopName: string, g: LabelGeometry): string {
  const variant = [item.color, item.size].filter((v) => v !== null && v !== "");
  const price =
    item.priceRial === null
      ? '<span class="noprice">بدون قیمت</span>'
      : `${esc(priceToman(item.priceRial))} <small>تومان</small>`;

  // بارکد نداشتن، خطا نیست: کالایی که بارکدش هنوز ساخته نشده باید
  // برچسبش چاپ شود ولی جای بارکد خالی بماند، نه اینکه کل برگه بشکند.
  const code = item.barcode
    ? ean13Svg(item.barcode, { moduleMm: g.moduleMm, heightMm: g.barHeightMm })
    : `<div class="nobarcode">${esc(item.sku)}</div>`;

  return `<div class="label">
  ${g.showShop ? `<div class="shop">${esc(shopName)}</div>` : ""}
  <div class="name">${esc(item.productName)}</div>
  ${variant.length ? `<div class="variant">${variant.map((v) => esc(v as string)).join(" · ")}</div>` : ""}
  <div class="price">${price}</div>
  <div class="code">${code}</div>
</div>`;
}

export function labelPage(items: LabelItem[], opts: LabelPageOptions): string {
  const roll = opts.rollMm ?? { width: 50, height: 30 };
  const isRoll = opts.layout === "roll";
  const size = isRoll ? roll : { width: A4.w, height: A4.h };
  const g = labelGeometry(opts.layout, size.width, size.height);

  const repeated: string[] = [];
  for (const item of items) {
    for (let i = 0; i < item.count; i++) {
      repeated.push(labelHtml(item, opts.shopName, g));
    }
  }

  const page = isRoll
    ? `@page { size: ${roll.width}mm ${roll.height}mm; margin: 0; }`
    : "@page { size: A4; margin: 0; }";

  // رول: هر برچسب یک صفحه. شکست **پیش از** برچسب دوم به بعد، نه «پس از»
  // هر برچسب — «پس از» روی برچسب آخر یک صفحهٔ خالی می‌ساخت و چاپگر یک
  // لیبل سفید هدر می‌داد.
  const labelBox = isRoll
    ? `width: ${roll.width}mm; height: ${roll.height}mm;`
    : `width: ${A4.w}mm; height: ${A4.h}mm;`;

  const sheet = isRoll
    ? `display: block; width: ${roll.width}mm;`
    : `display: grid;
       grid-template-columns: repeat(${A4.cols}, ${A4.w}mm);
       grid-auto-rows: ${A4.h}mm;
       padding-top: ${A4.marginTop}mm;`;

  const f = g.fontMm;
  const warn = g.scanRisk
    ? ` <strong>هشدار: این عرض برای بارکد کامل کم است و ممکن است اسکن نشود.</strong>`
    : "";

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>برچسب قیمت — ${esc(opts.shopName)}</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: Vazirmatn, Tahoma, sans-serif;
    background: #fff;
    color: #000;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { ${sheet} }
  .label {
    ${labelBox}
    padding: ${isRoll ? "1mm 1.5mm 0.8mm" : "1.6mm 2mm"};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    gap: 0.3mm;
    overflow: hidden;
    break-inside: avoid;
    /* خطوط برش فقط روی صفحه دیده می‌شوند، نه روی کاغذ */
    outline: 0.1mm dashed #bbb;
    outline-offset: -0.1mm;
  }
  ${isRoll ? ".label + .label { break-before: page; }" : ""}
  .shop { font-size: ${(f * 0.72).toFixed(2)}mm; letter-spacing: .15mm; font-weight: 600; line-height: 1.1; }
  .name {
    width: 100%;
    font-size: ${f.toFixed(2)}mm; font-weight: 700; text-align: center;
    line-height: 1.2;
    overflow-wrap: anywhere;
    /* نام بلند نباید برچسب را بترکاند؛ ارتفاع به مرز سطر بریده می‌شود تا
       نیم‌سطری روی رنگ یا قیمت نیفتد. */
    display: -webkit-box; -webkit-line-clamp: ${g.nameLines}; -webkit-box-orient: vertical;
    max-height: ${(g.nameLines * 1.2).toFixed(1)}em; flex: 0 1 auto; min-height: 0;
    overflow: hidden;
  }
  .shop, .variant, .price, .code { flex: 0 0 auto; }
  .variant { font-size: ${(f * 0.85).toFixed(2)}mm; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .price { font-size: ${(f * 1.4).toFixed(2)}mm; font-weight: 800; direction: rtl; line-height: 1.1; white-space: nowrap; }
  .price small { font-size: ${(f * 0.75).toFixed(2)}mm; font-weight: 500; }
  .noprice { font-size: ${(f * 0.9).toFixed(2)}mm; font-weight: 600; }
  .code { line-height: 0; max-width: 100%; }
  .code svg { display: block; }
  .nobarcode {
    font-family: monospace; font-size: ${(f * 0.85).toFixed(2)}mm; direction: ltr;
    border: 0.2mm solid #000; padding: 0.4mm 1mm;
  }
  @media print {
    .label { outline: none; }
    .hint { display: none; }
  }
  .hint {
    font-size: 3mm; color: #333; padding: 3mm; text-align: center;
    border-bottom: 1px solid #ddd;
  }
  .hint strong { color: #000; }
</style>
</head>
<body>
<div class="hint">${repeated.length} برچسب ${isRoll ? `${roll.width}×${roll.height} میلی‌متر` : "روی برگهٔ A4"} — مقیاس چاپ ۱۰۰٪ و بدون حاشیه.${warn}</div>
<div class="sheet">
${repeated.join("\n")}
</div>
</body>
</html>`;
}
