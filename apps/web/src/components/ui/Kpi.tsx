import type { ReactNode } from "react";
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
  label: string; value: ReactNode; note: ReactNode; state?: StatusState; icon?: IconName; emphasis?: boolean; variant?: "band" | "card";
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
