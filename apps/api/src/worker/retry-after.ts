/**
 * سنجش هدر `Retry-After` (RFC 9110 §10.2.3) — تنها تعریف در Worker.
 *
 * دو شکل معتبر دارد: عدد صحیح ثانیه (`120`) یا تاریخ HTTP به قالب
 * IMF-fixdate (`Wed, 21 Oct 2026 07:28:00 GMT`). هر چیز دیگری `null` است
 * و Backoff عادی صف به کار می‌رود — نه صفر، و نه «هر عددی که parseInt
 * از آن درآورد».
 *
 * ⚠️ چرا سخت‌گیر: مقدار از سرور بیرونی می‌آید. `parseInt("10abc")` ده
 *    می‌دهد، `Number("1e9")` یک میلیارد، و `Date.parse` تقریباً هر رشته‌ای
 *    را می‌پذیرد. هیچ‌کدام نباید زمان تلاش بعدی یک پیامک را تعیین کنند.
 *
 * ⚠️ سقف ۸۶۴۰۰ ثانیه همان بازهٔ `platform.fail_outbox` است؛ بیرون از آن
 *    `null` است. دیتابیس خودش هم کف را به سقف یک‌ساعتهٔ Backoff می‌برد.
 */
export const RETRY_AFTER_MAX_SECONDS = 86_400;

const DELTA = /^\d{1,6}$/;
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(raw: string | null | undefined, nowMs: number): number | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (DELTA.test(value)) {
    const seconds = Number(value);
    return seconds <= RETRY_AFTER_MAX_SECONDS ? seconds : null;
  }
  if (!IMF_FIXDATE.test(value)) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  // تاریخ گذشته یعنی «همین حالا مجاز است»، نه خطا.
  const seconds = Math.max(0, Math.ceil((at - nowMs) / 1000));
  return seconds <= RETRY_AFTER_MAX_SECONDS ? seconds : null;
}

/** Retry-After فقط روی ۴۲۹ و ۵۰۳ معنای «بعداً بیا» دارد. */
export function retryAfterFor(status: number, raw: string | null | undefined, nowMs: number): number | null {
  return status === 429 || status === 503 ? parseRetryAfter(raw, nowMs) : null;
}
