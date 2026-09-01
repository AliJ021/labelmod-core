/**
 * ریاضیِ پرداخت صندوق — توابع خالص، همه با `bigint`.
 *
 * هیچ‌کدام از این‌ها جمع فاکتور را **نمی‌سازند**: جمع از پاسخ سرور
 * می‌آید و همان‌جا در SQL ساخته شده. آنچه اینجا حساب می‌شود فقط
 * چیزهایی است که سرور برنمی‌گرداند و صندوق‌دار لازم دارد ببیند:
 * «چقدر مانده» و «چقدر باید پس بدهم».
 *
 * چرا اصلاً یک فایل جدا: این دو عدد جلوی چشم مشتری روی صفحه‌اند و
 * اشتباهشان یعنی پول کم یا زیاد از کشو. یک تفریق ساده‌اند، ولی
 * ساده‌بودن دلیل نیست که تست نداشته باشند.
 */

/**
 * چقدر از این فاکتور هنوز پرداخت نشده.
 *
 * هرگز منفی نمی‌شود: اگر مشتری بیشتر داده، «مانده» صفر است و آن اضافه
 * `changeRial` است. یکی‌کردنشان یعنی یک عدد منفی روی صفحه که هیچ‌کس
 * نمی‌داند یعنی چه.
 */
export function remainingRial(payable: bigint, received: bigint): bigint {
  const left = payable - received;
  return left > 0n ? left : 0n;
}

/** چقدر باید به مشتری پس داده شود. */
export function changeRial(payable: bigint, received: bigint): bigint {
  const over = received - payable;
  return over > 0n ? over : 0n;
}

/** آیا پول کامل رسیده؟ بیشتر بودن هم یعنی رسیده. */
export function isSettled(payable: bigint, received: bigint): boolean {
  return received >= payable;
}

/**
 * آیا این فاکتور قابل نهایی‌سازی است؟
 *
 * ⚠️ این یک **راحتی** است، نه یک دروازه. سرور خودش دوباره می‌سنجد و
 * فروش نسیه مجوز جداگانه دارد (`sale.credit`). اینجا فقط برای این
 * است که دکمه‌ای نشان داده نشود که کلیکش خطا می‌دهد.
 */
export function canFinalize(input: {
  status: string;
  lineCount: number;
  payable: bigint;
  received: bigint;
}): boolean {
  if (input.status !== "draft") return false;
  // سبد خالی فاکتور نمی‌شود — نه از نظر معنا، نه از نظر سرور.
  if (input.lineCount === 0) return false;
  return isSettled(input.payable, input.received);
}

/**
 * تعداد تازه یک سطر پس از «+» یا «−».
 *
 * `null` یعنی نتیجه صفر یا کمتر می‌شد — که مسیرش **حذف قلم** است، نه
 * تغییر تعداد. سرور هم همین را می‌گوید (`bad_qty`) و دلیلش این است
 * که حذف یک عمل دیگر با ردّ حسابرسی متفاوت است.
 */
export function steppedQty(current: string, delta: number): string | null {
  // تعداد در صندوق عدد صحیح است — همان محدودیتی که Endpoint دارد.
  const n = Number(current);
  if (!Number.isFinite(n)) return null;
  const next = Math.trunc(n) + delta;
  return next > 0 ? String(next) : null;
}
