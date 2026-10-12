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
import { RECEIPT_STYLES } from "./receipt-styles.ts";
import { esc } from "../catalog/label.ts";
import { receiptLogo, type ReceiptLogo } from "./receipt-logo.ts";
import { STORE_PHONE, STORE_SITE, STORE_TITLE } from "../lib/store-brand.ts";

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
  /**
   * مهلت از تنظیم زندهٔ `return.window_hours` — متن ثابت چاپ نمی‌شود. روی رسید
   * «مهلت تعویض» نام دارد (خواستهٔ مالک)؛ مقدار و قاعدهٔ مرجوعی همان تنظیم است.
   */
  returnWindowHours?: number | null;
  /**
   * نشانی `web.site_url` — **روی رسید چاپ نمی‌شود.** آن تنظیم نشانی اتصال ووکامرس
   * است؛ رسید نشانی برند `STORE_SITE` را دارد (خواستهٔ مالک، ۱۴۰۵/۰۷/۲۰).
   */
  website?: string | null;
  /**
   * لوگوی اصیل برند (`receipt-logo.ts`). نیامدن یعنی همان فایل بسته‌بندی‌شده؛
   * `null` یعنی بدون لوگو — آن‌وقت نام شعبه نشان متنی است.
   */
  logo?: ReceiptLogo | null;
  /**
   * `proforma` = پیش‌فاکتور پیش از نهایی‌سازی، برای بررسی اقلام و قیمت‌ها
   * توسط مشتری. فقط تیتر و برچسب‌ها عوض می‌شود: وضعیت «تسویه‌شده» ندارد و
   * شماره را «قطعی» نمی‌نامد (همان رشته‌ای که فراخوان داده نمایش داده
   * می‌شود). هیچ مبلغی عوض نمی‌شود. پیش‌فرض `sale`.
   */
  documentKind?: "sale" | "proforma";
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

/**
 * رقم‌های فاکتور لاتین‌اند (خواستهٔ مالک، ۱۴۰۵/۰۷/۱۷): مبلغ، تعداد، شماره،
 * تاریخ جلالی، ساعت و مهلت مرجوعی. تقویم جلالی و متن فارسی و RTL می‌مانند؛
 * فقط شکل رقم عوض می‌شود. ⚠️ `toToman` (متن پیامک) عمداً دست نخورده است.
 */
const latn = (n: number) => n.toLocaleString("en-US");

/** رقم فارسی و عربی در متن ورودی (نام کالا، مشتری، شماره…) → ASCII. فقط رقم؛ متن دست نمی‌خورد. */
export function latinDigits(text: string): string {
  return text
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** «48 ساعت» یا «2 روز (48 ساعت)» — از همان عدد تنظیم، بی‌گرد کردن نادرست. */
function windowText(hours: number): string {
  return hours % 24 === 0 && hours >= 48
    ? `${latn(hours / 24)} روز (${latn(hours)} ساعت)`
    : `${latn(hours)} ساعت`;
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

/** فقط تاریخ شمسی (رقم لاتین) — ساعت در سطر جدای خودش. */
function faDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeZone, numberingSystem: "latn" }).format(at);
}

/** فقط ساعت و دقیقه، ۲۴ساعته و رقم لاتین. */
function faTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);
}

/**
 * ریال → تومان **دقیق** برای صفحه رسید، با رقم لاتین.
 *
 * `toToman` (بالا) برای متن پیامک است و کسر تومان را کنار می‌گذارد.
 * روی رسید چاپی هیچ ریالی نباید گم شود: ۱۲۳۴۵ ریال «1,234.5» می‌شود، نه
 * «1,234». حساب فقط روی bigint است؛ عدد شناور ساخته نمی‌شود.
 */
export function toTomanExact(rial: bigint): string {
  const negative = rial < 0n;
  const abs = negative ? -rial : rial;
  const whole = (abs / 10n).toLocaleString("en-US");
  const fraction = abs % 10n;
  const text = fraction === 0n ? whole : `${whole}.${fraction.toString()}`;
  return negative ? `−${text}` : text;
}

