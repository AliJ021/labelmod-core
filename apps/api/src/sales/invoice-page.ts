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

/** تاریخ شمسی با رقم لاتین — مشتری تاریخ میلادی نمی‌خواند؛ رقم‌ها مثل بقیهٔ فاکتور لاتین. */
export function faDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    numberingSystem: "latn",
  }).format(at);
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
 * سربرگ برند (لوگوی اصیل یا نشان متنی) ← برچسب سند ← جعبهٔ مشخصات دوستونه
 * (شماره، تاریخ، مشتری، تعداد قلم) ← اقلام شماره‌دار با رنگ تنوع به‌شکل
 * برچسب قاب‌دار ← جمع‌ها با «قابل پرداخت» در قاب درشت ← پرداخت‌شده، تسویه
 * از تعویض و مانده ← وضعیت تسویه ← پابرگ از تنظیمات زنده.
 *
 * ── قواعد چاپ حرارتی ────────────────────────────────────────────────
 *
 * - **فقط سیاه.** خاکستری روی کاغذ حرارتی نقطه‌نقطه و کم‌رنگ درمی‌آید؛
 *   سلسله‌مراتب با وزن و اندازهٔ قلم، قاب و خط‌چین ساخته می‌شود، نه با رنگ.
 *   هیچ پس‌زمینهٔ سنگین و پُررنگی روی نسخهٔ چاپی نیست.
 * - **پهنای چاپ‌پذیر ۷۲mm.** کاغذ ۸۰ است ولی هد ~۷۲mm می‌نویسد؛ هر چیزی
 *   پهن‌تر بریده می‌شود. نام قلم تمام‌عرض است؛ تعداد، قیمت واحد و جمع
 *   در ستون‌های هم‌راستا قرار دارند و تخفیف قلم سطر جداگانه دارد.
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
  // متن ورودی: رقم فارسی/عربی → لاتین، بعد escape.
  const txt = (s: string) => esc(latinDigits(s));
  const proforma = data.documentKind === "proforma";
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
      const qty = Number(l.qty).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 3 });
      // منفی در جای خودش: با رقم لاتین در سطر راست‌چین، «−» بی ایزوله پس از عدد دیده می‌شد.
      const discount =
        l.discountAmount > 0n
          ? `\n      <tr class="disc"><td class="idx"></td><td colspan="2">تخفیف قلم</td><td class="num"><bdi dir="ltr">− ${money(l.discountAmount)}</bdi></td></tr>`
          : "";
      // شمارهٔ ردیف در خانهٔ خودش، نه rowspan: rowspan ارتفاع اضافه را میان سطرهای
      // قلم پخش می‌کرد و میان نام و مبلغ فاصلهٔ ناخواسته می‌افتاد.
      // نسخهٔ ۳: «تعداد × قیمت» در سطر راست‌چین مبهم خوانده می‌شد؛ حالا تعداد،
      // قیمت واحد و جمع هر کدام ستون و عنوان صریح خودشان را دارند.
      return `    <tbody class="item">
      <tr class="line"><td class="idx">${latn(i + 1)}</td><td class="name" colspan="3">${name}</td></tr>
      <tr class="calc"><td class="idx"></td><td class="qty">${esc(qty)}</td><td class="num unit">${money(l.unitPrice)}</td><td class="num total">${money(l.netAmount)}</td></tr>${discount}
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
  // پیش‌فاکتور وضعیت تسویه ندارد: هنوز فروشی ثبت نشده که تسویه شده باشد.
  const settle = proforma ? ""
    : due > 0n
      ? `<div class="settle settle--open">تسویه نشده — مانده بدهی ثبت شده است</div>`
      : `<div class="settle">تسویه‌شده</div>`;
  const count = latn(data.lines.length);
  const docTitle = proforma ? "پیش‌فاکتور" : "رسید فروش";
  const proformaNote = proforma
    ? `\n  <div class="proforma-note">برای بررسی اقلام و قیمت‌ها؛ فاکتور نهایی نیست.</div>` : "";
  const logo = data.logo === undefined ? receiptLogo() : data.logo;
  // سربرگ کم‌ارتفاع: لوگو کامل دیده می‌شود (contain) و روی کاغذ از ۱۲mm بلندتر نمی‌شود.
  const brand = logo
    ? `<img class="logo logo--${logo.treatment}" src="${logo.dataUri}" width="${logo.width}" height="${logo.height}" alt="${txt(data.shopName)}">
    <div class="shop">${txt(data.shopName)}</div>`
    : `<div class="brand">${txt(data.shopName)}</div>`;

  return `<!doctype html>
