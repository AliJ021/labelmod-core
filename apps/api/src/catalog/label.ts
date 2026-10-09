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
import { ean13CheckDigit } from "./barcode.ts";
import { code128Svg, code128TotalModules, isCode128Encodable } from "./code128.ts";

/** هدر امنیتی صفحه برچسب. بدون جاوااسکریپت، بدون منبع بیرونی. */
export const LABEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export interface LabelItem {
  barcode: string | null;
  sku: string;
  productName: string;
  /** نام برند کالا، اگر ثبت شده باشد — در سطر دوم شرح می‌آید. */
  brand?: string | null;
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

/**
 * کدام نماد؟ — EAN-13 معتبر (۱۳ رقم با رقم کنترل درست، از جمله بارکد داخلی
 * پیشوند ۲۰) همان EAN-13 می‌ماند؛ هر رشتهٔ چاپی دیگر (کد قدیمی ۱۷ رقمی دشت)
 * عیناً Code128 می‌شود. رشته هرگز به عدد تبدیل یا بازنویسی نمی‌شود.
 */
export function barcodeSymbology(value: string): "ean13" | "code128" | "none" {
  if (/^\d{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === value[12]) return "ean13";
  return isCode128Encodable(value) ? "code128" : "none";
}

/** پهنای کامل بارکد به ماژول، با حاشیهٔ سکوت — ورودی `labelGeometry`. */
export function barcodeTotalModules(value: string): number {
  const kind = barcodeSymbology(value);
  return kind === "ean13" ? EAN13_TOTAL_MODULES : kind === "code128" ? code128TotalModules(value) : 0;
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
export const EAN13_TOTAL_MODULES = 113;
/** کمترین ماژول قابل اتکا روی رول حرارتی ۲۰۳dpi (دو نقطه). */
export const MIN_ROLL_MODULE_MM = 0.25;

/**
 * آیا بارکدی با این تعداد ماژول (**با** حاشیهٔ سکوت هر دو طرف) در عرض این
 * برچسب با ماژول دست‌کم ۰٫۲۵mm جا می‌شود؟ (EAN-13 = ۱۱۳، کد ۱۷ رقمی
 * Code128 = ۱۶۵ — `barcodeTotalModules`.)
 */
export function barcodeFitsWidth(totalModules: number, widthMm: number): boolean {
  return MIN_ROLL_MODULE_MM * totalModules <= widthMm - 2 * CODE_PAD_X_MM + 1e-9;
}

/** کمترین عرض رول برای بارکدی با این تعداد ماژول — برای پیام کاربر. */
export function minRollWidthFor(totalModules: number): number {
  return Math.max(ROLL_MIN_WIDTH_MM, Math.ceil(MIN_ROLL_MODULE_MM * totalModules + 2 * CODE_PAD_X_MM));
}

/** کمترین ارتفاع رول که نام فروشگاه، بارکد خوانا، یک سطر شرح و قیمت را با هم جا می‌دهد. */
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
/** ضریب ارتفاع سطر شرح — حروف فارسی با نقطه و سرکش در ۱٫۳ کامل جا می‌شوند. */
const DESC_LINE = 1.3;

export interface LabelGeometry {
  /** پهنای یک ماژول بارکد به میلی‌متر. */
  moduleMm: number;
  /** ارتفاع میله‌ها به میلی‌متر (بدون ردیف رقم‌ها). */
  barHeightMm: number;
  /** اندازهٔ پایهٔ قلم به میلی‌متر (قلم شرح). */
  fontMm: number;
  /** نام فروشگاه بالای برچسب — فقط وقتی جا هست. */
  showShop: boolean;
  /** ماژول زیر ۰٫۲۵mm را بسیاری از اسکنرها نمی‌خوانند. */
  scanRisk: boolean;
  /**
   * سطرهای شرح کالا: ۲ = نام، سپس «برند · رنگ · سایز»؛ ۱ = همه در یک سطر.
   * ارتفاع ردیف شرح دقیقاً همین تعداد سطر کامل است.
   */
  nameLines: number;
  /** ارتفاع ثابت هر ردیف به میلی‌متر — هیچ ردیفی Flex-shrink نمی‌شود. */
  rows: { shop: number; code: number; desc: number; price: number };
  /** حاشیهٔ بالا/پایین برچسب به میلی‌متر. */
  padY: [number, number];
  /** آیا همهٔ ردیف‌ها با کمترین اندازهٔ خوانا جا می‌شوند؟ */
  fits: boolean;
}

/**
 * هندسهٔ برچسب — ترتیب مرجع مالک: نام فروشگاه، بارکد پهن، رقم‌های بارکد
 * درست زیر میله‌ها، دو سطر شرح (نام؛ برند · رنگ · سایز)، قیمت درشت پایین.
 *
 * **بودجهٔ ارتفاع به میلی‌متر:** هر ردیف ارتفاع ثابت دارد و جمعشان هرگز از
 * ارتفاع برچسب بیشتر نیست. اگر جا نباشد، اول شرح یک‌سطری می‌شود، بعد نام
 * فروشگاه می‌رود و بعد قلم کوچک می‌شود؛ میله‌ها هرگز از ۵mm کوتاه‌تر
 * نمی‌شوند. اگر باز هم جا نشود `fits = false` است و برچسب ساخته نمی‌شود.
 *
 * ⚠️ **مقدار بارکد هرگز عوض نمی‌شود؛ فقط مقیاسش.** روی رول حرارتی
 *    ماژول به مضرب نقطهٔ چاپگر ۲۰۳dpi (۰٫۱۲۵mm) گرد می‌شود — ۰٫۳۷۵ یا
 *    ۰٫۲۵ — چون پهنای غیرصحیح نقطه، میله‌ها را نامساوی و اسکن را ناپایدار
 *    می‌کند. روی برگهٔ A4 (چاپگر لیزری) ۰٫۳ می‌ماند. پهنای بارکد با حاشیهٔ
 *    سکوت هرگز از پهنای داخلی (عرض − ۱mm) بیشتر نیست.
 */
export function labelGeometry(
  layout: LabelLayout,
  width: number,
  height: number,
  /** پهن‌ترین بارکد برگه، با حاشیهٔ سکوت (EAN-13 = ۱۱۳). */
  totalModules: number = EAN13_TOTAL_MODULES,
): LabelGeometry {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const isA4 = layout === "a4";
  const usable = width - 2 * CODE_PAD_X_MM;
  // ماژول هرگز زیر ۰٫۲۵mm نمی‌رود؛ اگر بارکد در آن هم جا نشود، برچسب رد می‌شود.
  const moduleMm = isA4 ? 0.3 : [0.375, 0.25].find((m) => m * totalModules <= usable) ?? MIN_ROLL_MODULE_MM;
  const barcodeFits = isA4 ? 0.3 * totalModules <= usable : barcodeFitsWidth(totalModules, width);
  const padY: [number, number] = isA4 ? [1.6, 1.6] : [1, 0.8];
  const barCap = isA4 ? 12 : round1(clamp(height * 0.34, MIN_BAR_MM, 14));
  // بارکد کوتاه‌تر از ۶۰٪ سقفش ارزش سطر دوم شرح یا نام فروشگاه را ندارد.
  const barTarget = Math.max(MIN_BAR_MM, barCap * 0.6);
  const fontMm = isA4 ? 2.8 : round1(clamp(Math.min(height / 10, width / 16), 2, 3.2));

  const rowsFor = (f: number, shop: boolean, lines: number) => ({
    shop: shop ? r2(f * 1.05 * 1.25) : 0,
    desc: r2(lines * f * DESC_LINE),
    price: r2(f * 1.75 * 1.12),
  });
  // ترتیب ترجیح (مرجع مالک): فروشگاه + دو سطر شرح؛ برای نگه‌داشتن آن‌ها
  // اول قلم کوچک می‌شود، بعد شرح یک‌سطری، بعد نام فروشگاه می‌رود.
  const configs: Array<[boolean, number]> = [[true, 2], [true, 1], [false, 1]];
  const fStart = fontMm;
  const attempt = (shop: boolean, lines: number, f: number, minBar: number): LabelGeometry | null => {
    const r = rowsFor(f, shop, lines);
    const visible = shop ? 4 : 3;
    const fixed = padY[0] + padY[1] + ROW_GAP_MM * (visible - 1) + r.shop + r.desc + r.price + BARCODE_TEXT_MM;
    const bar = Math.floor(Math.min(barCap, height - fixed) * 10) / 10;
    if (bar < minBar) return null;
    return { moduleMm, barHeightMm: bar, fontMm: f, showShop: shop, scanRisk: moduleMm < 0.25, nameLines: lines,
      rows: { ...r, code: round1(bar + BARCODE_TEXT_MM) }, padY, fits: true };
  };
  const fits = barcodeFits && (isA4 || (width >= ROLL_MIN_WIDTH_MM && height >= ROLL_MIN_HEIGHT_MM));
  if (fits) {
    for (const [shop, lines] of configs) {
      for (let f = fStart; f >= 2.2 - 1e-9; f = round1(f - 0.1)) {
        const g = attempt(shop, lines, f, barTarget);
        if (g) return g;
      }
    }
    // آخرین چاره: کوچک‌ترین چیدمان با کوتاه‌ترین میلهٔ قابل اتکا.
    for (let f = fStart; f >= 2 - 1e-9; f = round1(f - 0.1)) {
      const g = attempt(false, 1, f, MIN_BAR_MM);
      if (g) return g;
    }
  }
  const r = rowsFor(2, false, 1);
  return { moduleMm, barHeightMm: MIN_BAR_MM, fontMm: 2, showShop: false, scanRisk: moduleMm < 0.25, nameLines: 1,
    rows: { ...r, code: MIN_BAR_MM + BARCODE_TEXT_MM }, padY, fits: false };
}

/** برچسبی که کمترین چیدمان خوانا هم در آن جا نمی‌شود. */
export class LabelSizeError extends Error {
  readonly statusCode = 422;
  readonly code = "label_too_small";
  constructor(width: number, height: number, totalModules: number = EAN13_TOTAL_MODULES) {
    super(`لیبل ${width}×${height} میلی‌متر برای نام، قیمت و بارکد خوانا کوچک است؛ دست‌کم ${minRollWidthFor(totalModules)}×${ROLL_MIN_HEIGHT_MM} میلی‌متر لازم است.`);
    this.name = "LabelSizeError";
  }
}

/** قیمت به تومان با رقم فارسی، بی‌آنکه ریالِ کسری گم شود. */
function priceToman(rial: bigint): string {
  const abs = rial < 0n ? -rial : rial;
  const whole = (abs / 10n).toLocaleString("en-US");
  const fraction = abs % 10n;
  const text = fraction === 0n ? whole : `${whole}.${fraction}`;
  return rial < 0n ? `−${text}` : text;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display-only normalization; SKU/barcode identity and encoded bars stay untouched. */
function labelText(value: string): string {
  return esc(value.replace(/[۰-۹٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660))));
}

/**
 * اندازهٔ قلم قیمت تا تمام رقم‌ها در پهنای داخلی جا شوند — قیمت بریده
 * یعنی برچسب غلط. برآورد محافظه‌کارانه: هر رقم/جداکننده ۰٫۶em و «تومان»
 * ۳em از قلم کوچک خودش (۰٫۵em). آزمون مرورگر جاشدن را می‌سنجد.
 */
function priceFontMm(text: string, g: LabelGeometry, width: number): number {
  const base = g.fontMm * 1.75;
  const inner = width - 2 * CODE_PAD_X_MM - 2 * TEXT_PAD_X_MM;
  const em = text.length * 0.6 + 0.35 + 3 * 0.5;
  return Math.min(base, Math.floor((inner / em) * 100) / 100);
}

function labelHtml(item: LabelItem, shopName: string, g: LabelGeometry, width: number): string {
  const details = [item.brand ?? null, item.color, item.size].filter((v): v is string => v !== null && v !== "");
  const priceText = item.priceRial === null ? "" : priceToman(item.priceRial);
  const price =
    item.priceRial === null
      ? '<span class="noprice">بدون قیمت</span>'
      : `<bdi class="digits" dir="ltr">${esc(priceText)}</bdi> <small>تومان</small>`;
  const pf = priceFontMm(priceText, g, width);

  // بارکد نداشتن، خطا نیست: کالایی که بارکدش هنوز ساخته نشده باید
  // برچسبش چاپ شود ولی جای بارکد خالی بماند، نه اینکه کل برگه بشکند.
  const kind = item.barcode ? barcodeSymbology(item.barcode) : "none";
  const svgOpts = { moduleMm: g.moduleMm, heightMm: g.barHeightMm };
  const code = kind === "ean13" ? ean13Svg(item.barcode as string, svgOpts)
    : kind === "code128" ? code128Svg(item.barcode as string, svgOpts)
    : `<div class="nobarcode">${labelText(item.sku)}</div>`;

  // شرح: دو سطر جدا (نام، سپس برند · رنگ · سایز) یا یک سطر پیوسته. هر سطر
  // nowrap با «…» است، پس هیچ‌وقت نیم‌سطری دیده نمی‌شود.
  const desc = g.nameLines === 2
    ? `<span class="l">${labelText(item.productName)}</span><span class="l">${details.map(labelText).join(" · ")}</span>`
    : `<span class="l">${[item.productName, ...details].map(labelText).join(" · ")}</span>`;

  return `<div class="label">
  ${g.showShop ? `<div class="shop">${labelText(shopName)}</div>` : ""}
  <div class="code">${code}</div>
  <div class="desc">${desc}</div>
  <div class="price" style="font-size:${pf.toFixed(2)}mm">${price}</div>
</div>`;
}

/** Preview and printed labels both use Latin digits, as requested by the owner. */
const printNum = (n: number) => n.toLocaleString("en-US");

export function labelPage(items: LabelItem[], opts: LabelPageOptions): string {
  const roll = opts.rollMm ?? { width: 50, height: 30 };
  const isRoll = opts.layout === "roll";
  const size = isRoll ? roll : { width: A4.w, height: A4.h };
  // هندسه از پهن‌ترین بارکد برگه ساخته می‌شود؛ بارکد ۱۷ رقمی (۱۶۵ ماژول)
  // در ۳۰mm جا نمی‌شود و آن برگه با پیام کمترین عرض رد می‌شود.
  const widths = items.filter((i) => i.barcode !== null).map((i) => barcodeTotalModules(i.barcode as string));
  const modules = Math.max(EAN13_TOTAL_MODULES, ...widths);
  const g = labelGeometry(opts.layout, size.width, size.height, modules);
  if (!g.fits) throw new LabelSizeError(size.width, size.height, modules);

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
<title>برچسب قیمت — ${labelText(opts.shopName)}</title>
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
    /* حاشیهٔ افقی فقط نیم میلی‌متر: بارکد با حاشیهٔ سکوت تا پهنای داخلی
       پهن است و نباید بریده شود؛ ردیف‌های متنی حاشیهٔ خودشان را دارند. */
    padding: ${g.padY[0]}mm ${CODE_PAD_X_MM}mm ${g.padY[1]}mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${ROW_GAP_MM}mm;
    background: #fff;
    break-inside: avoid;
  }
  ${isRoll ? ".label + .label { break-before: page; }" : ""}
  /* هر ردیف ارتفاع ثابت دارد و هرگز فشرده نمی‌شود (labelGeometry). */
  .label > div { flex: none; width: 100%; overflow: hidden; text-align: center; }
  .shop, .desc, .price { padding-inline: ${TEXT_PAD_X_MM}mm; }
  .shop { height: ${g.rows.shop}mm; line-height: ${g.rows.shop}mm; font-size: ${(f * 1.05).toFixed(2)}mm; font-weight: 800; white-space: nowrap; text-overflow: ellipsis; }
  .code { height: ${g.rows.code}mm; line-height: 0; display: flex; justify-content: center; align-items: flex-start; }
  .desc { height: ${g.rows.desc}mm; font-size: ${f.toFixed(2)}mm; font-weight: 700; line-height: ${DESC_LINE}; }
  .desc .l { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .price { height: ${g.rows.price}mm; line-height: ${g.rows.price}mm; font-weight: 800; direction: rtl; white-space: nowrap; }
  .price small { font-size: 0.5em; font-weight: 600; }
  .digits { font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; }
  .noprice { font-size: ${(f * 0.95).toFixed(2)}mm; font-weight: 700; }
  .code svg { display: block; }
  .nobarcode {
    font-family: monospace; font-size: ${(f * 0.85).toFixed(2)}mm; direction: ltr;
    border: 0.2mm solid #000; padding: 0.4mm 1mm; margin-top: 1mm;
  }
  /* روی صفحه: مستطیل سفید با گوشهٔ گرد مثل لیبل دای‌کات؛ روی کاغذ هیچ
     خط و سایه‌ای چاپ نمی‌شود (خودِ لیبل گوشهٔ گرد دارد). */
  @media screen {
    body { background: #ECECEC; }
    .sheet { padding: 3mm; display: ${isRoll ? "flex; flex-direction: column; align-items: center; gap: 3mm" : "grid"}; ${isRoll ? "width: auto;" : ""} }
    .label { border-radius: 2mm; box-shadow: 0 0 0 0.2mm #C8C8C8, 0 0.6mm 2mm rgba(0,0,0,.08); }
  }
  @media print {
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
<div class="hint">${printNum(repeated.length)} برچسب ${isRoll ? `${printNum(roll.width)}×${printNum(roll.height)} میلی‌متر` : "روی برگهٔ A4"} — مقیاس چاپ 100٪ و بدون حاشیه.${warn}</div>
<div class="sheet">
${repeated.join("\n")}
</div>
</body>
</html>`;
}
