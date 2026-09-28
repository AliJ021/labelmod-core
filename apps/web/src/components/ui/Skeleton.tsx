/**
 * جای‌نگهدار بارگذاری با شکل همان محتوا — نه چرخندهٔ بی‌شکل.
 *
 * خودش پنهان از صفحه‌خوان است؛ `label` یک پیام وضعیت یگانه می‌سازد.
 * در کاهش حرکت، درخشش متوقف می‌شود و شکل می‌ماند.
 */
export function Skeleton({ lines = 3, label, variant = "text" }: { lines?: number; label?: string; variant?: "text" | "kpi" | "chart" | "row" }) {
  return <div className={`skeleton-group skeleton-group--${variant}`}>
    {label ? <p className="sr-only" role="status">{label}</p> : null}
    {Array.from({ length: lines }, (_, i) => <span key={i} className={`skeleton skeleton--${variant}`} aria-hidden="true" />)}
  </div>;
}
