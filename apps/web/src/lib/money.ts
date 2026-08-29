/**
 * پول در لایه نمایش.
 *
 * قاعده پروژه: ذخیره و انتقال به **ریال**، به‌صورت **رشته**. نمایش به
 * **تومان**، فقط اینجا. این تنها فایلی در `web` است که حق دارد پول را
 * از ریال به تومان ببرد.
 *
 * چرا `bigint`: مبالغ ریالی سریع از محدوده امنِ `number` جاوااسکریپت
 * بیرون می‌زنند. یک فاکتور ده‌میلیون‌تومانی صد میلیون ریال است؛ چند
 * برابرش در گزارش سالانه، دقت را از دست می‌دهد و کسی نمی‌فهمد.
 */

/** رشته ریالیِ API → `bigint`. عدد صریح رد می‌شود. */
export function parseRial(value: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new TypeError(`مبلغ باید رشته رقم صحیح باشد: ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * ریال → متن تومان با جداکننده هزارگان.
 *
 * جداکننده `٬` (U+066C) است نه ویرگول لاتین — همان چیزی که در متن
 * فارسی درست می‌نشیند.
 */
export function toman(rial: bigint): string {
  const negative = rial < 0n;
  const abs = negative ? -rial : rial;
  const text = (abs / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return negative ? `−${text}` : text;
}

/** برای سرستون و خلاصه: «۲٫۴ م» به‌جای «۲٬۴۰۰٬۰۰۰». */
export function tomanShort(rial: bigint): string {
  const t = rial / 10n;
  const abs = t < 0n ? -t : t;
  if (abs >= 1_000_000_000n) return `${fmt(t, 1_000_000_000n)} میلیارد`;
  if (abs >= 1_000_000n) return `${fmt(t, 1_000_000n)} م`;
  if (abs >= 1_000n) return `${fmt(t, 1_000n)} هز`;
  return t.toString();
}

/** یک رقم اعشار، بدون شناور: تقسیم صحیح روی ده‌برابر، بعد جدا کردن. */
function fmt(value: bigint, unit: bigint): string {
  const tenths = (value * 10n) / unit;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  const f = frac < 0n ? -frac : frac;
  return f === 0n ? whole.toString() : `${whole}٫${f}`;
}
