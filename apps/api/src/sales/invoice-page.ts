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
 * رایانهٔ صندوق) که روی گوشی و «ذخیره PDF» هم درست دیده می‌شود.
 *
 * ── قواعد چاپ حرارتی ────────────────────────────────────────────────
 *
 * - **فقط سیاه.** خاکستری روی کاغذ حرارتی نقطه‌نقطه و کم‌رنگ درمی‌آید؛
 *   سلسله‌مراتب با وزن و اندازهٔ قلم و خط‌چین ساخته می‌شود، نه با رنگ.
 * - **پهنای چاپ‌پذیر ۷۲mm.** کاغذ ۸۰ است ولی هد ~۷۲mm می‌نویسد؛ هر چیزی
 *   پهن‌تر بریده می‌شود. جدول چهارستونهٔ قبلی روی این پهنا قیمت را می‌برید.
 *   حالا هر قلم دو سطر دارد: نام تمام‌عرض، و «تعداد × قیمت واحد ← مبلغ».
 * - **ارتفاع صفحه تحمیل نمی‌شود.** `@page` فقط حاشیه را صفر می‌کند؛ طول
 *   کاغذ را درایور رول تعیین می‌کند و برش پس از آخرین سطر است. ارتفاع
 *   ثابت (مثل ۲۹۷mm) یعنی برای رسید سه‌قلمی ده سانت کاغذ سفید.
 * - **نام بلند می‌شکند، عدد نه.** `overflow-wrap:anywhere` روی نام، و
 *   `nowrap` روی مبلغ تا رقم‌ها هرگز دو تکه نشوند.
 *
 * ⚠️ قلاب‌های `.sheet`، `.totals` و `#print-btn` قرارداد چاپ مستقیم
 *    (iframe) هستند و تغییر نام نمی‌دهند.
 */
