/**
 * ترتیب سایز — چیزی که مرتب‌سازی الفبایی خرابش می‌کند.
 *
 * `["S","M","L","XL"].sort()` می‌دهد `L, M, S, XL`. روی یک فهرست ساده
 * این فقط زشت است؛ روی **ماتریس موجودی** یعنی ابزار بی‌فایده می‌شود.
 *
 * کل ارزش آن ماتریس این است که «سوراخ وسط جدول» را نشان دهد: در
 * پوشاک سایزهای میانی اول تمام می‌شوند، و صفر بودنِ M و L در حالی که
 * XXL مانده یعنی «این مدل خوب می‌فروشد و نیمی از مشتری‌ها دست خالی
 * برمی‌گردند — همین حالا سفارش بده». اگر ستون‌ها به‌هم‌ریخته باشند،
 * وسطی وجود ندارد و آن الگو دیده نمی‌شود.
 */

/** سایزهای حرفی، به ترتیب کوچک به بزرگ. */
const LETTER_ORDER = [
  "XXXS",
  "XXS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "XXXL",
  "XXXXL",
];

/** «تک‌سایز» — همیشه تنهاست، پس اول می‌آید. */
const FREE_SIZE = new Set(["FREE", "FREESIZE", "ONESIZE", "آزاد", "تکسایز", "فریسایز"]);

/** حرف‌های فارسی/عربیِ هم‌شکل و ارقام فارسی، به شکل یکدست. */
function normalize(raw: string): string {
  const digits: Record<string, string> = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  };
  return raw
    .trim()
    .toUpperCase()
    .replace(/[۰-۹٠-٩]/g, (d) => digits[d] ?? d)
    // فاصله، نیم‌فاصله و خط تیره در «X L» و «X-L» و «تک‌سایز» حذف می‌شوند
    .replace(/[\s‌_-]+/g, "");
}

/**
 * `3XL` → `XXXL`. شکل رایجی که روی برچسب کارخانه می‌آید.
 *
 * سقف ۶ عمدی است: بالاتر از آن دیگر سایز نیست، غلط تایپی است — و
 * `99XL` نباید یک رشته ۹۹ حرفی بسازد.
 */
function expandNumericX(s: string): string {
  const m = /^(\d{1,2})X([SL])$/.exec(s);
  if (!m) return s;
  const n = Number(m[1]);
  if (n < 2 || n > 6) return s;
  return "X".repeat(n) + m[2];
}

/**
 * رتبه یک سایز. کوچک‌تر یعنی جلوتر.
 *
 * سه دسته، هرکدام در محدوده خودشان تا با هم قاطی نشوند:
 *   ۰         تک‌سایز
 *   ۱۰۰+      سایز حرفی (S, M, L …)
 *   ۱۰۰۰۰+    سایز عددی (۳۶، ۳۸، ۴۰ …)
 *   ۱۰۰۰۰۰    ناشناخته — ته فهرست، الفبایی
 */
export function sizeRank(size: string | null): number {
  if (size === null || size.trim() === "") return 1_000_000;
  const s = expandNumericX(normalize(size));

  if (FREE_SIZE.has(s)) return 0;

  const letter = LETTER_ORDER.indexOf(s);
  if (letter >= 0) return 100 + letter;

  // «۴۰» یا «۳۸-۴۰» یا «40R» — با عدد اولش مرتب می‌شود
  const num = /^(\d{1,3})/.exec(s);
  if (num) return 10_000 + Number(num[1]);

  return 100_000;
}

/** مرتب‌سازی سایزها به ترتیب واقعی پوشاک، نه الفبایی. */
export function sortSizes(sizes: Array<string | null>): Array<string | null> {
  return [...sizes].sort((a, b) => {
    const d = sizeRank(a) - sizeRank(b);
    if (d !== 0) return d;
    // هم‌رتبه‌ها (هر دو ناشناخته) الفبایی — تا ترتیب پایدار بماند
    return String(a ?? "").localeCompare(String(b ?? ""), "fa");
  });
}
