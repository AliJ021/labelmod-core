/**
 * صفحه عمومی فاکتور — چیزی که مشتری با لینک پیامک می‌بیند.
 *
 * ── چرا HTML و نه PDF ───────────────────────────────────────────────
 *
 * پیامک ضمیمه نمی‌گیرد؛ فقط لینک می‌گیرد. پس هر راهی به یک صفحه وب
 * می‌رسید، و آن صفحه را مرورگر خودش «ذخیره به PDF» می‌کند — با
 * فونت فارسی درست، چون فونت مرورگر است نه فونتی که ما در PDF جاسازی
 * کرده باشیم.
 *
 * کتابخانه PDF مسیر دیگر بود و رد شد: شکل‌دهی حروف فارسی (اتصال حروف و
 * راست‌به‌چپ) در کتابخانه‌های PDF جاوااسکریپت یا نیست یا شکسته است، و
 * فاکتوری که حروفش جدا چاپ شود بدتر از نبودنش است. به‌علاوه یک
 * وابستگی تازه با هزینه زنجیره تأمین (بند ۵ SECURITY.md).
 *
 * ── دومین صفحه HTML این پروژه، با همان دو لایه دفاع ─────────────────
 *
 * نام کالا و نام مشتری ریشه‌شان ورودی کاربرند. پس مثل صفحه برچسب:
 *   ۱. هر درج از `esc()` رد می‌شود
 *   ۲. هدر CSP که `script-src` را کامل می‌بندد
 * این صفحه هم اصلاً جاوااسکریپت لازم ندارد.
 *
 * ── چه چیزی عمداً نیست ──────────────────────────────────────────────
 *
 * بهای تمام‌شده، سود، نام صندوق‌دار و شماره دوره ثبت. این صفحه را
 * **مشتری** می‌بیند؛ هر عددی که برای او نیست، نباید اینجا باشد.
 */
import { esc } from "../catalog/label.ts";
import { receiptLogo, type ReceiptLogo } from "./receipt-logo.ts";

/**
 * متن **دقیق** اسکریپت دکمه چاپ.
 *
 * ⚠️ hash در CSP از همین رشته ساخته می‌شود. اگر یک کاراکتر — حتی یک
 * فاصله — عوض شود، مرورگر اسکریپت را رد می‌کند و دکمه **بی‌صدا** کار
 * نمی‌کند. به همین دلیل رشته و hash کنار هم‌اند و یک تست هم‌خوانی‌شان
 * را می‌سنجد.
 */
export const PRINT_SCRIPT =
  "document.getElementById('print-btn').addEventListener('click',function(){window.print()});";

/**
 * CSP این صفحه — همان قفلِ صفحه برچسب، به‌علاوه یک hash.
 *
 * `unsafe-inline` **نمی‌آید**. hash فقط همان یک اسکریپت را اجازه
 * می‌دهد و هر اسکریپت دیگری — از جمله یکی که از راه نام کالا تزریق
 * شود — رد می‌شود.
 *
 * ⚠️ hash روی `onclick` کار نمی‌کند، فقط روی بلوک `<script>`. اگر
 * روزی کسی دکمه را به `onclick` برگرداند، CSP ردش می‌کند و هیچ
 * خطایی هم در کنسول کاربر نیست.
 */
export const INVOICE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  "script-src 'sha256-C6GFxpc4C8wAFuTjDFCf1w9qX86XJLIfCeDnOu9zelE='; base-uri 'none'; form-action 'none'";

export interface InvoicePageLine {
  productName: string;
  color: string | null;
  /**
   * سایز تنوع — **روی عنوان قلم چاپ نمی‌شود** (درخواست مالک، ۱۴۰۵/۰۷/۱۰:
   * عنوان کوتاه‌تر برای مشتری). داده دست‌نخورده است: سایز روی تنوع، SKU،
   * Snapshot فاکتور و برچسب انبار و صندوق می‌ماند؛ فقط این صفحهٔ نمایشی
   * آن را نمی‌نویسد. میدان عمداً در قرارداد مانده تا بازطراحی فاکتور —
   * که تصمیمش با مالک است — بی تغییر مسیرها برش گرداند.
   */
  size: string | null;
  qty: string;
  /** ریال. */
  unitPrice: bigint;
  discountAmount: bigint;
  netAmount: bigint;
}

