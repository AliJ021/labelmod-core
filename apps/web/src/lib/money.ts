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

/**
 * آنچه صندوق‌دار تایپ می‌کند (تومان) → ریالِ رشته‌ای برای API.
 *
 * این مرز دیگری است که فقط همین فایل حق عبور از آن را دارد. صندوق‌دار
 * «۱۵۰٬۰۰۰» می‌بیند و می‌نویسد؛ سرور ۱۵۰۰۰۰۰ ریال می‌خواهد. اگر این
 * ضرب در ده جایی در یک کامپوننت بیفتد، دیر یا زود یک جا از قلم
 * می‌افتد و مبلغ ده برابر یا یک‌دهم ثبت می‌شود.
 *
 * `null` یعنی ورودی هنوز عدد معتبری نیست — نه صفر. صفر یک مبلغ است.
 *
 * اعشار عمداً پذیرفته **نمی‌شود**: ریال واحد صحیح است و «۱۰٫۵ تومان»
 * یعنی ۱۰۵ ریال، که در صندوق پوشاک یک اشتباه تایپی است نه یک قصد.
 */
export function rialFromTomanInput(raw: string): bigint | null {
  let digits = "";
  for (const ch of raw.trim()) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x06f0 && c <= 0x06f9) digits += String.fromCharCode(48 + (c - 0x06f0)); // ۰-۹
    else if (c >= 0x0660 && c <= 0x0669) digits += String.fromCharCode(48 + (c - 0x0660)); // ٠-٩
    else if (ch >= "0" && ch <= "9") digits += ch;
    // جداکننده هزارگان به هر شکلی که تایپ شود، و نیم‌فاصله.
    else if (ch === "٬" || ch === "," || ch === " " || ch === "‌") continue;
    else return null;
  }
  if (digits === "") return null;
  return BigInt(digits) * 10n;
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
