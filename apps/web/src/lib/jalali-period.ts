/**
 * مرزهای دوره در تقویم جلالی.
 *
 * ── چرا این فایل وجود دارد ─────────────────────────────────────────
 *
 * `sales.report_compare` دو بازه می‌گیرد و هیچ‌کدام را خودش حساب
 * نمی‌کند. عمدی است: مالک این فروشگاه تاریخ را **جلالی** می‌بیند، و
 * «یک ماه قبلِ» میلادی با آن نمی‌خواند. ۳۱ مرداد منهای یک ماه میلادی
 * وسط تیر می‌افتد — عددی که با تقویم خودش نمی‌خواند و هیچ خطایی هم
 * نمی‌دهد.
 *
 * پس محاسبه پول در SQL می‌ماند و **انتخاب دوره** اینجا، جایی که
 * تقویم را می‌فهمد.
 *
 * ── چرا Intl و نه حساب دستی ────────────────────────────────────────
 *
 * تبدیل جلالی↔میلادی الگوریتم کبیسه‌ای دارد که نوشتنش آسان و درست
 * نوشتنش سخت است؛ یک اشتباه در سال کبیسه، یک روزِ کل سال را جابه‌جا
 * می‌کند و فقط چند سال یک بار دیده می‌شود. `Intl` با تقویم `persian`
 * همان جدولی را دارد که مرورگر برای نمایش تاریخ استفاده می‌کند — پس
 * عددی که اینجا حساب می‌شود با تاریخی که کاربر روی صفحه می‌بیند
 * **قطعاً** یکی است.
 *
 * جهت معکوس (جلالی → میلادی) با جست‌وجوی کراندار انجام می‌شود، نه با
 * فرمول: از یک نقطه نزدیک شروع و چند روز اطراف را می‌گردد. کندتر
 * است و در یک انتخاب دوره اصلاً به چشم نمی‌آید.
 */

/** یک تاریخ جلالی. ماه از ۱ تا ۱۲. */
export interface Jalali {
  year: number;
  month: number;
  day: number;
}

// `timeZone: "UTC"` عمدی است: ورودی و خروجی این فایل «تاریخ» است نه
// «لحظه». بدون آن، مرورگرِ کاربر با منطقه زمانی دیگر می‌توانست همان
// رشته را یک روز جابه‌جا بخواند.
const FMT = new Intl.DateTimeFormat("en-US-u-ca-persian", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` میلادی → تاریخ جلالی. */
export function toJalali(iso: string): Jalali {
  const parts = FMT.formatToParts(new Date(`${iso}T12:00:00Z`));
  const pick = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * تاریخ جلالی → `YYYY-MM-DD` میلادی.
 *
 * اگر آن روز در آن ماه وجود نداشته باشد (۳۱ اسفند، یا ۳۱ در ماهی
 * ۳۰روزه) به **آخرین روز همان ماه** گرد می‌شود، نه به روز اول ماه
 * بعد. «۳۱ آبان» که وجود ندارد یعنی ۳۰ آبان، نه ۱ آذر.
 */
export function fromJalali(j: Jalali, near: string): string | null {
  const base = new Date(`${near}T12:00:00Z`).getTime();
  let best: { ms: number; day: number } | null = null;

  // ۴۵ روز اطراف نقطه شروع: هر ماه جلالی حداکثر ۳۱ روز است، پس این
  // پنجره همیشه کل ماه هدف را در بر می‌گیرد.
  for (let d = -45; d <= 45; d += 1) {
    const ms = base + d * DAY_MS;
    const c = toJalali(isoOf(ms));
    if (c.year !== j.year || c.month !== j.month) continue;
    if (c.day === j.day) return isoOf(ms);
    // نگه‌داشتن بزرگ‌ترین روزِ موجود، برای وقتی روز خواسته‌شده نیست.
    if (c.day < j.day && (best === null || c.day > best.day)) {
      best = { ms, day: c.day };
    }
  }
  return best === null ? null : isoOf(best.ms);
}

/** اولین و آخرین روزِ ماه جلالیِ شاملِ این تاریخ. */
export function jalaliMonthRange(iso: string): { from: string; to: string } {
  const j = toJalali(iso);
  const from = fromJalali({ ...j, day: 1 }, iso) ?? iso;
  // روز ۳۲ وجود ندارد، پس `fromJalali` آخرین روز واقعی ماه را می‌دهد.
  const to = fromJalali({ ...j, day: 32 }, iso) ?? iso;
  return { from, to };
}

/**
 * همان روز، یک ماه جلالی قبل‌تر.
 *
 * ماهِ ۱ به ماه ۱۲ سال قبل می‌رود. اگر آن روز در ماه مقصد نباشد
 * (۳۱ فروردین → اسفند ۲۹ یا ۳۰ روزه)، آخرین روز همان ماه.
 */
export function sameDayPreviousJalaliMonth(iso: string): string {
  const j = toJalali(iso);
  const target: Jalali =
    j.month === 1
      ? { year: j.year - 1, month: 12, day: j.day }
      : { ...j, month: j.month - 1 };
  // نقطه شروع جست‌وجو: حدود ۳۰ روز عقب‌تر.
  const near = isoOf(new Date(`${iso}T12:00:00Z`).getTime() - 30 * DAY_MS);
  return fromJalali(target, near) ?? iso;
}

/**
 * دوره مبنا برای یک بازه دلخواه.
 *
 * قاعده: **هر دو مرز یک ماه جلالی عقب می‌روند.** برای یک روز، همان
 * روزِ ماه قبل؛ برای یک ماه کامل، ماه قبل؛ برای یک بازه دلخواه، همان
 * بازه یک ماه عقب‌تر. یک قاعده، نه سه حالت.
 */
export function previousPeriod(p: { from: string; to: string }): {
  from: string;
  to: string;
} {
  return {
    from: sameDayPreviousJalaliMonth(p.from),
    to: sameDayPreviousJalaliMonth(p.to),
  };
}
