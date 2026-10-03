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

/** کمترین ارتفاع رول که نام (یک سطر)، رنگ/سایز، قیمت و بارکد خوانا را با هم جا می‌دهد. */
export const ROLL_MIN_HEIGHT_MM = 20;
/**
 * کمترین عرض رول: EAN-13 کامل با حاشیهٔ سکوت در ماژول ۰٫۲۵mm برابر
 * ۲۸٫۲۵mm است و با ۰٫۵mm حاشیهٔ هر طرف در ۳۰mm جا می‌شود. باریک‌تر، یا
 * میله‌ها زیر حد اسکن می‌روند یا حاشیهٔ سکوت بریده می‌شود — و قیمت هم جا نمی‌شود.
 */
export const ROLL_MIN_WIDTH_MM = 30;
/** حاشیهٔ افقی ردیف بارکد (هر طرف) — پهنای داخلی بارکد = عرض − ۲×این. */
const CODE_PAD_X_MM = 0.5;
/** حاشیهٔ افقی ردیف‌های متنی (هر طرف). */
const TEXT_PAD_X_MM = 1;

/** ارتفاع میله‌های بارکد کمتر از این، با اسکنر دستی معمولی قابل اتکا نیست. */
const MIN_BAR_MM = 5;
/** ردیف رقم‌های زیر بارکد — همان `textH` در `ean13Svg`. */
const BARCODE_TEXT_MM = 3.2;
/** فاصلهٔ میان ردیف‌ها. */
const ROW_GAP_MM = 0.4;
/** ضریب ارتفاع سطر نام — حروف فارسی با نقطه و سرکش در ۱٫۳ کامل جا می‌شوند. */
const NAME_LINE = 1.3;

export interface LabelGeometry {
  /** پهنای یک ماژول بارکد به میلی‌متر. */
  moduleMm: number;
  /** ارتفاع میله‌ها به میلی‌متر (بدون ردیف رقم‌ها). */
  barHeightMm: number;
  /** اندازهٔ پایهٔ قلم به میلی‌متر. */
  fontMm: number;
  /** نام فروشگاه فقط وقتی جا هست. */
  showShop: boolean;
  /** ماژول زیر ۰٫۲۵mm را بسیاری از اسکنرها نمی‌خوانند. */
  scanRisk: boolean;
  /** سطرهای نام کالا؛ ارتفاع ردیف نام دقیقاً همین تعداد سطر کامل است. */
  nameLines: number;
  /** ارتفاع ثابت هر ردیف به میلی‌متر — هیچ ردیفی Flex-shrink نمی‌شود. */
  rows: { shop: number; name: number; variant: number; price: number; code: number };
  /** حاشیهٔ بالا/پایین برچسب به میلی‌متر. */
  padY: [number, number];
  /** آیا همهٔ ردیف‌ها با کمترین اندازهٔ خوانا جا می‌شوند؟ */
  fits: boolean;
}

/**
 * هندسهٔ برچسب از روی اندازهٔ آن — **بودجهٔ ارتفاع به میلی‌متر**.
 *
 * نسخهٔ قبلی ردیف نام را Flex-shrink می‌کرد؛ مرورگر جعبه را کوتاه‌تر از دو
 * سطر می‌کرد و سطر دوم از وسط حروف بریده می‌شد. حالا هر ردیف ارتفاع ثابت
 * دارد و جمعشان هرگز از ارتفاع برچسب بیشتر نیست: اگر جا نباشد، به ترتیب
 * نام فروشگاه، سطر دوم نام و سپس اندازهٔ قلم کم می‌شود، و میله‌ها هرگز از
 * ۵mm کوتاه‌تر نمی‌شوند. اگر باز هم جا نشود `fits = false` است و برچسب
 * ساخته نمی‌شود (`ROLL_MIN_HEIGHT_MM`).
 *
 * ⚠️ **مقدار بارکد هرگز عوض نمی‌شود؛ فقط مقیاسش.** روی رول حرارتی
 *    ماژول به مضرب نقطهٔ چاپگر ۲۰۳dpi (۰٫۱۲۵mm) گرد می‌شود — ۰٫۳۷۵ یا
 *    ۰٫۲۵ — چون پهنای غیرصحیح نقطه، میله‌ها را نامساوی و اسکن را ناپایدار
 *    می‌کند. روی برگهٔ A4 (چاپگر لیزری) همان ۰٫۳ قبلی می‌ماند. پهنای بارکد
 *    با حاشیهٔ سکوت هرگز از «عرض برچسب − ۱mm» بیشتر نیست.
 */
