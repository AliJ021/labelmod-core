/**
 * نظام عدد و تاریخ در لایهٔ نمایش (docs/DESIGN_SYSTEM.md، «عدد مالی»).
 *
 * پول از `money.ts` می‌آید و تبدیل ریال به تومان فقط آنجاست؛ این فایل
 * تصمیم «چطور دیده شود» را یک جا نگه می‌دارد تا هر صفحه قاعدهٔ خودش را
 * نسازد:
 *
 *   مبلغ    رقم لاتین در قلم مونو، جداکنندهٔ «٬»، منفی با «−» (U+2212)
 *           و در جدول حسابداری اختیاری با پرانتز. هرگز فقط با رنگ.
 *   صفر     «0» کم‌رنگ، نه خط تیره. «—» یعنی «نمی‌دانیم/اجازه نیست».
 *   درصد    «12٫5٪» — ممیز فارسی، بدون شناور در محاسبه‌ای که پول بسازد.
 *   تعداد   رشتهٔ اعشاری API («1.5») → «1٫5».
 *   شمارش   در متن فارسی با رقم فارسی: «۱۲ فاکتور».
 *   تاریخ   جلالی با رقم فارسی، اصلی؛ میلادی فقط ثانوی.
 *
 * ⚠️ این فایل محاسبهٔ پولی نمی‌کند. جمع و ضرب در SQL است.
 */
import { parseRial, toman, tomanExact, tomanShort } from "./money.ts";
import { CHANNEL_LABEL } from "./reports.ts";

export type Sign = "positive" | "negative" | "zero";

export interface MoneyParts {
  /** رقم‌ها بدون علامت: «12٬340». */
  digits: string;
  /**
   * واژهٔ مقیاس فشرده («میلیارد»، «م»، «هز») — **بیرون** از برگ LTR
   * می‌نشیند، وگرنه «12٫3 میلیارد» در RTL وارونه خوانده می‌شد.
   */
  scale: string;
  sign: Sign;
  /** متن کامل برای صفحه‌خوان و title: «منفی ۱۲٬۳۴۰ تومان». */
  spoken: string;
}

function asRial(value: bigint | string): bigint {
  return typeof value === "bigint" ? value : parseRial(value);
}

/** ریال → اجزای نمایش تومان. حالت دقیق بر فشرده‌سازی مقدم است. */
export function moneyParts(value: bigint | string, compact = false, exact = false): MoneyParts {
  const rial = asRial(value);
  const sign: Sign = rial > 0n ? "positive" : rial < 0n ? "negative" : "zero";
  const abs = rial < 0n ? -rial : rial;
  const [digits = "0", ...rest] = (exact ? tomanExact(abs) : compact ? tomanShort(abs) : toman(abs)).split(" ");
  const scale = rest.join(" ");
  const spoken = `${sign === "negative" ? "منفی " : ""}${digits}${scale ? ` ${scale}` : ""} تومان`;
  return { digits, scale, sign, spoken };
}

/** متن کامل مبلغ با علامت؛ برای جایی که کامپوننت `Money` نمی‌نشیند (CSV نه، title بله). */
export function formatMoney(value: bigint | string, style: "minus" | "parens" = "minus"): string {
  const { digits, sign } = moneyParts(value);
  if (sign !== "negative") return digits;
  return style === "parens" ? `(${digits})` : `−${digits}`;
}

/**
 * درصد با یک رقم اعشار و ممیز فارسی.
 *
 * ورودی `number` است چون درصد نسبت است نه پول؛ هیچ مبلغی از آن
 * ساخته نمی‌شود.
 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = Math.abs(value).toFixed(digits).replace(/\.?0+$/, "");
  const text = fixed.replace(".", "٫");
  return `${value < 0 ? "−" : ""}${text}٪`;
}

/** تعداد اعشاری API («1.500») → «1٫5». */
export function formatQty(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new TypeError(`تعداد نامعتبر: ${value}`);
  const [whole = "0", frac = ""] = value.replace(/^-/, "").split(".");
  const trimmed = frac.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return `${value.startsWith("-") ? "−" : ""}${grouped}${trimmed ? `٫${trimmed}` : ""}`;
}

const FA_DIGITS = new Intl.NumberFormat("fa-IR", { useGrouping: true });

/** شمارش در متن فارسی: «۱۲». */
export function formatCount(n: number): string {
  return FA_DIGITS.format(n);
}

// `timeZone: "UTC"`: ورودی «تاریخ» است نه «لحظه» — همان قاعدهٔ jalali-period.ts.
const JALALI_PARTS = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric",
});
const GREGORIAN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
});

function isoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`تاریخ نامعتبر: ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`تاریخ نامعتبر: ${value}`);
  return date;
}

/** «۲۵ شهریور ۱۴۰۵» — تاریخ اصلی رابط. */
export function formatJalali(value: string, withWeekday = false): string {
  // ترتیب اجزا صریح ساخته می‌شود: ICU در موتورهای مختلف ترتیب
  // «روز هفته» را یکسان نمی‌چیند و تاریخ نباید بین دو مرورگر فرق کند.
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    JALALI_PARTS.formatToParts(isoDate(value)).find(p => p.type === type)?.value ?? "";
  const date = `${part("day")} ${part("month")} ${part("year")}`;
  return withWeekday ? `${part("weekday")}، ${date}` : date;
}

/** «16 Sept 2026» — فقط ثانوی، کنار جلالی و درون برگ LTR. */
export function formatGregorian(value: string): string {
  return GREGORIAN.format(isoDate(value));
}

// «لحظه» (timestamptz) است نه «تاریخ»: در منطقهٔ زمانی مرورگر نشان داده می‌شود، همان
// رفتاری که گزارش‌ها پیش از این با `toLocaleString("fa-IR")` داشتند.
const JALALI_MOMENT = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { dateStyle: "short", timeStyle: "short" });

/** «۱۴۰۵/۶/۲۵، ۱۸:۳۰» برای ستون زمان؛ ورودی نامعتبر همان متن خام کوتاه‌شده. */
export function formatJalaliMoment(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 16).replace("T", " ") : JALALI_MOMENT.format(d);
}

/** ساعت کاری ۰ تا ۲۳ با رقم فارسی: «۱۸». */
export function formatHour(hour: number): string {
  return FA_DIGITS.format(hour);
}

/**
 * برچسب انسانی کانال فروش. کد خام (`pos`/`web`) هرگز به کاربر نمی‌رسد؛
 * کانال ناشناخته «کانال دیگر» است و کدش فقط در title برای پشتیبانی.
 */
export function channelLabel(code: string): string {
  return CHANNEL_LABEL[code] ?? "کانال دیگر";
}
