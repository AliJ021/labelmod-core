import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Solid } from "../Glass.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { StatusIcon, type StatusState } from "./Status.tsx";

/**
 * شاخص — همیشه با برچسب صریح (design.md: فروش · وجه دریافتی · سود).
 *
 * `value` معمولاً `<Money/>` است؛ «—» یعنی نمی‌دانیم یا اجازه نیست، نه صفر.
 *
 * `band` (پیش‌فرض داشبورد): ستونی درون یک سطح مات مشترک که با خط جدا
 * می‌شود، نه کارت جدا. `card` فقط وقتی شاخص تنها و مستقل است.
 */
export function Kpi({ label, value, note, state, icon, emphasis = false, variant = "band" }: {
  label: string; value: ReactNode; note: ReactNode; state?: StatusState | undefined; icon?: IconName | undefined; emphasis?: boolean; variant?: "band" | "card";
}) {
  const body = <>
    <div className="kpi-head">
      <span className="kpi-label">{label}</span>
      {icon ? <span className="kpi-icon"><Icon name={icon} size="sm" /></span> : null}
    </div>
    <div className="kpi-value">{value}</div>
    <p className="kpi-note">{state ? <StatusIcon state={state} /> : null}<span>{note}</span></p>
  </>;
  const cls = `kpi kpi--${variant}${emphasis ? " kpi--emphasis" : ""}`;
  return variant === "card"
    ? <Solid as="section" className={cls} aria-label={label}>{body}</Solid>
    : <section className={cls} aria-label={label}>{body}</section>;
}

/**
 * شاخص‌های انتخاب‌شدنی — یک نوار شاخص که **یک** پنل جزئیات مشترک را عوض
 * می‌کند (داشبورد: فروش · وجه دریافتی · سود). ظاهر همان نوار `band` است؛ فقط
 * وعدهٔ بصریِ «زبانه» را واقعی می‌کند.
 *
 * - `role="tablist"`/`"tab"` روی `button` بومی (Enter و Space رایگان)، با
 *   `aria-selected` و `aria-controls` به پنل مشترک. نام زبانه فقط برچسب است
 *   (`aria-labelledby`)؛ مقدار و یادداشت توضیح آن‌اند (`aria-describedby`)،
 *   پس عدد شاخص خوانده می‌شود بی‌آنکه نام زبانه با هر تغییر عدد عوض شود.
 * - کیبورد همان قرارداد `TabList`: فعال‌سازی دستی، پیکان‌ها با جهت محاسبه‌شده
 *   (RTL: چپ = بعدی)، Home/End؛ فقط زبانهٔ فعال در ترتیب Tab است.
 * - نشانگر طلایی بالای زبانهٔ انتخاب‌شده می‌نشیند (شکل + وزن برچسب، نه فقط
 *   رنگ) و جابه‌جایی‌اش فقط `opacity`/`transform` است.
 * - زبانهٔ `unavailable` (مثلاً سود بی `cost.view`) `aria-disabled` است:
 *   دیده و خوانده می‌شود و دلیلش در یادداشت است، ولی انتخاب نمی‌شود و
 *   پنل هرگز محتوای آن را نشان نمی‌دهد.
 */
export interface KpiTab<K extends string> {
  key: K; label: string; value: ReactNode; note: ReactNode; state?: StatusState; icon?: IconName;
  /** اندازهٔ شاخص اصلی (فروش) — مستقل از انتخاب، تا جابه‌جایی زبانه چیدمان را نپراند. */
  primary?: boolean;
  unavailable?: boolean;
}

export function KpiTabs<K extends string>({ items, value, onChange, label, panelId, idPrefix }: {
  items: readonly KpiTab<K>[]; value: K; onChange: (key: K) => void; label: string; panelId: string; idPrefix: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<K>(value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const tabs = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])];
    const current = tabs.indexOf(e.currentTarget);
    let next: number | undefined;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (current + 1) % tabs.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (current - 1 + tabs.length) % tabs.length;
    if (next !== undefined) { e.preventDefault(); tabs[next]?.focus(); }
  };
  return <div ref={root} className="kpis kpis--band kpis--tabs" role="tablist" aria-label={label} aria-orientation="horizontal">
    {items.map(item => {
      const selected = item.key === value;
      const base = `${idPrefix}-${item.key}`;
      return <button key={item.key} type="button" role="tab" id={base}
        className={`kpi kpi--band kpi--tab${item.primary ? " kpi--primary" : ""}`}
        aria-selected={selected} aria-controls={panelId}
        aria-disabled={item.unavailable ? true : undefined}
        aria-labelledby={`${base}-l`} aria-describedby={`${base}-v ${base}-n`}
        tabIndex={focusKey === item.key ? 0 : -1}
        onFocus={() => setFocusKey(item.key)}
        onClick={() => { if (!item.unavailable) onChange(item.key); }}
        onKeyDown={onKeyDown}>
        <span className="kpi-head">
          <span className="kpi-label" id={`${base}-l`}>{item.label}</span>
          {item.icon ? <span className="kpi-icon"><Icon name={item.icon} size="sm" /></span> : null}
        </span>
        <span className="kpi-value" id={`${base}-v`}>{item.value}</span>
        <span className="kpi-note" id={`${base}-n`}>{item.state ? <StatusIcon state={item.state} /> : null}<span>{item.note}</span></span>
      </button>;
    })}
  </div>;
}