export function labelGeometry(layout: LabelLayout, width: number, height: number): LabelGeometry {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const isA4 = layout === "a4";
  const usable = width - 2 * CODE_PAD_X_MM;
  const moduleMm = isA4 ? 0.3 : [0.375, 0.25].find((m) => m * EAN13_TOTAL_MODULES <= usable)
    ?? Math.floor((usable / EAN13_TOTAL_MODULES) * 1000) / 1000;
  const padY: [number, number] = isA4 ? [1.6, 1.6] : [1, 0.8];
  const barCap = isA4 ? 12 : round1(clamp(height * 0.34, MIN_BAR_MM, 14));
  // بارکد کوتاه‌تر از ۷۰٪ سقفش ارزش نام فروشگاه یا سطر دوم نام را ندارد.
  const barTarget = Math.max(MIN_BAR_MM, barCap * 0.7);
  let fontMm = isA4 ? 3 : round1(clamp(Math.min(height / 9, width / 15), 2, 3.4));

  const rowsFor = (f: number, shop: boolean, lines: number) => ({
    shop: shop ? Math.round(f * 0.72 * 1.25 * 100) / 100 : 0,
    name: Math.round(lines * f * NAME_LINE * 100) / 100,
    variant: Math.round(f * 0.85 * 1.3 * 100) / 100,
    price: Math.round(f * 1.4 * 1.15 * 100) / 100,
  });
  const configs: Array<[boolean, number]> = [[true, 2], [false, 2], [false, 1]];
  for (;;) {
    if (!isA4 && (width < ROLL_MIN_WIDTH_MM || height < ROLL_MIN_HEIGHT_MM)) break;
    for (const [i, [shop, lines]] of configs.entries()) {
      const r = rowsFor(fontMm, shop, lines);
      const visible = shop ? 5 : 4;
      const fixed = padY[0] + padY[1] + ROW_GAP_MM * (visible - 1) + r.shop + r.name + r.variant + r.price + BARCODE_TEXT_MM;
      const bar = Math.floor(Math.min(barCap, height - fixed) * 10) / 10;
      const last = i === configs.length - 1;
      if (bar >= barTarget || (last && bar >= MIN_BAR_MM)) {
        return { moduleMm, barHeightMm: bar, fontMm, showShop: shop, scanRisk: moduleMm < 0.25, nameLines: lines,
          rows: { ...r, code: round1(bar + BARCODE_TEXT_MM) }, padY, fits: true };
      }
    }
    if (fontMm <= 2) break;
    fontMm = round1(fontMm - 0.1);
  }
  const r = rowsFor(2, false, 1);
  return { moduleMm, barHeightMm: MIN_BAR_MM, fontMm: 2, showShop: false, scanRisk: moduleMm < 0.25, nameLines: 1,
    rows: { ...r, code: MIN_BAR_MM + BARCODE_TEXT_MM }, padY, fits: false };
}

