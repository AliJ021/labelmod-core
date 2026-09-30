/**
 * فیلتر بازهٔ گزارش — منطق خالص، بی React (test/report-filters.test.ts).
 *
 * ⚠️ این فایل معنای پرس‌وجو را عوض نمی‌کند: بازه همان ISO میلادی است که
 *    سرور می‌خواهد و «امروز» همچنان از `platform.business_date()` می‌آید.
 *    سه کار می‌کند: (۱) ورود و نمایش **جلالی** همان بازه — کاربر تاریخ
 *    جلالی می‌نویسد و درخواست و نشانی همان ISO میلادی می‌مانند، (۲)
 *    نگه‌داشتنِ درخواست تا وقتی تاریخ نیمه‌تایپ یا ناموجود است — وگرنه هر
 *    کلید یک درخواست با تاریخ ناقص می‌فرستاد، (۳) تشخیص «ناقص» از «ناموجود».
 */
import { formatJalali } from "./format.ts";
import { fromJalali, toJalali, type Jalali } from "./jalali-period.ts";
import { normalizeDigits } from "./settings-value.ts";

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

// ── ورود جلالی ────────────────────────────────────────────────────────

// با جداکننده، یا هشت رقم پشت‌هم (صفحه‌کلید عددی گوشی «/» ندارد).
const JALALI_COMPLETE = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$|^(\d{4})(\d{2})(\d{2})$/;
/** پیشوندی از همان شکل: هنوز در حال تایپ است، نه غلط. */
const JALALI_PARTIAL = /^\d{0,4}(?:[/.-]\d{0,2}(?:[/.-]\d{0,2})?)?$|^\d{0,8}$/;
/** سال جلالی معقول؛ «۲۰۲۶/۰۹/۰۱» سال میلادی است که در فیلد جلالی نوشته شده. */
const MIN_YEAR = 1300, MAX_YEAR = 1499;

/**
 * تاریخ جلالی دقیق → ISO میلادی؛ روزِ ناموجود (۳۰ اسفندِ سال غیرکبیسه، ۳۱ مهر)
 * `null` است، **نه** آخرین روز ماه. تبدیل همان `Intl` تقویم persian است که
 * صفحه با آن تاریخ نشان می‌دهد (`jalali-period.ts`)، پس رفت و برگشت یکی‌اند.
 */
export function jalaliToIso(j: Jalali): string | null {
  if (!Number.isInteger(j.year) || !Number.isInteger(j.month) || !Number.isInteger(j.day)) return null;
  if (j.month < 1 || j.month > 12 || j.day < 1 || j.day > 31) return null;
  // نقطهٔ شروع جست‌وجو: ۱ فروردین نزدیک ۲۱ مارس است؛ پنجرهٔ ±۴۵ روزِ fromJalali کل ماه را می‌پوشاند.
  const near = new Date(Date.UTC(j.year + 621, 2, 21) + Math.round((j.month - 1) * 30.5 + j.day - 1) * 86_400_000).toISOString().slice(0, 10);
  const iso = fromJalali(j, near);
  if (iso === null) return null;
  const back = toJalali(iso);
  return back.year === j.year && back.month === j.month && back.day === j.day ? iso : null;
}

const FA_DIGIT = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (s: string) => s.replace(/\d/g, d => FA_DIGIT[Number(d)]!);

/** ISO میلادی → متن فیلد جلالی «۱۴۰۵/۰۶/۱۰» (رقم فارسی، ماه و روز دورقمی). */
export function jalaliInputOf(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const j = toJalali(iso);
  return faDigits(`${j.year}/${String(j.month).padStart(2, "0")}/${String(j.day).padStart(2, "0")}`);
}

export type JalaliInput =
  | { kind: "ok"; iso: string }
  | { kind: "incomplete"; message: string }
  | { kind: "invalid"; message: string };

const INCOMPLETE = "تاریخ را به شکل ۱۴۰۵/۰۶/۱۰ کامل کنید.";

/**
 * متن فیلد تاریخ جلالی. رقم فارسی، عربی یا لاتین؛ جداکنندهٔ «/» یا «-» یا «.».
 * «ناقص» (هنوز در حال تایپ) از «ناموجود» (۳۰ اسفند ۱۴۰۴، ماه ۱۳، سال میلادی)
 * جداست تا پیام درست کنار فیلد بنشیند؛ هیچ‌کدام درخواستی نمی‌سازند.
 */
export function parseJalaliDate(text: string): JalaliInput {
  const s = normalizeDigits(text);
  const m = JALALI_COMPLETE.exec(s);
  if (!m) {
    return JALALI_PARTIAL.test(s) ? { kind: "incomplete", message: INCOMPLETE }
      : { kind: "invalid", message: "فقط تاریخ جلالی با رقم، مثل ۱۴۰۵/۰۶/۱۰." };
  }
  const j = { year: Number(m[1] ?? m[4]), month: Number(m[2] ?? m[5]), day: Number(m[3] ?? m[6]) };
  if (j.year < MIN_YEAR || j.year > MAX_YEAR) return { kind: "invalid", message: "سال را جلالی وارد کنید، مثل ۱۴۰۵." };
  const iso = jalaliToIso(j);
  return iso === null ? { kind: "invalid", message: "این تاریخ در تقویم جلالی وجود ندارد." } : { kind: "ok", iso };
}

/**
 * بازهٔ دو فیلد جلالی: ISO هر دو سر (اگر معتبرند) و خطای کنار فیلد.
 * `issue === null` یعنی بازه کامل، واقعی و مرتب است و می‌شود فرستاد.
 */
export function readJalaliPeriod(fromText: string, toText: string): { from: string | null; to: string | null; issue: PeriodIssue } {
  const f = parseJalaliDate(fromText), t = parseJalaliDate(toText);
  const from = f.kind === "ok" ? f.iso : null, to = t.kind === "ok" ? t.iso : null;
  if (f.kind !== "ok") return { from, to, issue: { field: "from", message: f.message } };
  if (t.kind !== "ok") return { from, to, issue: { field: "to", message: t.message } };
  return { from, to, issue: periodIssue(f.iso, t.iso) };
}