export function invoicePage(data: InvoicePageData, timeZone: string): string {
  const money = (rial: bigint) => esc(toTomanExact(rial));
  const items = data.lines
    .map((l) => {
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
          ? `\n      <tr class="disc"><td>تخفیف قلم</td><td class="num">− ${money(l.discountAmount)}</td></tr>`
          : "";
      return `    <tbody class="item">
      <tr><td class="name" colspan="2">${name}</td></tr>
      <tr class="calc"><td><span class="qty">${esc(qty)}</span> × <span class="unit">${money(l.unitPrice)}</span></td><td class="num">${money(l.netAmount)}</td></tr>${discount}
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

  // بدهی باقیمانده فقط وقتی واقعاً هست. «۰ تومان مانده» یک سطر اضافه
  // است که هیچ‌کس لازمش ندارد. محاسبه همان قبلی است؛ فقط نمایش عوض شد.
  const due = data.dueAmount ?? (data.payableAmount - data.paidAmount - (data.exchangeAmount ?? 0n));
  const exchangeRow = (data.exchangeAmount ?? 0n) > 0n
    ? `<tr><th>تسویه از تعویض</th><td class="num">${money(data.exchangeAmount!)}</td></tr>` : "";
  const dueRow =
    due > 0n
      ? `<tr class="due"><th>مانده</th><td class="num">${money(due)}</td></tr>`
      : "";
  const count = data.lines.length.toLocaleString("fa-IR");

  return `<!doctype html>
<html lang="fa" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>فاکتور ${esc(data.number)} — ${esc(data.shopName)}</title>
<style>
  :root { color-scheme: light; --ink: #000; --paper: #fff; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 12px;
    font-family: Vazirmatn, Tahoma, "Segoe UI", sans-serif;
    background: #E9E9E9; color: var(--ink);
    font-size: 13px; line-height: 1.55;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* روی صفحه: کاغذ رسید با پهنای واقعی‌اش (۷۲mm قابل چاپ ≈ ۳۸۰px در
     نمایش راحت)، نه یک کارت پهن که در چاپ شکل دیگری دارد. */
  .sheet {
    width: 100%; max-width: 380px; margin: 0 auto; padding: 18px 16px 14px;
    background: var(--paper); color: var(--ink);
    box-shadow: 0 1px 0 rgba(0,0,0,.08), 0 6px 22px rgba(0,0,0,.10);
  }
  .head { text-align: center; padding-bottom: 8px; }
  .brand { font-size: 19px; font-weight: 800; letter-spacing: .5px; line-height: 1.3; overflow-wrap: anywhere; }
  .doc {
    display: inline-block; margin-top: 4px; padding: 0 10px;
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    border-top: 1.5px solid var(--ink); border-bottom: 1.5px solid var(--ink);
  }
  .rule { border: 0; border-top: 1.5px dashed var(--ink); margin: 8px 0; }
  .rule--double { border-top: 3px double var(--ink); }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 0; font-size: 12px; }
  .meta dt { font-weight: 700; }
  .meta dd { margin: 0; text-align: left; overflow-wrap: anywhere; }
  .meta bdi { font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: right; padding: 0; vertical-align: top; }
  .items thead th { font-size: 11px; font-weight: 700; padding-bottom: 4px; border-bottom: 1.5px solid var(--ink); }
  .items col.amount { width: 38%; }
  .item td { padding-top: 1px; }
  .item:first-of-type tr:first-child td { padding-top: 6px; }
  .item + .item tr:first-child td { padding-top: 7px; border-top: 1px dotted var(--ink); }
  .name { font-weight: 700; overflow-wrap: anywhere; word-break: normal; }
  .name small { font-weight: 400; font-size: 11.5px; }
  .calc td { font-size: 12px; }
  .calc .qty, .calc .unit { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .calc .num { font-weight: 700; font-size: 13px; }
  .disc td { font-size: 11.5px; }
  .totals { margin-top: 2px; }
  .totals th { font-weight: 600; padding: 2px 0; }
  .totals td { padding: 2px 0; }
  .totals .grand th, .totals .grand td {
    font-size: 16px; font-weight: 800; padding: 7px 0 6px;
    border-top: 1.5px solid var(--ink); border-bottom: 1.5px solid var(--ink);
  }
  .totals .grand small { font-size: 11px; font-weight: 600; }
  .totals .due th, .totals .due td { font-weight: 800; padding-top: 5px; }
  .totals .due th::before { content: "◄ "; }
  .foot { margin-top: 10px; text-align: center; font-size: 11px; line-height: 1.6; }
  .foot strong { display: block; font-size: 12.5px; }

  /* ── آماده چاپ ────────────────────────────────────────────────────
     دکمه روی صفحه است و روی کاغذ نمی‌آید. */
  .print-bar { margin: 14px auto 0; max-width: 380px; text-align: center; }
  .print-btn {
    font: inherit; font-weight: 700; padding: 9px 22px; cursor: pointer;
    /* هدف لمسی دست‌کم ۴۴px — مشتری این صفحه را روی گوشی باز می‌کند. */
    min-height: 44px; border-radius: 10px;
    border: 1.5px solid #000; background: #FFFFFF; color: #000;
  }
  .print-btn:focus-visible { outline: 2px solid #000; outline-offset: 3px; }

  @page { margin: 0; }
  @media print {
    .print-bar { display: none !important; }
    html, body { background: #FFFFFF; padding: 0; margin: 0; }
    /* ۸۰mm کاغذ، ۷۲mm چاپ‌پذیر؛ ۴mm حاشیهٔ هر طرف را خودِ برگه نگه می‌دارد. */
    .sheet {
      width: 72mm; max-width: 72mm; margin: 0 auto; padding: 3mm 0 5mm;
      box-shadow: none; font-size: 9.5pt;
    }
    .brand { font-size: 14pt; }
    .calc td, .meta, .disc td { font-size: 8.5pt; }
    .calc .num { font-size: 9.5pt; }
    .totals .grand th, .totals .grand td { font-size: 12pt; }
    /* یک قلم نباید وسطش بشکند (برای چاپگر صفحه‌ای و PDF). */
    .item, tr { break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style>
<div class="sheet">
  <header class="head">
    <div class="brand">${esc(data.shopName)}</div>
    <div class="doc">رسید فروش</div>
  </header>
  <hr class="rule">
  <dl class="meta">
    <dt>شماره</dt><dd><bdi dir="ltr">${esc(data.number)}</bdi></dd>
    <dt>تاریخ</dt><dd>${esc(faDate(data.occurredAt, timeZone))}</dd>
    ${data.customerName ? `<dt>مشتری</dt><dd>${esc(data.customerName)}</dd>` : ""}
    <dt>اقلام</dt><dd>${esc(count)}</dd>
  </dl>
  <hr class="rule">

  <table class="items">
    <colgroup><col><col class="amount"></colgroup>
    <thead>
      <tr><th>کالا · تعداد × قیمت واحد</th><th class="num">مبلغ</th></tr>
    </thead>
${items}
  </table>

  <hr class="rule rule--double">
  <table class="totals">
    <tr><th>جمع کالاها</th><td class="num">${money(data.netAmount)}</td></tr>
    ${extra}
    <tr class="grand"><th>قابل پرداخت</th><td class="num">${money(data.payableAmount)} <small>تومان</small></td></tr>
    ${exchangeRow}
    ${dueRow}
  </table>

  <div class="foot"><strong>سپاس از خرید شما</strong>همه مبالغ به تومان است.</div>
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
</div>
<script>${PRINT_SCRIPT}</script>
</html>`;
}
