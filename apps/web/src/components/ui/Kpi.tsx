import type { ReactNode } from "react";
import { Solid } from "../Glass.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { StatusIcon, type StatusState } from "./Status.tsx";

/**
 * کارت شاخص — مات، همیشه با برچسب صریح (design.md: فروش · وجه دریافتی · سود).
 *
 * `value` معمولاً `<Money/>` است؛ «—» یعنی نمی‌دانیم یا اجازه نیست، نه صفر.
 */
export function Kpi({ label, value, note, state, icon, emphasis = false }: {
  label: string; value: ReactNode; note: ReactNode; state?: StatusState; icon?: IconName; emphasis?: boolean;
}) {
  return <Solid as="section" className={`kpi${emphasis ? " kpi--emphasis" : ""}`} aria-label={label}>
    <div className="kpi-head">
      <span className="kpi-label">{label}</span>
      {icon ? <span className="kpi-icon"><Icon name={icon} size="sm" /></span> : null}
    </div>
    <div className="kpi-value">{value}</div>
    <p className="kpi-note">{state ? <StatusIcon state={state} /> : null}<span>{note}</span></p>
  </Solid>;
}