/**
 * رسید — طراحی تک‌رنگ برای چاپگر حرارتی ۸۰ میلی‌متری (MEVA TP-UNW روی
 * رایانهٔ صندوق) که روی گوشی و «ذخیره PDF» هم نسخهٔ نمایشی خودش را دارد.
 *
 * ── ساختار (بازطراحی ۱۴۰۵/۰۷) ───────────────────────────────────────
 *
 * سربرگ برند (لوگوی اصیل بزرگ با نسبت ذاتی و «فروشگاه لیبل مد» زیرش) ←
 * برچسب سند ← مشخصات درشت (شماره، تاریخ، ساعت، مشتری) ← کادر گرد اقلام: عنوان،
 * تعداد و خالص (بی قیمت واحد و تخفیف قلم) و «جمع کالاها» در پای همان ستون
 * خالص ← سایر جمع‌ها و «قابل پرداخت» ← پابرگ (مهلت تعویض از تنظیم، سایت،
 * تلفن، شعار). پرداخت‌شده و وضعیت تسویه روی چاپ نمی‌آیند (۱۴۰۵/۰۷/۲۰).
 *
 * ── قواعد چاپ حرارتی ────────────────────────────────────────────────
 *
 * - **فقط سیاه.** خاکستری روی کاغذ حرارتی نقطه‌نقطه و کم‌رنگ درمی‌آید؛
 *   سلسله‌مراتب با وزن و اندازهٔ قلم، قاب و خط‌چین ساخته می‌شود، نه با رنگ.
 *   هیچ پس‌زمینهٔ سنگین و پُررنگی روی نسخهٔ چاپی نیست.
 * - **پهنای چاپ‌پذیر ۷۲mm.** کاغذ ۸۰ است ولی هد ~۷۲mm می‌نویسد؛ هر چیزی
 *   پهن‌تر بریده می‌شود. نام قلم، تعداد و خالص در ستون‌های هم‌راستا
 *   قرار دارند. قیمت واحد و تخفیف هر قلم چاپ نمی‌شوند (فاکتور خلوت).
 * - **ارتفاع صفحه تحمیل نمی‌شود.** `@page` فقط حاشیه را صفر می‌کند؛ طول
 *   کاغذ را درایور رول تعیین می‌کند و برش پس از آخرین سطر است.
 * - **نام بلند می‌شکند، عدد نه.** `overflow-wrap:anywhere` روی نام، و
 *   `nowrap` روی مبلغ تا رقم‌ها هرگز دو تکه نشوند.
 *
 * ── اعداد ──────────────────────────────────────────────────────────
 *
 * هیچ عددی این‌جا ساخته نمی‌شود جز «شامل تخفیف اقلام» که جمع دقیق bigint
 * همان `discountAmount`های ذخیره‌شده است و فقط اطلاع می‌دهد (از جمع کم
 * نمی‌شود، چون مبلغ هر قلم از پیش خالص است).
 *
 * ⚠️ قلاب‌های `.sheet`، `.totals` و `#print-btn` قرارداد چاپ مستقیم
 *    (iframe) هستند و تغییر نام نمی‌دهند.
 */
