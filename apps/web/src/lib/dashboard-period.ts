/**
 * مرور دوره در داشبورد (دستهٔ B) — منطق خالص، بی React (test/dashboard-period.test.ts).
 *
 * مرزها اینجا حساب می‌شوند و جمع پول در SQL (`/reports/dashboard/period`، ۰۹۹)؛ همان
 * تقسیم کار `/reports/compare`: ماه جلالی را مرورگر می‌فهمد، نه سرور.
 *
 * دورهٔ مبنا همیشه **پیش از** دوره است و با آن هم‌پوشانی ندارد (سرور هم رد می‌کند):
 *   ۷ / ۳۰ روز اخیر  → همان شمار روزِ بلافاصله پیش از آن
 *   این ماه (تا امروز) → همان روزهای ماه جلالی قبل (۱ تا همان روز، با سقف پایان ماه)
 *   ماه قبل (کامل)     → ماه جلالی پیش از آن، کامل
 */
import { addDays } from "./dashboard-trend.ts";
import { jalaliMonthRange, previousPeriod, sameDayPreviousJalaliMonth } from "./jalali-period.ts";

export type PeriodPreset = "7d" | "30d" | "month" | "lastMonth";

export const PERIOD_PRESETS: readonly { key: PeriodPreset; label: string }[] = [
  { key: "7d", label: "۷ روز اخیر" },
  { key: "30d", label: "۳۰ روز اخیر" },
  { key: "month", label: "این ماه" },
  { key: "lastMonth", label: "ماه قبل" },
];

export interface PeriodRange { from: string; to: string; prevFrom: string; prevTo: string }

/** مرزهای دوره و دورهٔ مبنا؛ `today` روز کاری از سرور است، نه ساعت مرورگر. */
export function periodRange(preset: PeriodPreset, today: string): PeriodRange {
  if (preset === "7d" || preset === "30d") {
    const n = preset === "7d" ? 7 : 30;
    const from = addDays(today, -(n - 1));
    return { from, to: today, prevFrom: addDays(from, -n), prevTo: addDays(from, -1) };
  }
  if (preset === "month") {
    const { from } = jalaliMonthRange(today);
    const prev = previousPeriod({ from, to: today });
    return { from, to: today, prevFrom: prev.from, prevTo: prev.to };
  }
  const last = jalaliMonthRange(sameDayPreviousJalaliMonth(jalaliMonthRange(today).from));
  const before = jalaliMonthRange(sameDayPreviousJalaliMonth(last.from));
  return { from: last.from, to: last.to, prevFrom: before.from, prevTo: before.to };
}

/** شمار روزهای یک بازهٔ بسته. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * جهت یک تفاضل bigint برای متن «بیشتر/کمتر» — نه درصد. صفر «بدون تغییر» است؛
 * تفاضل از سرور می‌آید و اینجا فقط علامتش خوانده می‌شود.
 */
export function deltaDirection(delta: string): "up" | "down" | "flat" {
  const v = BigInt(delta);
  return v > 0n ? "up" : v < 0n ? "down" : "flat";
}

/** قدر مطلق یک تفاضل رشته‌ای، برای نمایش کنار «بیشتر/کمتر». */
export function deltaMagnitude(delta: string): bigint {
  const v = BigInt(delta);
  return v < 0n ? -v : v;
}
