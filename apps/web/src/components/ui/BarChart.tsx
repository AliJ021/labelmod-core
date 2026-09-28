import { useId } from "react";

/**
 * نمودار ستونی سبک — بدون کتابخانه، روی سطح **مات** (palette.test.ts:
 * رنگ نمودار روی شیشه به ۳:۱ نمی‌رسد).
 *
 * داده از سرور است و مقدار پولی `bigint` می‌ماند؛ فقط **نسبت ارتفاع**
 * عدد اعشاری است و هیچ مبلغی از آن ساخته نمی‌شود. مقدار دقیق هر ستون
 * در جدول پنهانِ صفحه‌خوان و در راهنمای هاور/فوکوس می‌آید. ستون‌ها یک
 * توقف Tab نمی‌سازند؛ کل نمودار یک `figure` با شرح است.
 *
 * رشد ستون فقط `transform: scaleY` است و در کاهش حرکت حذف می‌شود.
 */
export interface Bar { key: string; label: string; value: bigint; display: string }

export function BarChart({ title, summary, bars, valueHeader, labelHeader }: {
  title: string; summary: string; bars: readonly Bar[]; valueHeader: string; labelHeader: string;
}) {
  const id = useId();
  const max = bars.reduce((m, b) => (b.value > m ? b.value : m), 0n);
  return <figure className="bar-chart" aria-labelledby={`${id}-t`}>
    <figcaption>
      <span id={`${id}-t`} className="bar-chart-title">{title}</span>
      <span className="bar-chart-summary">{summary}</span>
    </figcaption>
    <div className="bar-chart-plot" aria-hidden="true">
      {bars.map(b => {
        const ratio = max > 0n && b.value > 0n ? Math.max(0.03, Number((b.value * 1000n) / max) / 1000) : 0;
        return <div key={b.key} className="bar-chart-col" data-tip={`${b.label}: ${b.display}`}>
          <span className={`bar-chart-bar${ratio === 0 ? " is-zero" : ""}`} style={{ "--bar": ratio } as React.CSSProperties} />
          <span className="bar-chart-label">{b.label}</span>
        </div>;
      })}
    </div>
    <table className="sr-only">
      <caption>{title}</caption>
      <thead><tr><th scope="col">{labelHeader}</th><th scope="col">{valueHeader}</th></tr></thead>
      <tbody>{bars.map(b => <tr key={b.key}><th scope="row">{b.label}</th><td>{b.display}</td></tr>)}</tbody>
    </table>
  </figure>;
}