export function invoicePage(data: InvoicePageData, timeZone: string): string {
  const money = (rial: bigint) => esc(toTomanExact(rial));
  // متن ورودی: رقم فارسی/عربی → لاتین، بعد escape.
  const txt = (s: string) => esc(latinDigits(s));
  const proforma = data.documentKind === "proforma";
  const quantity = (value: string) => Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 3 });
  // تعداد اعشاری یا بلند نباید از ستون باریک رسید بیرون بزند.
  const quantityWidth = Math.min(34, 16 + Math.max(0, ...data.lines.map(l => quantity(l.qty).length - 5)) * 2);
  // مبلغ بلند (از جمله «جمع کالاها» پای همین ستون) هم نباید به لبهٔ خانه بچسبد؛ رقم هرگز نمی‌شکند.
  const amountChars = Math.max(...[data.netAmount, ...data.lines.map(l => l.netAmount)].map(v => toTomanExact(v).length));
  const totalWidth = Math.min(44, 33 + Math.max(0, amountChars - 10) * 3);
  const items = data.lines
    .map((l, i) => {
      // فقط رنگِ ساخت‌یافته کنار نام می‌نشیند؛ سایز عمداً نه (بالا،
      // `InvoicePageLine.size`). نام کالا دست نمی‌خورد: هیچ کلمه‌ای با
      // Regex از آن کنده نمی‌شود، حتی اگر شبیه سایز باشد.
      const name =
        l.color !== null && l.color !== ""
          ? `${txt(l.productName)} <small>${txt(l.color)}</small>`
          : txt(l.productName);
      // تعداد «2.000» زشت است و «2» درست: صفرهای اعشاری بی‌معنا حذف
      // می‌شوند ولی «1.5 متر» دست‌نخورده می‌ماند. گروه‌بندی هزارگان نمی‌خورد.
      const qty = quantity(l.qty);
      // فاکتور خلوت (خواستهٔ مالک، ۱۲ اکتبر): هر قلم فقط نام/ویژگی، تعداد و مبلغ
      // نهایی سطر. قیمت واحد و تخفیف قلم چاپ نمی‌شوند؛ snapshot همان قلم در
      // دیتابیس و «شامل تخفیف اقلام» در جمع‌ها دست‌نخورده‌اند.
      return `    <tbody class="item" data-line="${latn(i + 1)}">
      <tr class="line"><td class="name"><div class="item-title">${name}</div></td><td class="qty">${esc(qty)}</td><td class="num total">${money(l.netAmount)}</td></tr>
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
  // پرداخت‌شده، تسویه از تعویض، مانده و وضعیت تسویه عمداً چاپ نمی‌شوند
  // (خواستهٔ مالک، ۱۴۰۵/۰۷/۲۰). میدان‌هایشان در قرارداد و API و دیتابیس
  // دست‌نخورده‌اند؛ فقط این صفحهٔ نمایشی آن‌ها را نمی‌نویسد.
  const docTitle = proforma ? "پیش‌فاکتور" : "رسید فروش";
  const proformaNote = proforma
    ? `\n  <div class="proforma-note">برای بررسی اقلام و قیمت‌ها؛ فاکتور نهایی نیست.</div>` : "";
  const logo = data.logo === undefined ? receiptLogo() : data.logo;
  // لوگوی اصیل کامل و با نسبت واقعی (width/height ذاتی فایل)، بزرگ و بی بازطراحی.
  const brand = logo
    ? `<img class="logo logo--${logo.treatment}" src="${logo.dataUri}" width="${logo.width}" height="${logo.height}" alt="${txt(data.shopName)}">
    <div class="shop">${esc(STORE_TITLE)}</div>`
    : `<div class="brand">${txt(data.shopName)}</div>`;

  return `<!doctype html>
<html lang="fa" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${proforma ? "پیش‌فاکتور" : "فاکتور"} ${txt(data.number)} — ${txt(data.shopName)}</title>
<style>
${RECEIPT_STYLES}
</style>
<div class="sheet">
  <header class="head">
    ${brand}
    <div class="doc"><span>${docTitle}</span></div>
  </header>${proformaNote}
  <dl class="meta">
    <div class="cell"><dt>${proforma ? "شمارهٔ مرجع" : "شمارهٔ فاکتور"}</dt><dd><bdi dir="ltr" class="docno">${txt(data.number)}</bdi></dd></div>
    <div class="cell"><dt>تاریخ</dt><dd>${esc(faDay(data.occurredAt, timeZone))}</dd></div>
    <div class="cell"><dt>ساعت</dt><dd><bdi dir="ltr">${esc(faTime(data.occurredAt, timeZone))}</bdi></dd></div>
    <div class="cell"><dt>مشتری</dt><dd>${data.customerName ? `<bdi>${txt(data.customerName)}</bdi>` : "مشتری عمومی"}</dd></div>
  </dl>

  <section class="items-box" aria-label="اقلام خرید">
  <table class="items">
    <colgroup><col class="title"><col class="qty" style="width:${quantityWidth}%"><col class="total" style="width:${totalWidth}%"></colgroup>
    <thead>
      <tr><th>عنوان کالا</th><th class="qty">تعداد</th><th class="num">خالص</th></tr>
    </thead>
${items}
    <tfoot>
      <tr class="sum"><th colspan="2">جمع کالاها</th><td class="num total">${money(data.netAmount)}</td></tr>
    </tfoot>
  </table>
  </section>

  <section class="summary" aria-label="خلاصه حساب به تومان">
  <table class="totals">
    ${savingRow}
    ${extra}
    <tr class="grand"><th>قابل پرداخت</th><td class="num">${money(data.payableAmount)} <small>تومان</small></td></tr>
  </table>
  </section>

  <footer class="foot">
    <strong>سپاس از خرید شما</strong>
    ${data.returnWindowHours ? `<div class="policy">مهلت تعویض: ${esc(windowText(data.returnWindowHours))} پس از خرید</div>` : ""}
    <div class="site"><bdi dir="ltr">${esc(STORE_SITE)}</bdi></div>
    <div class="tel">تلفن: <bdi dir="ltr">${esc(STORE_PHONE)}</bdi></div>
    <div class="slogan" dir="ltr" lang="en">what your <b>LABEL</b> today?</div>
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
