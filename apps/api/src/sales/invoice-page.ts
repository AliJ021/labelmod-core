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

/** همان قفلِ صفحه برچسب. این صفحه هم جاوااسکریپت لازم ندارد. */
export const INVOICE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export interface InvoicePageLine {
  productName: string;
  color: string | null;
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

export function invoicePage(data: InvoicePageData, timeZone: string): string {
  const rows = data.lines
    .map((l) => {
      const variant = [l.color, l.size].filter((v) => v !== null && v !== "");
      const name = variant.length
        ? `${esc(l.productName)} <small>${variant.map((v) => esc(v as string)).join(" · ")}</small>`
        : esc(l.productName);
      // تعداد «۲.۰۰۰» زشت است و «۲» درست: صفرهای اعشاری بی‌معنا حذف
      // می‌شوند ولی «۱٫۵ متر» دست‌نخورده می‌ماند.
      const qty = String(Number(l.qty));
      const discount =
        l.discountAmount > 0n
          ? `<div class="disc">− ${esc(toToman(l.discountAmount))}</div>`
          : "";
      return `<tr>
      <td class="name">${name}</td>
      <td class="num">${esc(qty)}</td>
      <td class="num">${esc(toToman(l.unitPrice))}</td>
      <td class="num">${esc(toToman(l.netAmount))}${discount}</td>
    </tr>`;
    })
    .join("\n");

  const extra = [
    data.shippingAmount > 0n
      ? `<tr><th>کرایه ارسال</th><td class="num">${esc(toToman(data.shippingAmount))}</td></tr>`
      : "",
    data.taxAmount > 0n
      ? `<tr><th>مالیات</th><td class="num">${esc(toToman(data.taxAmount))}</td></tr>`
      : "",
  ].join("");

  // بدهی باقیمانده فقط وقتی واقعاً هست. «۰ تومان مانده» یک سطر اضافه
  // است که هیچ‌کس لازمش ندارد.
  const due = data.payableAmount - data.paidAmount;
  const dueRow =
    due > 0n
      ? `<tr class="due"><th>مانده</th><td class="num">${esc(toToman(due))}</td></tr>`
      : "";

  return `<!doctype html>
<html lang="fa" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>فاکتور ${esc(data.number)} — ${esc(data.shopName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font-family: Vazirmatn, "Segoe UI", Tahoma, sans-serif;
    /* ⚠️ سطح **مات** و پرتضاد، نه شیشه‌ای. ADR-002: جدول عدد هرگز
       روی شیشه نمی‌نشیند — و این صفحه را ممکن است کسی زیر آفتاب،
       روی گوشی ارزان، یا چاپ‌شده روی کاغذ سیاه‌وسفید بخواند. */
    background: #EDEBF2; color: #14121C;
    line-height: 1.7;
  }
  .sheet {
    max-width: 640px; margin: 0 auto; padding: 20px;
    background: #FFFFFF; border-radius: 14px;
    border: 1px solid rgba(20,18,28,.10);
  }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .meta { color: #55506A; font-size: 13px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: right; padding: 7px 4px; }
  thead th {
    font-size: 12px; color: #55506A; font-weight: 600;
    border-bottom: 1px solid rgba(20,18,28,.14);
  }
  tbody td { border-bottom: 1px solid rgba(20,18,28,.07); vertical-align: top; }
  .num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .name small { color: #55506A; font-weight: normal; }
  .disc { color: #2E8B63; font-size: 12px; }
  .totals { margin-top: 12px; }
  .totals th { color: #55506A; font-weight: 600; }
  .totals .grand th, .totals .grand td {
    font-size: 16px; font-weight: 700;
    border-top: 2px solid rgba(20,18,28,.16); padding-top: 10px;
  }
  .totals .due td { color: #C0392F; font-weight: 700; }
  .foot { margin-top: 18px; color: #55506A; font-size: 12px; text-align: center; }
  /* چاپ: کاغذ سفید است، پس زمینه و سایه فقط جوهر می‌خورند. */
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: none; border-radius: 0; max-width: none; }
    .foot { display: none; }
  }
</style>
<div class="sheet">
  <h1>${esc(data.shopName)}</h1>
  <div class="meta">
    فاکتور ${esc(data.number)} · ${esc(faDate(data.occurredAt, timeZone))}
    ${data.customerName ? ` · ${esc(data.customerName)}` : ""}
  </div>

  <table>
    <thead>
      <tr><th>کالا</th><th class="num">تعداد</th><th class="num">قیمت واحد</th><th class="num">مبلغ</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><th>جمع کالاها</th><td class="num">${esc(toToman(data.netAmount))}</td></tr>
    ${extra}
    <tr class="grand"><th>قابل پرداخت</th><td class="num">${esc(toToman(data.payableAmount))} تومان</td></tr>
    ${dueRow}
  </table>

  <div class="foot">همه مبالغ به تومان است.</div>
</div>
</html>`;
}
