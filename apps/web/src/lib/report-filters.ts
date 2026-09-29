/**
 * فیلتر بازهٔ گزارش — منطق خالص، بی React (test/report-filters.test.ts).
 *
 * ⚠️ این فایل معنای پرس‌وجو را عوض نمی‌کند: بازه همان ISO میلادی است که
 *    سرور می‌خواهد و «امروز» همچنان از `platform.business_date()` می‌آید.
 *    فقط دو کار می‌کند: (۱) نمایش جلالی همان بازه، (۲) نگه‌داشتنِ درخواست
 *    تا وقتی تاریخ نیمه‌تایپ است — وگرنه هر کلید یک درخواست با تاریخ
 *    ناقص می‌فرستاد و پاسخ خطای سرور جای گزارش می‌نشست.
 */
import { formatJalali } from "./format.ts";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** «2026-09-01» معتبر؟ (تقویم واقعی: ۳۱ شهریور میلادی = ۳۱ سپتامبر نامعتبر است.) */
export function isIsoDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export type PeriodIssue = { field: "from" | "to"; message: string } | null;

/**
 * خطای بازه برای نمایش کنار فیلد. `null` یعنی بازه قابل ارسال است.
 * مقایسهٔ رشته‌ای ISO همان مقایسهٔ تاریخ است.
 */
export function periodIssue(from: string, to: string): PeriodIssue {
  if (!isIsoDate(from)) return { field: "from", message: "تاریخ را به شکل ۲۰۲۶-۰۹-۰۱ کامل کنید." };
  if (!isIsoDate(to)) return { field: "to", message: "تاریخ را به شکل ۲۰۲۶-۰۹-۰۱ کامل کنید." };
  if (from > to) return { field: "to", message: "«تا تاریخ» نباید پیش از «از تاریخ» باشد." };
  return null;
}

/** «۱ شهریور ۱۴۰۵ تا ۲۵ شهریور ۱۴۰۵» — یا یک روز: «۲۵ شهریور ۱۴۰۵». */
export function periodLabel(from: string, to: string): string | null {
  if (periodIssue(from, to) !== null) return null;
  return from === to ? formatJalali(from) : `${formatJalali(from)} تا ${formatJalali(to)}`;
}

/** برچسب جلالی یک تاریخ ورودی، اگر کامل است. */
export function jalaliHint(value: string): string | null {
  return isIsoDate(value) ? formatJalali(value) : null;
}
