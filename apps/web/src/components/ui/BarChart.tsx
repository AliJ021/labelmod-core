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
 *
 * **مقدار منفی** (ساعت مرجوعی، فروش زیر بها، بازپرداخت) نه صفر می‌شود و نه
 * قدرمطلق: وقتی دست‌کم یک ستون منفی است، نمودار «علامت‌دار» می‌شود — خط صفر
 * وسط، مثبت بالای آن و منفی زیرش، با یک مقیاس مشترک. سهم ارتفاع بالا و پایین
 * از بیشینهٔ هر سو می‌آید، پس ستون ۱٬۰۰۰ بالا و ستون −۱٬۰۰۰ پایین هم‌قد‌اند.
 * جدول صفحه‌خوان و راهنما همان `display` با علامت «−» را می‌خوانند. بی مقدار
 * منفی، خروجی همان نمودار پیشین است.
 */
export interface Bar { key: string; label: string; value: bigint; display: string }

export function BarChart({ title, summary, bars, valueHeader, labelHeader }: {
  title: string; summary: string; bars: readonly Bar[]; valueHeader: string; labelHeader: string;
}) {
  const id = useId();
  const max = bars.reduce((m, b) => (b.value > m ? b.value : m), 0n);
  const min = bars.reduce((m, b) => (b.value < m ? b.value : m), 0n);
  const signed = min < 0n;
  // نسبت فقط برای ارتفاع است؛ هیچ مبلغی از آن ساخته نمی‌شود.
  const ratio = (value: bigint, extreme: bigint) =>
    extreme === 0n || value === 0n ? 0 : Math.max(0.03, Number((value * 1000n) / extreme) / 1000);
  if (signed) {
    const span = max - min;
    const up = Number((max * 1000n) / span) / 1000;
    return <figure className="bar-chart bar-chart--signed" aria-labelledby={`${id}-t`}>
      <figcaption>
        <span id={`${id}-t`} className="bar-chart-title">{title}</span>
        <span className="bar-chart-summary">{summary}</span>
      </figcaption>
      <div className="bar-chart-plot" aria-hidden="true" style={{ "--up": up, "--down": 1 - up } as React.CSSProperties}>
        {bars.map(b => <div key={b.key} className="bar-chart-col" data-tip={`${b.label}: ${b.display}`} data-sign={b.value < 0n ? "negative" : b.value > 0n ? "positive" : "zero"}>
          <span className="bar-chart-half bar-chart-half--up">
            {b.value > 0n ? <span className="bar-chart-bar" style={{ "--bar": ratio(b.value, max) } as React.CSSProperties} /> : null}
          </span>
          <span className="bar-chart-half bar-chart-half--down">
            {b.value < 0n ? <span className="bar-chart-bar bar-chart-bar--negative" style={{ "--bar": ratio(-b.value, -min) } as React.CSSProperties} /> : null}
          </span>
          <span className="bar-chart-label">{b.label}</span>
        </div>)}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">{labelHeader}</th><th scope="col">{valueHeader}</th></tr></thead>
        <tbody>{bars.map(b => <tr key={b.key}><th scope="row">{b.label}</th><td>{b.display}</td></tr>)}</tbody>
      </table>
    </figure>;
  }
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
