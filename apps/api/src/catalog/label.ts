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

/**
 * برگه A4 با شبکه ۳×۸ برچسبِ ۷۰×۳۷ میلی‌متری.
 *
 * رایج‌ترین برگه برچسب چسب‌دار بازار؛ اگر روزی اندازه دیگری لازم شد،
 * این چهار عدد تنها چیزی است که عوض می‌شود.
 */
const A4 = { cols: 3, rows: 8, w: 70, h: 37, marginTop: 4.5, marginLeft: 0 };

/**
 * متن → HTML امن.
 *
 * پنج نویسه، نه سه‌تا: `"` و `'` هم هستند چون همین تابع ممکن است روزی
 * داخل یک صفت به کار برود، و آن‌وقت نبودشان یعنی فرار از صفت.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** یک برچسب. */
function labelHtml(item: LabelItem, shopName: string): string {
  const variant = [item.color, item.size].filter((v) => v !== null && v !== "");
  const price =
    item.priceRial === null
      ? '<span class="noprice">بدون قیمت</span>'
      : `${esc(toTomanDisplay(item.priceRial))} <small>تومان</small>`;

  // بارکد نداشتن، خطا نیست: کالایی که بارکدش هنوز ساخته نشده باید
  // برچسبش چاپ شود ولی جای بارکد خالی بماند، نه اینکه کل برگه بشکند.
  const code = item.barcode
    ? ean13Svg(item.barcode, { moduleMm: 0.3, heightMm: 12 })
    : `<div class="nobarcode">${esc(item.sku)}</div>`;

  return `<div class="label">
  <div class="shop">${esc(shopName)}</div>
  <div class="name">${esc(item.productName)}</div>
  <div class="variant">${variant.map((v) => esc(v as string)).join(" · ")}</div>
  <div class="price">${price}</div>
  <div class="code">${code}</div>
</div>`;
}

/** برگه کامل — همان چیزی که مستقیم به چاپگر می‌رود. */
export function labelPage(items: LabelItem[], opts: LabelPageOptions): string {
  const roll = opts.rollMm ?? { width: 50, height: 30 };
  const isRoll = opts.layout === "roll";

  const repeated: string[] = [];
  for (const item of items) {
    for (let i = 0; i < item.count; i++) {
      repeated.push(labelHtml(item, opts.shopName));
    }
  }

  const page = isRoll
    ? `@page { size: ${roll.width}mm ${roll.height}mm; margin: 0; }`
    : "@page { size: A4; margin: 0; }";

  const labelBox = isRoll
    ? `width: ${roll.width}mm; height: ${roll.height}mm; page-break-after: always;`
    : `width: ${A4.w}mm; height: ${A4.h}mm;`;

  const sheet = isRoll
    ? "display: block;"
    : `display: grid;
       grid-template-columns: repeat(${A4.cols}, ${A4.w}mm);
       grid-auto-rows: ${A4.h}mm;
       padding-top: ${A4.marginTop}mm;`;

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>برچسب قیمت — ${esc(opts.shopName)}</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Vazirmatn, Tahoma, sans-serif;
    background: #fff;
    color: #000;
  }
  .sheet { ${sheet} }
  .label {
    ${labelBox}
    padding: 1.6mm 2mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    overflow: hidden;
    /* خطوط برش فقط روی صفحه دیده می‌شوند، نه روی کاغذ */
    outline: 0.1mm dashed #ccc;
    outline-offset: -0.1mm;
  }
  .shop { font-size: 2.2mm; letter-spacing: .2mm; color: #444; }
  .name {
    font-size: 3mm; font-weight: 700; text-align: center;
    line-height: 1.25;
    /* نام بلند نباید برچسب را بترکاند */
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .variant { font-size: 2.6mm; color: #333; }
  .price { font-size: 4.4mm; font-weight: 800; direction: rtl; }
  .price small { font-size: 2.4mm; font-weight: 400; }
  .noprice { font-size: 2.8mm; font-weight: 400; color: #b00; }
  .code { line-height: 0; }
  .nobarcode {
    font-family: monospace; font-size: 2.6mm; direction: ltr;
    border: 0.2mm solid #999; padding: 0.6mm 1.2mm;
  }
  @media print {
    .label { outline: none; }
    .hint { display: none; }
  }
  .hint {
    font-size: 3mm; color: #555; padding: 3mm; text-align: center;
    border-bottom: 1px solid #ddd;
  }
</style>
</head>
<body>
<div class="hint">${repeated.length} برچسب — با Ctrl+P چاپ کنید. حاشیه چاپگر را روی «بدون حاشیه» بگذارید.</div>
<div class="sheet">
${repeated.join("\n")}
</div>
</body>
</html>`;
}
