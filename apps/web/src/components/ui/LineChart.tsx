import { useId } from "react";
import { moneyParts } from "../../lib/format.ts";

/**
 * نمودار خطی سبک — بدون کتابخانه، روی سطح **مات** (palette.test.ts: رنگ
 * نمودار روی شیشه به ۳:۱ نمی‌رسد). چند خط ساده روی یک محور زمان.
 *
 * - مقدار پولی `bigint` می‌ماند؛ فقط **موقعیت عمودی** عدد اعشاری است و هیچ
 *   مبلغی از آن ساخته نمی‌شود. مقدار دقیق هر نقطه در جدول صفحه‌خوان و در
 *   راهنمای هاور می‌آید. کل نمودار یک `figure` با شرح است و توقف Tab نمی‌سازد.
 * - **RTL:** نقطهٔ اول (قدیمی‌تر) سمت راست است؛ SVG جهت ندارد، پس x وارونه
 *   حساب می‌شود و برچسب‌های HTML با `inset-inline-start` همان جا می‌نشینند.
 * - مقیاس مشترک است و همیشه صفر را در بر دارد؛ خط صفر وقتی منفی هست دیده
 *   می‌شود. منفی نه صفر می‌شود و نه قدرمطلق.
 * - `null` یعنی «هنوز نیامده»: خط آنجا قطع می‌شود، نه اینکه به صفر برود.
 *   نقطهٔ `partial` (دورهٔ جاری) توخالی است.
 * - رنگ تنها حامل معنا نیست: هر خط الگوی خط خودش را هم دارد و در راهنما
 *   با برچسب آمده.
 * - نقطه یک مسیر صفرطول با سر گرد است و `vector-effect` دارد، پس با کشیدگیِ
 *   `preserveAspectRatio="none"` بیضی نمی‌شود.
 */
export interface LinePoint { key: string; label: string; long: string; partial: boolean; tick: boolean }
export interface LineSeries { key: string; label: string; values: readonly (bigint | null)[]; displays: readonly string[]; emphasis: boolean }

const W = 600, H = 200, MX = 8, MY = 10;

export function LineChart({ title, summary, note, xHeader, points, series }: {
  title: string; summary: string; note: string | null; xHeader: string;
  points: readonly LinePoint[]; series: readonly LineSeries[];
}) {
  const id = useId();
  const all = series.flatMap(s => s.values.filter((v): v is bigint => v !== null));
  let max = all.reduce((m, v) => (v > m ? v : m), 0n);
  const min = all.reduce((m, v) => (v < m ? v : m), 0n);
  if (max === min) max = min + 1n; // همه صفر: خط روی صفرِ پایین.
  const span = max - min;
  const n = points.length;
  /** کسر افقی از «شروع» (راست در RTL). */
  const fx = (i: number) => (n === 1 ? 0.5 : (MX + (i / (n - 1)) * (W - 2 * MX)) / W);
  /** کسر عمودی از بالا؛ فقط موقعیت، نه مبلغ. */
  const fy = (v: bigint) => (MY + (Number(((max - v) * 10000n) / span) / 10000) * (H - 2 * MY)) / H;
  const X = (i: number) => (W * (1 - fx(i))).toFixed(1);
  const Y = (v: bigint) => (H * fy(v)).toFixed(1);
  const ticksBefore = (i: number) => points.slice(0, i).filter(p => p.tick).length;
  // برچسب محور عمودی: بیشینه، صفر و کمینه (بی تکرار). همه صفر: فقط صفر.
  const ticks = all.every(v => v === 0n) ? [0n] : [...new Set([max, 0n, min])];

  return <figure className="line-chart" aria-labelledby={`${id}-t`}>
    <figcaption>
      <span id={`${id}-t`} className="line-chart-title">{title}</span>
      <span className="line-chart-summary">{summary}</span>
    </figcaption>
    <ul className="line-chart-legend" aria-hidden="true">
      {series.map(s => <li key={s.key} data-series={s.key} data-emphasis={s.emphasis || undefined}>
        <svg viewBox="0 0 24 8" className="line-chart-swatch"><path d="M1 4 H23" /></svg>{s.label}
      </li>)}
    </ul>
    <div className="line-chart-plot" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="line-chart-svg">
        <path className="line-chart-grid" d={`M0 ${Y(max)} H${W} M0 ${Y(min)} H${W}`} />
        {min < 0n ? <path className="line-chart-zero" d={`M0 ${Y(0n)} H${W}`} /> : null}
        {series.map(s => {
          let d = "", open = false;
          s.values.forEach((v, i) => {
            if (v === null) { open = false; return; }
            d += `${open ? "L" : "M"}${X(i)} ${Y(v)} `;
            open = true;
          });
          return <g key={s.key} data-series={s.key} data-emphasis={s.emphasis || undefined}>
            <path className="line-chart-line" d={d.trim()} />
            {s.values.map((v, i) => {
              if (v === null) return null;
              const at = `M${X(i)} ${Y(v)} h0`, partial = points[i]!.partial;
              return <g key={points[i]!.key}>
                <path className={`line-chart-dot${partial ? " is-partial" : ""}`} data-sign={v < 0n ? "negative" : v > 0n ? "positive" : "zero"} d={at} />
                {partial ? <path className="line-chart-dot-hole" d={at} /> : null}
              </g>;
            })}
          </g>;
        })}
      </svg>
      {ticks.map(v => {
        const p = moneyParts(v, true);
        return <span key={String(v)} className="line-chart-y" style={{ "--y": fy(v) } as React.CSSProperties}>
          {p.sign === "negative" ? "−" : ""}{p.digits}{p.scale ? ` ${p.scale}` : ""}
        </span>;
      })}
      {points.map((p, i) => <span key={p.key} className="line-chart-hit" style={{ "--x": fx(i), "--w": 1 / Math.max(n, 1) } as React.CSSProperties}
        data-tip={`${p.long}: ${series.map(s => `${s.label} ${s.displays[i]}`).join(" · ")}`} />)}
    </div>
    <div className="line-chart-x" aria-hidden="true">
      {/* در عرض باریک، برچسب‌های یک‌درمیان (نه اولی و آخری) پنهان می‌شوند تا روی هم نیفتند. */}
      {points.map((p, i) => p.tick ? <span key={p.key} data-minor={(i > 0 && i < n - 1 && ticksBefore(i) % 2 === 1) || undefined}
        style={{ "--x": fx(i) } as React.CSSProperties}>{p.label}</span> : null)}
    </div>
    {note ? <p className="line-chart-note">{note}</p> : null}
    {/* ظرف sr-only، نه خودِ جدول: جدول چندستونی از عرض ۱px بزرگ‌تر می‌شود و صفحه را افقی می‌کشید. */}
    <div className="sr-only"><table>
      <caption>{title}</caption>
      <thead><tr><th scope="col">{xHeader}</th>{series.map(s => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
      <tbody>{points.map((p, i) => <tr key={p.key}>
        <th scope="row">{p.long}{p.partial ? " (ناقص)" : ""}</th>
        {series.map(s => <td key={s.key}>{s.displays[i]}</td>)}
      </tr>)}</tbody>
    </table></div>
  </figure>;
}

/** برچسب محور: حداکثر حدود هشت برچسب، اولی و آخری همیشه. */
export function tickEvery(n: number, max = 8): (i: number) => boolean {
  const step = Math.max(1, Math.ceil(n / max));
  return i => i === 0 || i === n - 1 || (i % step === 0 && n - 1 - i >= step / 2);
}