/** برچسبی که کمترین چیدمان خوانا هم در آن جا نمی‌شود. */
export class LabelSizeError extends Error {
  readonly statusCode = 422;
  readonly code = "label_too_small";
  constructor(width: number, height: number) {
    super(`لیبل ${width}×${height} میلی‌متر برای نام، قیمت و بارکد خوانا کوچک است؛ دست‌کم ${ROLL_MIN_WIDTH_MM}×${ROLL_MIN_HEIGHT_MM} میلی‌متر لازم است.`);
    this.name = "LabelSizeError";
  }
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

/**
 * اندازهٔ قلم قیمت تا تمام رقم‌ها در پهنای داخلی جا شوند — قیمت بریده
 * یعنی برچسب غلط. برآورد محافظه‌کارانه: هر رقم/جداکننده ۰٫۶em و «تومان»
 * ۳em از قلم کوچک خودش (۰٫۵۴ قلم قیمت). آزمون مرورگر جاشدن را می‌سنجد.
 */
function priceFontMm(text: string, g: LabelGeometry, width: number): number {
  const base = g.fontMm * 1.4;
  const inner = width - 2 * CODE_PAD_X_MM - 2 * TEXT_PAD_X_MM;
  const em = text.length * 0.6 + 0.35 + 3 * 0.54;
  return Math.min(base, Math.floor((inner / em) * 100) / 100);
}

function labelHtml(item: LabelItem, shopName: string, g: LabelGeometry, width: number): string {
  const variant = [item.color, item.size].filter((v) => v !== null && v !== "");
  const priceText = item.priceRial === null ? "" : priceToman(item.priceRial);
  const price =
    item.priceRial === null
      ? '<span class="noprice">بدون قیمت</span>'
      : `${esc(priceText)} <small>تومان</small>`;
  const pf = priceFontMm(priceText, g, width);

  // بارکد نداشتن، خطا نیست: کالایی که بارکدش هنوز ساخته نشده باید
  // برچسبش چاپ شود ولی جای بارکد خالی بماند، نه اینکه کل برگه بشکند.
  const code = item.barcode
    ? ean13Svg(item.barcode, { moduleMm: g.moduleMm, heightMm: g.barHeightMm })
    : `<div class="nobarcode">${esc(item.sku)}</div>`;

  return `<div class="label">
  ${g.showShop ? `<div class="shop">${esc(shopName)}</div>` : ""}
  <div class="name">${esc(item.productName)}</div>
  <div class="variant">${variant.map((v) => esc(v as string)).join(" · ")}</div>
  <div class="price" style="font-size:${pf.toFixed(2)}mm">${price}</div>
  <div class="code">${code}</div>
</div>`;
}

export function labelPage(items: LabelItem[], opts: LabelPageOptions): string {
  const roll = opts.rollMm ?? { width: 50, height: 30 };
  const isRoll = opts.layout === "roll";
  const size = isRoll ? roll : { width: A4.w, height: A4.h };
  const g = labelGeometry(opts.layout, size.width, size.height);
  if (!g.fits) throw new LabelSizeError(size.width, size.height);

  const repeated: string[] = [];
  for (const item of items) {
    for (let i = 0; i < item.count; i++) {
      repeated.push(labelHtml(item, opts.shopName, g, size.width));
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
    /* حاشیهٔ افقی فقط نیم میلی‌متر: بارکد با حاشیهٔ سکوت تا «عرض − ۱mm» پهن
       است و نباید بریده شود؛ متن‌ها حاشیهٔ خودشان را دارند. */
    padding: ${g.padY[0]}mm ${CODE_PAD_X_MM}mm ${g.padY[1]}mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${ROW_GAP_MM}mm;
    overflow: hidden;
    break-inside: avoid;
    /* خطوط برش فقط روی صفحه دیده می‌شوند، نه روی کاغذ */
    outline: 0.1mm dashed #bbb;
    outline-offset: -0.1mm;
  }
  ${isRoll ? ".label + .label { break-before: page; }" : ""}
  /* هر ردیف ارتفاع ثابت دارد و هرگز فشرده نمی‌شود (labelGeometry). */
  .label > div { flex: none; width: 100%; overflow: hidden; text-align: center; }
  .shop, .name, .variant, .price { padding-inline: ${TEXT_PAD_X_MM}mm; }
  .shop { height: ${g.rows.shop}mm; line-height: ${g.rows.shop}mm; font-size: ${(f * 0.72).toFixed(2)}mm; letter-spacing: .15mm; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
  .name {
    height: ${g.rows.name}mm;
    font-size: ${f.toFixed(2)}mm; font-weight: 700;
    line-height: ${NAME_LINE};
    overflow-wrap: anywhere;
    /* ارتفاع دقیقاً ${g.nameLines} سطر کامل است؛ بیشتر از آن با «…» کوتاه می‌شود،
       نه با بریدن حروف. */
    display: -webkit-box; -webkit-line-clamp: ${g.nameLines}; -webkit-box-orient: vertical;
  }
  .variant { height: ${g.rows.variant}mm; line-height: ${g.rows.variant}mm; font-size: ${(f * 0.85).toFixed(2)}mm; white-space: nowrap; text-overflow: ellipsis; }
  .price { height: ${g.rows.price}mm; line-height: ${g.rows.price}mm; font-size: ${(f * 1.4).toFixed(2)}mm; font-weight: 800; direction: rtl; white-space: nowrap; }
  .price small { font-size: 0.54em; font-weight: 500; }
  .noprice { font-size: ${(f * 0.9).toFixed(2)}mm; font-weight: 600; }
  .code { height: ${g.rows.code}mm; line-height: 0; display: flex; justify-content: center; align-items: flex-end; }
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
