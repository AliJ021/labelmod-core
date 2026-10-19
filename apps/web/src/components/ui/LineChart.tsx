import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { moneyParts } from "../../lib/format.ts";
import { niceScale } from "../../lib/chart-scale.ts";

/**
 * نمودار خطی سبک — بدون کتابخانه، روی سطح **مات** (palette.test.ts: رنگ
 * نمودار روی شیشه به ۳:۱ نمی‌رسد). چند خط ساده روی یک محور زمان.
 *
 * - مقدار پولی `bigint` می‌ماند؛ فقط **موقعیت عمودی** عدد اعشاری است و هیچ
 *   مبلغی از آن ساخته نمی‌شود. مقدار دقیق هر نقطه در «بازخوانی» زیر نمودار، در
 *   جدول (پنهان برای صفحه‌خوان یا آشکار با «نمایش جدول») می‌آید.
 * - **RTL:** نقطهٔ اول (قدیمی‌تر) سمت راست است؛ SVG جهت ندارد، پس x وارونه
 *   حساب می‌شود و برچسب‌های HTML با `inset-inline-start` همان جا می‌نشینند.
 * - مقیاس مشترک از `niceScale` (گام گرد، همیشه با صفر)؛ خط صفر وقتی منفی هست
 *   دیده می‌شود. منفی نه صفر می‌شود و نه قدرمطلق. واحد محور «تومان» صریح است.
 * - `null` یعنی «هنوز نیامده»: خط آنجا قطع می‌شود، نه اینکه به صفر برود. میان دو
 *   نقطه فقط پارهٔ خط راست است — بی منحنی هموار و بی «بیش‌جهش» ساختگی.
 *   نقطهٔ `partial` (دورهٔ جاری) توخالی است.
 * - رنگ تنها حامل معنا نیست: هر خط الگوی خط خودش را هم دارد و در راهنما با برچسب آمده.
 * - **بررسی نقطه‌ها:** یک توقف Tab؛ پیکان‌ها (RTL: چپ = بعدی)، Home/End، و لمس/کشیدن
 *   یا هاور نقطه را انتخاب می‌کنند و بازخوانی دیدنی و `aria-live` مقدار همهٔ خطوط را می‌گوید.
 * - نقطه یک مسیر صفرطول با سر گرد است و `vector-effect` دارد، پس با کشیدگیِ
 *   `preserveAspectRatio="none"` بیضی نمی‌شود.
 */
export interface LinePoint { key: string; label: string; long: string; partial: boolean; tick: boolean }
export interface LineSeries { key: string; label: string; values: readonly (bigint | null)[]; displays: readonly string[]; emphasis: boolean }

const W = 600, H = 200, MX = 8, MY = 10;