export interface InvoicePageData {
  number: string;
  occurredAt: Date;
  shopName: string;
  customerName: string | null;
  lines: InvoicePageLine[];
  netAmount: bigint;
  taxAmount: bigint;
  shippingAmount: bigint;
  payableAmount: bigint;
  paidAmount: bigint;
  exchangeAmount?: bigint;
  dueAmount?: bigint;
  /** مهلت مرجوعی از تنظیم زندهٔ `return.window_hours` — متن ثابت چاپ نمی‌شود. */
  returnWindowHours?: number | null;
  /** نشانی سایت فروشگاه از تنظیم `web.site_url`، اگر ثبت شده باشد. */
  website?: string | null;
  /**
   * لوگوی اصیل برند (`receipt-logo.ts`). نیامدن یعنی همان فایل بسته‌بندی‌شده؛
   * `null` یعنی بدون لوگو — آن‌وقت نام شعبه نشان متنی است.
   */
  logo?: ReceiptLogo | null;
}

/** خواندن امن دو تنظیم پابرگ رسید از ستون‌های خام SQL. */
export function receiptFooterFromSettings(raw: { return_hours: string | null; site_url: string | null }): {
  returnWindowHours: number | null; website: string | null;
} {
  const hours = raw.return_hours === null ? NaN : Number(raw.return_hours);
  const site = (raw.site_url ?? "").trim();
  return {
    returnWindowHours: Number.isInteger(hours) && hours > 0 ? hours : null,
    // فقط نشانی http(s) معتبر — متن دلخواه تنظیمات روی رسید نمی‌نشیند.
    website: /^https?:\/\/[^\s<>"']+$/i.test(site) ? site.replace(/^https?:\/\//i, "").replace(/\/$/, "") : null,
  };
}

/** «۴۸ ساعت» یا «۷ روز» — از همان عدد تنظیم، بی‌گرد کردن نادرست. */
function windowText(hours: number): string {
  return hours % 24 === 0 && hours >= 48
    ? `${(hours / 24).toLocaleString("fa-IR")} روز (${hours.toLocaleString("fa-IR")} ساعت)`
    : `${hours.toLocaleString("fa-IR")} ساعت`;
}

/**
 * ریال → رشته تومان با جداکننده هزارگان.
 *
 * ⚠️ تومان **فقط** در لایه نمایش. ذخیره و محاسبه همه‌جا ریال است؛ این
 *    تابع آخرین قدم پیش از چشم مشتری است و هیچ‌کجای دیگری صدا زده
 *    نمی‌شود.
 */
export function toToman(rial: bigint): string {
  const toman = rial / 10n;
  return toman.toLocaleString("fa-IR");
}

/** تاریخ شمسی — مشتری تاریخ میلادی نمی‌خواند. */
export function faDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(at);
}

/**
 * ریال → تومان **دقیق** برای صفحه رسید.
 *
 * `toToman` (بالا) برای متن پیامک است و کسر تومان را کنار می‌گذارد.
 * روی رسید چاپی هیچ ریالی نباید گم شود: ۱۲۳۴۵ ریال «۱٬۲۳۴٫۵» می‌شود، نه
 * «۱٬۲۳۴». حساب فقط روی bigint است؛ عدد شناور ساخته نمی‌شود.
 */
export function toTomanExact(rial: bigint): string {
  const negative = rial < 0n;
  const abs = negative ? -rial : rial;
  const whole = (abs / 10n).toLocaleString("fa-IR");
  const fraction = abs % 10n;
  const text = fraction === 0n ? whole : `${whole}٫${fraction.toLocaleString("fa-IR")}`;
  return negative ? `−${text}` : text;
}

