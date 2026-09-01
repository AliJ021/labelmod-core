/**
 * ریاضی مرجوعی — پیشنهاد مبلغ، نه تصمیم آن.
 *
 * ── چرا این اعداد اینجا حساب می‌شوند ──────────────────────────────
 *
 * برخلاف جمع فاکتور که سرور می‌سازد و ما فقط نشانش می‌دهیم،
 * `refundAmount` را **کلاینت می‌فرستد** (`createReturnBody`). یعنی
 * صفحه باید عددی پیشنهاد بدهد.
 *
 * این نگران‌کننده به نظر می‌رسد ولی نیست: `sales.post_return` سقف را
 * خودش می‌گذارد — «بازپرداخت از پول واقعاً دریافت‌شده بیشتر نمی‌شود»
 * (`003_corrections.sql:752`). پس بدترین کاری که یک عدد اشتباه
 * می‌کند این است که رد شود، نه اینکه پول اضافه از کشو برود.
 *
 * ── چرا همان فرمول سرور ───────────────────────────────────────────
 *
 * سطر مرجوعی را سرور با `round(net_amount * qty / sold_qty)` حساب
 * می‌کند (`003:843`). اگر اینجا فرمول دیگری بنویسیم — مثلاً
 * `unit_price × qty` — عدد پیشنهادی با آنچه ثبت می‌شود یکی درنمی‌آید
 * و صندوق‌دار روی صفحه یک مبلغ می‌بیند و روی سند مبلغ دیگری.
 *
 * تفاوتشان وقتی پیداست که سطر تخفیف داشته باشد: `net_amount` تخفیف
 * را در خود دارد، `unit_price × qty` نه.
 */

/** یک سطر، از دید «چقدرش هنوز قابل برگشت است». */
export interface Returnable {
  invoiceLineId: string;
  soldQty: string;
  remainingQty: string;
  netAmount: string;
}

/** آنچه صندوق‌دار انتخاب کرده: چند تا از هر سطر. */
export type Selection = Map<string, number>;

/**
 * گرد کردن نیم‌به‌بالا روی `bigint` — همان کاری که `round()` پستگرس
 * با `NUMERIC` می‌کند.
 *
 * تقسیم `bigint` در جاوااسکریپت به سمت صفر می‌برد، پس بدون این،
 * هر سطر یک ریال کم می‌شد و جمع مرجوعیِ ده‌قلمی ده ریال با سند فرق
 * می‌کرد.
 */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** بیشترین تعدادی که از این سطر می‌شود برگرداند. */
export function maxReturnable(line: Returnable): number {
  const n = Number(line.remainingQty);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** تعداد انتخابی، محدود به آنچه واقعاً باقی مانده. */
export function clampQty(line: Returnable, wanted: number): number {
  const max = maxReturnable(line);
  if (!Number.isFinite(wanted) || wanted <= 0) return 0;
  return Math.min(Math.floor(wanted), max);
}

/**
 * مبلغ پیشنهادی بازپرداخت برای انتخاب فعلی.
 *
 * سطر به سطر گرد می‌شود و بعد جمع — نه اینکه جمع کل یک بار گرد شود.
 * همان ترتیبی که سرور دارد: هر `sale_return_line` جداگانه
 * `round()` می‌خورد و سند از جمع آن‌ها ساخته می‌شود.
 */
export function suggestedRefund(lines: Returnable[], selection: Selection): bigint {
  let total = 0n;
  for (const line of lines) {
    const qty = selection.get(line.invoiceLineId) ?? 0;
    if (qty <= 0) continue;
    const sold = BigInt(Math.round(Number(line.soldQty)));
    if (sold === 0n) continue;
    total += divRound(BigInt(line.netAmount) * BigInt(qty), sold);
  }
  return total;
}

/** آیا چیزی برای برگرداندن انتخاب شده؟ */
export function hasSelection(selection: Selection): boolean {
  for (const qty of selection.values()) if (qty > 0) return true;
  return false;
}

/** انتخاب، به شکلی که `POST /returns` می‌خواهد. */
export function selectionToLines(
  selection: Selection,
): Array<{ invoiceLineId: string; qty: string; restock: boolean }> {
  const out: Array<{ invoiceLineId: string; qty: string; restock: boolean }> = [];
  for (const [invoiceLineId, qty] of selection) {
    if (qty > 0) {
      // `restock: true` پیش‌فرض درست صندوق است: کالای سالمِ برگشتی به
      // قفسه برمی‌گردد. کالای معیوب مسیر جدا و مجوز جدا دارد.
      out.push({ invoiceLineId, qty: String(qty), restock: true });
    }
  }
  return out;
}