export function LineChart({ title, summary, note, xHeader, points, series, unit = "تومان" }: {
  title: string; summary: string; note: string | null; xHeader: string;
  points: readonly LinePoint[]; series: readonly LineSeries[]; unit?: string;
}) {
  const id = useId();
  const n = points.length;
  const all = series.flatMap(s => s.values.filter((v): v is bigint => v !== null));
  const scale = niceScale(all);
  const min = scale.min;
  const max = scale.max === scale.min ? scale.min + 1n : scale.max; // همه صفر: خط روی صفرِ پایین.
  const span = max - min;
  /** کسر افقی از «شروع» (راست در RTL). */
  const fx = (i: number) => (n === 1 ? 0.5 : (MX + (i / (n - 1)) * (W - 2 * MX)) / W);
  /** کسر عمودی از بالا؛ فقط موقعیت، نه مبلغ. */
  const fy = (v: bigint) => (MY + (Number(((max - v) * 10000n) / span) / 10000) * (H - 2 * MY)) / H;
  const X = (i: number) => (W * (1 - fx(i))).toFixed(1);
  const Y = (v: bigint) => (H * fy(v)).toFixed(1);
  const ticksBefore = (i: number) => points.slice(0, i).filter(p => p.tick).length;
  /** آخرین نقطه‌ای که دست‌کم یک خط مقدار دارد — پیش‌فرض بازخوانی (نه ساعتی که هنوز نیامده). */
  const lastReached = (() => {
    for (let i = n - 1; i >= 0; i--) if (series.some(s => s.values[i] !== null)) return i;
    return n - 1;
  })();
  const [chosen, setChosen] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const active = chosen !== null && chosen < n ? chosen : lastReached;
  const at = points[active];

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let next: number | null = null;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = Math.min(n - 1, active + 1);
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = Math.max(0, active - 1);
    if (next !== null) { e.preventDefault(); setChosen(next); }
  }
  function onPointer(e: PointerEvent<HTMLDivElement>) {
    if (e.type === "pointermove" && e.pointerType !== "mouse" && e.buttons === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || n === 0) return;
    // x از چپ؛ نقطهٔ i در (1 − fx(i)) از چپ است (RTL).
    const fromStart = 1 - (e.clientX - r.left) / r.width;
    const i = n === 1 ? 0 : Math.round(((fromStart * W - MX) / (W - 2 * MX)) * (n - 1));
    setChosen(Math.max(0, Math.min(n - 1, i)));
  }

  const readout = at ? `${at.long}${at.partial ? " (ناقص)" : ""}: ${series.map(s => `${s.label} ${s.displays[active]}`).join(" · ")}` : "";
  const table = <table className={showTable ? "line-chart-table" : undefined}>
    <caption>{title}</caption>
    <thead><tr><th scope="col">{xHeader}</th>{series.map(s => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
    <tbody>{points.map((p, i) => <tr key={p.key}>
      <th scope="row">{p.long}{p.partial ? " (ناقص)" : ""}</th>
      {series.map(s => <td key={s.key}>{s.displays[i]}</td>)}
    </tr>)}</tbody>
  </table>;

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
    <div className="line-chart-frame">
      <span className="line-chart-unit" aria-hidden="true">{unit}</span>
      <div className="line-chart-plot" role="group" tabIndex={0}
        aria-label={`${title} — بررسی نقطه‌ها با کلیدهای جهت، Home و End`} aria-describedby={`${id}-r`}
        onKeyDown={onKey} onPointerDown={onPointer} onPointerMove={onPointer}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="line-chart-svg" aria-hidden="true">
          {scale.ticks.map(t => <path key={String(t)} className={t === 0n ? "line-chart-zero" : "line-chart-grid"} d={`M0 ${Y(t)} H${W}`} />)}
          {at ? <path className="line-chart-cursor" d={`M${X(active)} 0 V${H}`} /> : null}
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
                const dot = `M${X(i)} ${Y(v)} h0`, partial = points[i]!.partial;
                return <g key={points[i]!.key}>
                  <path className={`line-chart-dot${partial ? " is-partial" : ""}${i === active ? " is-active" : ""}`}
                    data-sign={v < 0n ? "negative" : v > 0n ? "positive" : "zero"} d={dot} />
                  {partial ? <path className="line-chart-dot-hole" d={dot} /> : null}
                </g>;
              })}
            </g>;
          })}
        </svg>
        {scale.ticks.map(v => {
          const p = moneyParts(v, true);
          return <span key={String(v)} className="line-chart-y" aria-hidden="true" style={{ "--y": fy(v) } as React.CSSProperties}>
            {/* رقم و علامت در برگ LTR، مقیاس بیرونش — وگرنه «−500» در RTL «500−» دیده می‌شد. */}
            <bdi className="num">{p.sign === "negative" ? "−" : ""}{p.digits}</bdi>{p.scale ? ` ${p.scale}` : ""}
          </span>;
        })}
      </div>
    </div>
    <div className="line-chart-x" aria-hidden="true">
      {/* در عرض باریک، برچسب‌های یک‌درمیان (نه اولی و آخری) پنهان می‌شوند تا روی هم نیفتند. */}
      {points.map((p, i) => p.tick ? <span key={p.key} data-minor={(i > 0 && i < n - 1 && ticksBefore(i) % 2 === 1) || undefined}
        style={{ "--x": fx(i) } as React.CSSProperties}>{p.label}</span> : null)}
    </div>
    <p id={`${id}-r`} className="line-chart-readout" aria-live="polite">{readout}</p>
    {note ? <p className="line-chart-note">{note}</p> : null}
    <button type="button" className="link line-chart-table-toggle" aria-expanded={showTable} aria-controls={`${id}-table`}
      onClick={() => setShowTable(v => !v)}>{showTable ? "پنهان‌کردن جدول داده" : "نمایش جدول داده"}</button>
    {/* پنهان: ظرف sr-only، نه خودِ جدول — جدول چندستونی از عرض ۱px بزرگ‌تر می‌شود و صفحه را افقی می‌کشید.
        آشکار: در ظرف با اسکرول افقی خودش، نه صفحه. یک جدول است، نه دو نسخه. */}
    <div id={`${id}-table`} className={showTable ? "line-chart-table-wrap" : "sr-only"}>{table}</div>
  </figure>;
}

/** برچسب محور: حداکثر حدود هشت برچسب، اولی و آخری همیشه. */
export function tickEvery(n: number, max = 8): (i: number) => boolean {
  const step = Math.max(1, Math.ceil(n / max));
  return i => i === 0 || i === n - 1 || (i % step === 0 && n - 1 - i >= step / 2);
}