<html lang="fa" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${proforma ? "پیش‌فاکتور" : "فاکتور"} ${txt(data.number)} — ${txt(data.shopName)}</title>
<style>
  /* نسخهٔ ۳ — بوتیک: کاغذ سفید، یک قاب آرام برای هر بخش، وزن قلم کم و یک
     نقطهٔ تمرکز (مبلغ قابل پرداخت). رنگ برنج و خاکستری‌ها فقط روی صفحه‌اند؛
     چاپ حرارتی فقط سیاه است و هیچ سطح پرِ سیاهی ندارد. */
  :root {
    color-scheme: light;
    --ink: #000; --paper: #fff; --ink-2: #57524A; --line: #1A1917;
    --frame: #CFC8BB; --rule: #E6E1D8; --tint: #F8F6F2;
    --desk: #EDEAE4; --desk-2: #E2DDD3; --brass: #8A6214;
  }
  * { box-sizing: border-box; }
  /* زمینهٔ میز روی html تا در صفحهٔ بلند (۳۰+ قلم) هم تا پایین برسد. */
  html { min-height: 100%; background: linear-gradient(180deg, #F6F4F0 0%, var(--desk) 40%, var(--desk-2) 100%); }
  body {
    margin: 0; padding: 28px 14px 32px;
    /* بی فونت‌های «FD» که رقم لاتین را فارسی می‌کشند؛ Vazirmatn و Tahoma رقم لاتین را لاتین می‌کشند. */
    font-family: Vazirmatn, Tahoma, "Segoe UI", sans-serif;
    background: transparent;
    color: var(--ink); font-size: 13px; line-height: 1.6;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* کاغذ با پهنای واقعی‌اش (۷۲mm چاپ‌پذیر ≈ ۴۰۰px در نمایش راحت)، نه کارت پهن. */
  .sheet {
    position: relative; width: 100%; max-width: 400px; margin: 0 auto; padding: 22px 20px 26px;
    background: var(--paper); color: var(--ink); border-radius: 14px 14px 0 0;
    border-top: 3px solid var(--brass);
    box-shadow: 0 1px 2px rgba(25,20,10,.06), 0 14px 40px -12px rgba(25,20,10,.28);
  }
  /* لبهٔ بریده‌شدهٔ رول — فقط روی صفحه. */
  .sheet::after {
    content: ""; position: absolute; inset-inline: 0; bottom: -9px; height: 10px;
    background: linear-gradient(-45deg, transparent 6px, var(--paper) 0) 0 0 / 12px 10px repeat-x,
                linear-gradient(45deg, transparent 6px, var(--paper) 0) 0 0 / 12px 10px repeat-x;
  }

  /* سربرگ جمع‌وجور: لوگو، نام شعبه، و عنوان سند میان دو خط مو. */
  .head { text-align: center; }
  /* نشان متنی وقتی فایل لوگو نیست — لوگوی ساختگی نمی‌سازیم. */
  .brand { font-size: 22px; font-weight: 800; letter-spacing: -.2px; line-height: 1.25; overflow-wrap: anywhere; }
  .logo { display: block; margin: 0 auto; width: auto; height: auto; max-width: 62%; max-height: 48px; object-fit: contain; }
  /* کاغذ حرارتی فقط سیاه دارد؛ نوع درمان از پیکسل‌های خودِ فایل آمده است. */
  .logo--black { filter: brightness(0); }
  .logo--gray { filter: grayscale(1) contrast(1.2); }
  .shop { margin-top: 6px; font-size: 11.5px; font-weight: 400; color: var(--ink-2); overflow-wrap: anywhere; }
  .doc { display: flex; align-items: center; gap: 10px; margin: 12px 0 0; font-size: 11px; font-weight: 600; }
  .doc::before, .doc::after { content: ""; flex: 1; border-top: 1px solid var(--frame); }
  .doc span { padding: 0 2px; letter-spacing: .2px; }

  /* قاب یکپارچه: مشخصات، اقلام و خلاصه همه یک خط، یک شعاع و یک فاصلهٔ داخلی دارند. */
  .meta, .receipt-panel, .proforma-note { border: 1px solid var(--frame); border-radius: 10px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; margin: 14px 0 0; }
  .cell { min-width: 0; padding: 8px 12px; }
  .cell:nth-child(odd) { border-inline-end: 1px solid var(--rule); }
  .cell:nth-child(n+3) { border-top: 1px solid var(--rule); }
  .meta dt { font-size: 10px; font-weight: 400; color: var(--ink-2); }
  .meta dd { margin: 2px 0 0; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
  .docno { font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; font-size: .95em; }

  /* overflow:hidden نمی‌گذاریم تا نام بلند یا شکست صفحهٔ چاپ بریده نشود. */
  .receipt-panel { margin-top: 12px; }
  .panel-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--rule); background: var(--tint); border-radius: 9px 9px 0 0; }
  .panel-heading h2 { margin: 0; font-size: 11.5px; font-weight: 600; }
  .panel-heading span { font-size: 10px; font-weight: 400; color: var(--ink-2); }
  .panel-body { padding: 0 12px 8px; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: right; padding: 0; vertical-align: top; }
  /* اقلام: چهار ستون با عنوان صریح — #، تعداد، قیمت واحد، جمع. نام بالای سه ستون عددی. */
  .items col.idx { width: 20px; }
  .items col.qty { width: 15%; }
  .items col.total { width: 37%; }
  .items thead th { font-size: 10px; font-weight: 400; color: var(--ink-2); padding: 8px 0 6px; border-bottom: 1px solid var(--rule); }
  .items th.qty, .items td.qty { text-align: center; }
  .idx { font-family: Arial, sans-serif; font-size: 10px; font-weight: 400; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .item + .item tr:first-child td { border-top: 1px solid var(--rule); }
  .item tr:first-child td { padding-top: 9px; }
  .item tr:last-child td { padding-bottom: 9px; }
  .line .idx { padding-top: 11px; }
  .name { font-weight: 500; font-size: 12.5px; line-height: 1.65; overflow-wrap: anywhere; word-break: normal; }
  /* رنگ تنوع در سطر خودش زیر نام، کم‌وزن؛ «رنگ:» فقط نمایشی است و در داده نیست. */
  .name small { display: block; margin-top: 1px; font-size: 10.5px; font-weight: 400; color: var(--ink-2); }
  .name small::before { content: "رنگ: "; }
  .calc td { padding-top: 3px; font-size: 12px; }
  .calc .qty { font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; }
  /* عدد: رقم جدولی، تراز به لبهٔ چپ هر ستون؛ قیمت واحد کم‌رنگ‌تر از جمع. */
  .num { text-align: left; font-family: Arial, Tahoma, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .items th.num { font-family: inherit; }
  .calc .unit { color: var(--ink-2); padding-inline-end: 8px; }
  .calc .total { font-weight: 600; font-size: 12.5px; }
  .disc td { padding-top: 2px; font-size: 11px; color: var(--ink-2); }

  /* خلاصه: سطرهای آرام و یک تمرکز — مبلغ قابل پرداخت درشت و جدا با خط مو. */
  .totals { margin-top: 4px; }
  .totals th { font-weight: 400; padding: 5px 0; }
  .totals td { padding: 5px 0; }
  .totals .incl th, .totals .incl td { font-size: 11px; color: var(--ink-2); padding-top: 0; }
  .totals .grand th, .totals .grand td {
    padding: 11px 0 10px; vertical-align: baseline;
    border-top: 1px solid var(--frame); border-bottom: 1px solid var(--frame);
  }
  .totals .grand th { font-size: 12.5px; font-weight: 600; }
  .totals .grand td { font-size: 21px; font-weight: 700; color: var(--brass); letter-spacing: -.2px; }
  .totals .grand small, .totals .due small { font-family: Vazirmatn, Tahoma, sans-serif; font-size: 10.5px; font-weight: 500; color: var(--ink); }
  .totals .paid th, .totals .paid td { padding-top: 9px; }
  .totals .due th, .totals .due td { font-weight: 700; font-size: 13.5px; padding-top: 6px; }
  .due-tag { font-size: 12.5px; }
  .settle { margin: 8px 0 2px; text-align: center; font-size: 10.5px; font-weight: 500; color: var(--ink-2); }
  .settle--open { color: var(--ink); font-weight: 600; }
  /* پیش‌فاکتور: هشدار قاب‌دار زیر سربرگ، روی کاغذ هم. */
  .proforma-note { margin: 12px 0 0; padding: 7px 12px; text-align: center; font-size: 11px; font-weight: 600; border-style: dashed; }

  .foot { margin-top: 16px; text-align: center; font-size: 10.5px; line-height: 1.85; color: var(--ink-2); }
  .foot strong { display: block; margin-bottom: 3px; font-size: 12.5px; font-weight: 600; color: var(--ink); }
  .foot .policy { font-weight: 400; }
  .foot .site { font-weight: 600; color: var(--ink); letter-spacing: .4px; }
  .foot .unit { font-size: 10px; }

  /* ── آماده چاپ ────────────────────────────────────────────────────
     دکمه و راهنما روی صفحه است و روی کاغذ نمی‌آید. */
  .print-bar { margin: 26px auto 0; max-width: 400px; text-align: center; }
  .print-btn {
    font: inherit; font-weight: 700; padding: 10px 26px; cursor: pointer;
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
      border-radius: 0; border-top: 0; box-shadow: none; font-size: 9pt;
    }
    .sheet::after { display: none; }
    /* کاغذ حرارتی خاکستری ندارد: همه سیاه، خط‌ها نازک، هیچ سطح پری. */
    .sheet, .shop, .meta dt, .idx, .items thead th, .name small, .calc .unit, .disc td,
    .totals .incl th, .totals .incl td, .totals .grand td, .settle, .foot, .foot .unit, .panel-heading span { color: #000; }
    .doc::before, .doc::after, .meta, .receipt-panel, .proforma-note, .totals .grand th, .totals .grand td { border-color: #000; }
    .cell:nth-child(odd), .cell:nth-child(n+3), .panel-heading, .items thead th, .item + .item tr:first-child td { border-color: #000; }
    .meta, .receipt-panel, .proforma-note { border-width: .2mm; border-radius: 1.5mm; }
    .item + .item tr:first-child td { border-top-style: dotted; }
    .brand { font-size: 15pt; }
    .logo { max-height: 12mm; max-width: 48mm; }
    .shop { font-size: 8pt; margin-top: 1mm; }
    .doc { font-size: 7.5pt; margin-top: 2mm; }
    .meta { margin-top: 2.5mm; }
    .cell { padding: 1.2mm 2.2mm; }
    .meta dt { font-size: 6.5pt; }
    .meta dd { font-size: 8pt; margin-top: .3mm; }
    .receipt-panel { margin-top: 2.5mm; }
    .panel-heading { padding: 1.3mm 2.2mm; background: transparent; border-radius: 0; }
    .panel-heading h2 { font-size: 8pt; }
    .panel-heading span { font-size: 6.5pt; }
    .panel-body { padding: 0 2.2mm 1.2mm; }
    .items col.idx { width: 3.2mm; }
    .items thead th { font-size: 6.5pt; padding: 1.4mm 0 1mm; }
    .idx { font-size: 6.5pt; }
    .item tr:first-child td { padding-top: 1.8mm; }
    .item tr:last-child td { padding-bottom: 1.8mm; }
    .line .idx { padding-top: 2.1mm; }
    .name { font-size: 8.5pt; }
    .name small { font-size: 7pt; }
    .calc td { font-size: 8pt; padding-top: .5mm; }
    .calc .unit { padding-inline-end: 1.5mm; }
    .calc .total { font-size: 8.5pt; }
    .disc td, .totals .incl th, .totals .incl td { font-size: 7.5pt; }
    .totals th, .totals td { padding: 1mm 0; }
    .totals .grand th, .totals .grand td { padding: 2mm 0 1.8mm; border-width: .3mm; }
    .totals .grand td { font-size: 13pt; }
    .totals .grand th { font-size: 9pt; }
    .totals .grand small, .totals .due small { font-size: 7pt; }
    .totals .due th, .totals .due td { font-size: 9pt; }
    .due-tag { font-size: 9pt; }
    .settle, .foot, .proforma-note { font-size: 7.5pt; }
    .foot strong { font-size: 9pt; }
    .foot .unit { font-size: 6.5pt; }
    /* یک قلم نباید وسطش بشکند (برای چاپگر صفحه‌ای و PDF). */
    .item, tr, .meta, .settle, .summary-panel { break-inside: avoid; }
    .panel-heading { break-after: avoid; }
    thead { display: table-header-group; }
  }
</style>
<div class="sheet">
  <header class="head">
    ${brand}
    <div class="doc"><span>${docTitle}</span></div>
  </header>${proformaNote}
  <dl class="meta">
    <div class="cell"><dt>${proforma ? "شمارهٔ مرجع" : "شمارهٔ فاکتور"}</dt><dd><bdi dir="ltr" class="docno">${txt(data.number)}</bdi></dd></div>
    <div class="cell"><dt>تاریخ و ساعت</dt><dd>${esc(faDate(data.occurredAt, timeZone))}</dd></div>
    <div class="cell"><dt>مشتری</dt><dd>${data.customerName ? `<bdi>${txt(data.customerName)}</bdi>` : "مشتری عمومی"}</dd></div>
    <div class="cell"><dt>اقلام</dt><dd>${esc(count)} قلم</dd></div>
  </dl>

  <section class="receipt-panel" aria-labelledby="items-heading">
    <div class="panel-heading"><h2 id="items-heading">جزئیات خرید</h2><span>مبالغ به تومان</span></div>
    <div class="panel-body">
  <table class="items">
    <colgroup><col class="idx"><col class="qty"><col class="unit"><col class="total"></colgroup>
    <thead>
      <tr><th class="idx">#</th><th class="qty">تعداد</th><th class="num">قیمت واحد</th><th class="num">جمع</th></tr>
    </thead>
${items}
  </table>
    </div>
  </section>

  <section class="receipt-panel summary-panel" aria-labelledby="summary-heading">
    <div class="panel-heading"><h2 id="summary-heading">خلاصه حساب</h2><span>تومان</span></div>
    <div class="panel-body">
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
    </div>
  </section>

  <footer class="foot">
    <strong>سپاس از خرید شما</strong>
    ${data.returnWindowHours ? `<div class="policy">مهلت مرجوعی: ${esc(windowText(data.returnWindowHours))} پس از خرید</div>` : ""}
    ${data.website ? `<div class="site"><bdi dir="ltr">${txt(data.website)}</bdi></div>` : ""}
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