/**
 * رسید — طراحی تک‌رنگ برای چاپگر حرارتی ۸۰ میلی‌متری (MEVA TP-UNW روی
 * رایانهٔ صندوق) که روی گوشی و «ذخیره PDF» هم نسخهٔ نمایشی خودش را دارد.
 *
 * ── ساختار (بازطراحی ۱۴۰۵/۰۷) ───────────────────────────────────────
 *
 * سربرگ برند (لوگوی اصیل یا نشان متنی) ← برچسب سند ← جعبهٔ مشخصات دوستونه
 * (شماره، تاریخ، مشتری، تعداد قلم) ← اقلام شماره‌دار با رنگ تنوع به‌شکل
 * برچسب قاب‌دار ← جمع‌ها با «قابل پرداخت» در قاب درشت ← پرداخت‌شده، تسویه
 * از تعویض و مانده ← وضعیت تسویه ← پابرگ از تنظیمات زنده.
 *
 * ── قواعد چاپ حرارتی ────────────────────────────────────────────────
 *
 * - **فقط سیاه.** خاکستری روی کاغذ حرارتی نقطه‌نقطه و کم‌رنگ درمی‌آید؛
 *   سلسله‌مراتب با وزن و اندازهٔ قلم، قاب و خط‌چین ساخته می‌شود، نه با رنگ.
 *   تنها سطح سیاهِ پر، برچسب کوچک «مانده» است — نه پس‌زمینهٔ سنگین.
 * - **پهنای چاپ‌پذیر ۷۲mm.** کاغذ ۸۰ است ولی هد ~۷۲mm می‌نویسد؛ هر چیزی
 *   پهن‌تر بریده می‌شود. هر قلم دو سطر دارد: نام تمام‌عرض، و «تعداد ×
 *   قیمت واحد ← مبلغ»؛ ستون مبلغ عرض ثابت دارد.
 * - **ارتفاع صفحه تحمیل نمی‌شود.** `@page` فقط حاشیه را صفر می‌کند؛ طول
 *   کاغذ را درایور رول تعیین می‌کند و برش پس از آخرین سطر است.
 * - **نام بلند می‌شکند، عدد نه.** `overflow-wrap:anywhere` روی نام، و
 *   `nowrap` روی مبلغ تا رقم‌ها هرگز دو تکه نشوند.
 *
 * ── اعداد ──────────────────────────────────────────────────────────
 *
 * هیچ عددی این‌جا ساخته نمی‌شود جز «شامل تخفیف اقلام» که جمع دقیق bigint
 * همان `discountAmount`های ذخیره‌شده است و فقط اطلاع می‌دهد (از جمع کم
 * نمی‌شود، چون مبلغ هر قلم از پیش خالص است). مانده همان محاسبهٔ قبلی است.
 *
 * ⚠️ قلاب‌های `.sheet`، `.totals` و `#print-btn` قرارداد چاپ مستقیم
 *    (iframe) هستند و تغییر نام نمی‌دهند.
 */
