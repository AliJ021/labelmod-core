/**
 * مقیاس عمودی نمودار — فقط `bigint`، بی عدد اعشاری (test/chart-scale.test.ts).
 *
 * گام «گرد» (۱، ۲ یا ۵ ضرب در توانی از ده) طوری که بازه در حدود چهار فاصله جا شود. مرزها
 * از گام ساخته می‌شوند و **همیشه صفر را در بر دارند**؛ منفی (مرجوعی، زیان) زیر صفر می‌ماند و
 * نه صفر می‌شود نه قدرمطلق. همه صفر یا بی داده: فقط صفر.
 */
export interface Scale { min: bigint; max: bigint; ticks: bigint[] }

export function niceScale(values: readonly bigint[], intervals = 4): Scale {
  let lo = 0n, hi = 0n;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === 0n && hi === 0n) return { min: 0n, max: 0n, ticks: [0n] };
  const rough = (hi - lo + BigInt(intervals) - 1n) / BigInt(intervals);
  let step = 1n;
  while (step * 10n <= rough) step *= 10n;
  for (const m of [1n, 2n, 5n, 10n]) { if (step * m >= rough) { step *= m; break; } }
  const floor = (v: bigint) => (v >= 0n ? (v / step) * step : -((-v + step - 1n) / step) * step);
  const ceil = (v: bigint) => (v <= 0n ? -((-v / step) * step) : ((v + step - 1n) / step) * step);
  const min = floor(lo), max = ceil(hi);
  const ticks: bigint[] = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  return { min, max, ticks };
}