export function invoicePage(data: InvoicePageData, timeZone: string): string {
  const money = (rial: bigint) => esc(toTomanExact(rial));
  const fa = (n: number) => n.toLocaleString("fa-IR");
  const items = data.lines
    .map((l, i) => {
      // فقط رنگِ ساخت‌یافته کنار نام می‌نشیند؛ سایز عمداً نه (بالا،
      // `InvoicePageLine.size`). نام کالا دست نمی‌خورد: هیچ کلمه‌ای با
      // Regex از آن کنده نمی‌شود، حتی اگر شبیه سایز باشد.
      const name =
        l.color !== null && l.color !== ""
          ? `${esc(l.productName)} <small>${esc(l.color)}</small>`
          : esc(l.productName);
      // تعداد «۲.۰۰۰» زشت است و «۲» درست: صفرهای اعشاری بی‌معنا حذف
      // می‌شوند ولی «۱٫۵ متر» دست‌نخورده می‌ماند.
      const qty = Number(l.qty).toLocaleString("fa-IR");
      const discount =
        l.discountAmount > 0n
          ? `\n      <tr class="disc"><td class="idx"></td><td>تخفیف قلم</td><td class="num">− ${money(l.discountAmount)}</td></tr>`
          : "";
      // شمارهٔ ردیف در خانهٔ خودش، نه rowspan: rowspan ارتفاع اضافه را میان سطرهای
      // قلم پخش می‌کرد و میان نام و مبلغ فاصلهٔ ناخواسته می‌افتاد.
      return `    <tbody class="item">
      <tr><td class="idx">${esc(fa(i + 1))}</td><td class="name" colspan="2">${name}</td></tr>
      <tr class="calc"><td class="idx"></td><td><span class="qty">${esc(qty)}</span> × <span class="unit">${money(l.unitPrice)}</span></td><td class="num">${money(l.netAmount)}</td></tr>${discount}
    </tbody>`;
    })
    .join("\n");

  const extra = [
    data.shippingAmount > 0n
      ? `<tr><th>کرایه ارسال</th><td class="num">${money(data.shippingAmount)}</td></tr>`
      : "",
    data.taxAmount > 0n
      ? `<tr><th>مالیات</th><td class="num">${money(data.taxAmount)}</td></tr>`
      : "",
  ].join("");
  // اطلاع، نه کسر: مبلغ هر قلم از پیش خالص از تخفیف است.
  const lineDiscounts = data.lines.reduce((sum, l) => sum + l.discountAmount, 0n);
  const savingRow = lineDiscounts > 0n
    ? `<tr class="incl"><th>شامل تخفیف اقلام</th><td class="num">${money(lineDiscounts)}</td></tr>` : "";

  // بدهی باقیمانده فقط وقتی واقعاً هست. «۰ تومان مانده» یک سطر اضافه
  // است که هیچ‌کس لازمش ندارد. محاسبه همان قبلی است؛ فقط نمایش عوض شد.
  const due = data.dueAmount ?? (data.payableAmount - data.paidAmount - (data.exchangeAmount ?? 0n));
  const paidRow = data.paidAmount > 0n
    ? `<tr class="paid"><th>پرداخت‌شده</th><td class="num">${money(data.paidAmount)}</td></tr>` : "";
  const exchangeRow = (data.exchangeAmount ?? 0n) > 0n
    ? `<tr><th>تسویه از تعویض</th><td class="num">${money(data.exchangeAmount!)}</td></tr>` : "";
  const dueRow =
    due > 0n
      ? `<tr class="due"><th><span class="due-tag">مانده</span></th><td class="num">${money(due)} <small>تومان</small></td></tr>`
      : "";
  const settle = due > 0n
    ? `<div class="settle settle--open">تسویه نشده — مانده بدهی ثبت شده است</div>`
    : `<div class="settle">تسویه‌شده</div>`;
  const count = fa(data.lines.length);
  const logo = data.logo === undefined ? receiptLogo() : data.logo;
  // سربرگ کم‌ارتفاع: لوگو کامل دیده می‌شود (contain) و از ۱۴mm بلندتر نمی‌شود.
  const brand = logo
    ? `<img class="logo logo--${logo.treatment}" src="${logo.dataUri}" width="${logo.width}" height="${logo.height}" alt="${esc(data.shopName)}">
    <div class="shop">${esc(data.shopName)}</div>`
    : `<div class="brand">${esc(data.shopName)}</div>`;

  return `<!doctype html>
<html lang="fa" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>فاکتور ${esc(data.number)} — ${esc(data.shopName)}</title>
<style>
  /* ── صفحه: کاغذ رسید روی میز، با یک رنگ برند (برنج) فقط برای نمایش. ── */
  :root {
    color-scheme: light;
    --ink: #000; --paper: #fff; --ink-2: #3D3A35; --line: #1A1917;
    --desk: #EDEAE4; --desk-2: #E2DDD3; --brass: #8A6214;
  }
  * { box-sizing: border-box; }
  /* زمینهٔ میز روی html تا در صفحهٔ بلند (۳۰+ قلم) هم تا پایین برسد. */
  html { min-height: 100%; background: linear-gradient(180deg, #F6F4F0 0%, var(--desk) 40%, var(--desk-2) 100%); }
  body {
    margin: 0; padding: 28px 14px 32px;
    font-family: Vazirmatn, Vazir, Tahoma, "Segoe UI", sans-serif;
    background: transparent;
    color: var(--ink); font-size: 13px; line-height: 1.6;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* کاغذ با پهنای واقعی‌اش (۷۲mm چاپ‌پذیر ≈ ۴۰۰px در نمایش راحت)، نه کارت پهن. */
  .sheet {
    position: relative; width: 100%; max-width: 400px; margin: 0 auto; padding: 26px 22px 30px;
    background: var(--paper); color: var(--ink); border-radius: 14px 14px 0 0;
    box-shadow: 0 1px 2px rgba(25,20,10,.06), 0 14px 40px -12px rgba(25,20,10,.28);
  }
  /* لبهٔ بریده‌شدهٔ رول — فقط روی صفحه. */
  .sheet::after {
    content: ""; position: absolute; inset-inline: 0; bottom: -9px; height: 10px;
    background: linear-gradient(-45deg, transparent 6px, var(--paper) 0) 0 0 / 12px 10px repeat-x,
                linear-gradient(45deg, transparent 6px, var(--paper) 0) 0 0 / 12px 10px repeat-x;
  }
  .head { text-align: center; }
  /* نشان متنی وقتی فایل لوگو نیست — لوگوی ساختگی نمی‌سازیم. */
  .brand { font-size: 24px; font-weight: 900; letter-spacing: -.2px; line-height: 1.25; overflow-wrap: anywhere; }
  .logo { display: block; margin: 0 auto; width: auto; height: auto; max-width: 70%; max-height: 56px; object-fit: contain; }
  /* کاغذ حرارتی فقط سیاه دارد؛ نوع درمان از پیکسل‌های خودِ فایل آمده است. */
  .logo--black { filter: brightness(0); }
  .logo--gray { filter: grayscale(1) contrast(1.2); }
  .shop { margin-top: 6px; font-size: 12.5px; font-weight: 700; overflow-wrap: anywhere; }
  .doc { display: flex; align-items: center; gap: 10px; margin: 12px 0 0; font-size: 10.5px; font-weight: 800; letter-spacing: 3px; }
  .doc::before, .doc::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
  .doc span { padding: 2px 10px; border: 1.5px solid var(--line); border-radius: 999px; letter-spacing: 1.5px; }

  /* مشخصات سند: دو ستون، برچسب ریز بالای مقدار. */
  .meta { display: grid; grid-template-columns: 1fr 1fr; margin: 14px 0 0; border: 1.5px solid var(--line); border-radius: 10px; }
  .cell { min-width: 0; padding: 7px 10px 6px; }
  .cell:nth-child(odd) { border-inline-end: 1px solid var(--line); }
  .cell:nth-child(n+3) { border-top: 1px solid var(--line); }
  .meta dt { font-size: 10px; font-weight: 700; color: var(--ink-2); letter-spacing: .3px; }
  .meta dd { margin: 1px 0 0; font-size: 12.5px; font-weight: 800; overflow-wrap: anywhere; }
  .docno { font-variant-numeric: tabular-nums; letter-spacing: .3px; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: right; padding: 0; vertical-align: top; }
  .items { margin-top: 14px; }
  .items col.idx { width: 22px; }
  .items col.amount { width: 36%; }
  .items thead th { font-size: 10.5px; font-weight: 800; letter-spacing: .3px; padding: 0 0 5px; border-bottom: 2px solid var(--line); }
  .idx { font-size: 10.5px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .item td { padding-top: 2px; }
  .item tr:first-child td { padding-top: 9px; }
  .item + .item tr:first-child td { border-top: 1px dashed var(--line); }
  .item:last-of-type tr:last-child td { padding-bottom: 8px; }
  .name { font-weight: 800; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; word-break: normal; }
  /* رنگ تنوع: برچسب قاب‌دار، نه متن کم‌رنگ — روی کاغذ حرارتی هم خوانا. */
  .name small {
    display: inline-block; margin-inline-start: 4px; padding: 0 6px; vertical-align: 1px;
    font-size: 10.5px; font-weight: 700; line-height: 1.6; border: 1px solid var(--line); border-radius: 999px;
  }
  .calc td { font-size: 12px; color: var(--ink-2); }
  .calc .qty, .calc .unit { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .calc .qty { font-weight: 800; color: var(--ink); }
  .num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .calc .num { font-weight: 800; font-size: 13.5px; color: var(--ink); }
  .disc td { font-size: 11.5px; font-weight: 700; }

  .totals { margin-top: 2px; border-top: 2px solid var(--line); }
  .totals th { font-weight: 600; padding: 5px 0 2px; }
  .totals td { padding: 5px 0 2px; }
  .totals .incl th, .totals .incl td { font-size: 11.5px; color: var(--ink-2); padding-top: 1px; }
  .totals .grand th, .totals .grand td {
    font-size: 17px; font-weight: 900; padding: 9px 10px 8px;
    border-top: 2px solid var(--line); border-bottom: 2px solid var(--line);
  }
  .totals .grand th { border-inline-start: 2px solid var(--line); border-start-start-radius: 8px; }
  .totals .grand td { border-inline-end: 2px solid var(--line); color: var(--brass); }
  .totals .grand small, .totals .due small { font-size: 11px; font-weight: 700; color: var(--ink); }
  .totals .paid th, .totals .paid td { padding-top: 9px; }
  .totals .due th, .totals .due td { font-weight: 900; font-size: 14.5px; padding-top: 7px; }
  .due-tag { display: inline-block; padding: 1px 10px; border-radius: 999px; background: var(--ink); color: var(--paper); font-size: 12px; }
  .settle { margin-top: 10px; padding: 5px 8px; text-align: center; font-size: 11.5px; font-weight: 800; border: 1.5px dashed var(--line); border-radius: 8px; }
  .settle--open { border-style: solid; border-width: 2px; }

  .foot { margin-top: 16px; padding-top: 12px; border-top: 1.5px dashed var(--line); text-align: center; font-size: 11.5px; line-height: 1.8; }
  .foot strong { display: block; font-size: 14px; font-weight: 900; }
  .foot .policy { font-weight: 700; }
  .foot .site { font-weight: 700; letter-spacing: .4px; }
  .foot .unit { color: var(--ink-2); font-size: 10.5px; }

  /* ── آماده چاپ ────────────────────────────────────────────────────
     دکمه و راهنما روی صفحه است و روی کاغذ نمی‌آید. */
  .print-bar { margin: 26px auto 0; max-width: 400px; text-align: center; }
  .print-btn {
    font: inherit; font-weight: 800; padding: 10px 26px; cursor: pointer;
    /* هدف لمسی دست‌کم ۴۴px — مشتری این صفحه را روی گوشی باز می‌کند. */
    min-height: 44px; border-radius: 12px;
    border: 1.5px solid #000; background: #000; color: #FFFFFF;
  }
  .print-btn:hover { background: #2A2723; }
  .print-btn:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
  .print-note { margin: 8px auto 0; max-width: 320px; font-size: 11.5px; color: var(--ink-2); }

  @page { margin: 0; }
  @media print {
    .print-bar { display: none !important; }
    html, body { background: #FFFFFF; padding: 0; margin: 0; }
    /* ۸۰mm کاغذ، ۷۲mm چاپ‌پذیر؛ ۴mm حاشیهٔ هر طرف را خودِ برگه نگه می‌دارد. */
    .sheet {
      width: 72mm; max-width: 72mm; margin: 0 auto; padding: 3mm 0 5mm;
      border-radius: 0; box-shadow: none; font-size: 9pt;
    }
    .sheet::after { display: none; }
    .sheet, .meta dt, .calc td, .totals .incl th, .totals .incl td, .totals .grand td, .foot .unit { color: #000; }
    .brand { font-size: 16pt; }
    .logo { max-height: 14mm; max-width: 52mm; }
    .shop { font-size: 9pt; margin-top: 1mm; }
    .doc { font-size: 7.5pt; margin-top: 2.5mm; }
    .meta { margin-top: 3mm; border-radius: 1.5mm; }
    .cell { padding: 1.2mm 2mm 1mm; }
    .meta dt { font-size: 6.5pt; }
    .meta dd { font-size: 8.5pt; }
    .items { margin-top: 3mm; }
    .items col.idx { width: 4.5mm; }
    .items thead th, .idx { font-size: 7.5pt; }
    .name { font-size: 9pt; }
    .name small { font-size: 7pt; }
    .calc td, .disc td, .totals .incl th, .totals .incl td { font-size: 8pt; }
    .calc .num { font-size: 9pt; }
    .totals .grand th, .totals .grand td { font-size: 12pt; padding: 1.8mm 1.6mm 1.5mm; }
    .totals .due th, .totals .due td { font-size: 10pt; }
    .due-tag { font-size: 8pt; }
    .settle, .foot { font-size: 8pt; }
    .foot strong { font-size: 10pt; }
    .foot .unit { font-size: 7pt; }
    /* یک قلم نباید وسطش بشکند (برای چاپگر صفحه‌ای و PDF). */
    .item, tr, .meta, .settle { break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style>
<div class="sheet">
  <header class="head">
    ${brand}
    <div class="doc"><span>رسید فروش</span></div>
  </header>
  <dl class="meta">
    <div class="cell"><dt>شمارهٔ فاکتور</dt><dd><bdi dir="ltr" class="docno">${esc(data.number)}</bdi></dd></div>
    <div class="cell"><dt>تاریخ و ساعت</dt><dd>${esc(faDate(data.occurredAt, timeZone))}</dd></div>
    <div class="cell"><dt>مشتری</dt><dd>${data.customerName ? `<bdi>${esc(data.customerName)}</bdi>` : "مشتری عمومی"}</dd></div>
    <div class="cell"><dt>اقلام</dt><dd>${esc(count)} قلم</dd></div>
  </dl>

  <table class="items">
    <colgroup><col class="idx"><col><col class="amount"></colgroup>
    <thead>
      <tr><th class="idx">#</th><th>کالا · تعداد × قیمت واحد</th><th class="num">مبلغ</th></tr>
    </thead>
${items}
  </table>

  <table class="totals">
    <tr><th>جمع کالاها</th><td class="num">${money(data.netAmount)}</td></tr>
    ${savingRow}
    ${extra}
    <tr class="grand"><th>قابل پرداخت</th><td class="num">${money(data.payableAmount)} <small>تومان</small></td></tr>
    ${paidRow}
    ${exchangeRow}
    ${dueRow}
  </table>
  ${settle}

  <footer class="foot">
    <strong>سپاس از خرید شما</strong>
    ${data.returnWindowHours ? `<div class="policy">مهلت مرجوعی: ${esc(windowText(data.returnWindowHours))} پس از خرید</div>` : ""}
    ${data.website ? `<div class="site"><bdi dir="ltr">${esc(data.website)}</bdi></div>` : ""}
    <div class="unit">همه مبالغ به تومان است.</div>
  </footer>
</div>

<!--
  دکمه چاپ — راه رسیدن به PDF.

  CLAUDE.md می‌گوید «PDF ساخته نمی‌شود؛ لینک می‌رود» چون شکل‌دهی حروف
  فارسی در کتابخانه‌های PDF جاوااسکریپت یا نیست یا شکسته است. این
  دکمه آن تصمیم را کامل می‌کند نه نقض: موتور شکل‌دهی فارسیِ خودِ
  مرورگر کار را می‌کند و «چاپ در فایل» یک PDF درست می‌دهد.

  اسکریپت با hash در CSP اجازه گرفته، نه با unsafe-inline.
-->
<div class="print-bar">
  <button type="button" class="print-btn" id="print-btn">چاپ یا ذخیره PDF</button>
  <p class="print-note">پنجرهٔ چاپ مرورگر باز می‌شود؛ چاپگر رسید یا «ذخیره به PDF» را انتخاب کنید. مرورگر بی تأیید شما چاپ نمی‌کند.</p>
</div>
<script>${PRINT_SCRIPT}</script>
</html>`;
}
