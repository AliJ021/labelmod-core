import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/**
 * کنترل‌های فرم — روی عنصر بومی، با برچسب همیشه‌دیدنی.
 *
 * جای‌نگهدار جای برچسب نیست. راهنما و خطا با `aria-describedby` به
 * ورودی وصل می‌شوند و خطا `aria-invalid` می‌گذارد؛ متن خطا انسانی و
 * فارسی است و می‌گوید چه باید کرد.
 */
export function Field({ label, hint, error, children, optional = false }: {
  label: string; hint?: ReactNode; error?: string | null; children: ReactElement<Record<string, unknown>>; optional?: boolean;
}) {
  const hintId = useId();
  const errorId = useId();
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })
    : children;
  return <label className="field">
    <span className="field-label">{label}{optional ? <span className="field-optional"> (اختیاری)</span> : null}</span>
    {control}
    {hint ? <span id={hintId} className="field-hint">{hint}</span> : null}
    {error ? <span id={errorId} className="field-error">{error}</span> : null}
  </label>;
}

/** کلید روشن/خاموش: `role="switch"` روی checkbox بومی — کیبورد و فرم رایگان. */
export function Switch({ label, checked, onChange, disabled = false, description }: {
  label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; description?: string;
}) {
  return <label className="switch">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    <span className="switch-text"><span>{label}</span>{description ? <span className="field-hint">{description}</span> : null}</span>
  </label>;
}

/** انتخاب یکی از چند گزینهٔ کوتاه: radio بومی، پس پیکان‌ها و Tab درست کار می‌کنند. */
export function Segmented<K extends string>({ label, options, value, onChange }: {
  label: string; options: readonly { key: K; label: string }[]; value: K; onChange: (next: K) => void;
}) {
  const name = useId();
  return <fieldset className="segmented">
    <legend className="sr-only">{label}</legend>
    {options.map(o => <label key={o.key} className="segmented-option">
      <input type="radio" name={name} value={o.key} checked={value === o.key} onChange={() => onChange(o.key)} />
      <span>{o.label}</span>
    </label>)}
  </fieldset>;
}

/** دکمه با حالت «در حال اجرا»: برچسب عوض می‌شود و دوباره‌زدن ممکن نیست. */
export function Button({ children, variant = "secondary", busy = false, busyLabel, icon, ...rest }: {
  children: ReactNode; variant?: "primary" | "secondary" | "quiet" | "danger"; busy?: boolean; busyLabel?: string; icon?: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const cls = variant === "primary" ? "btn btn--primary" : variant === "quiet" ? "btn btn--quiet" : variant === "danger" ? "btn btn--danger" : "btn";
  return <button type="button" {...rest} className={`${cls}${rest.className ? ` ${rest.className}` : ""}`} disabled={busy || rest.disabled} aria-busy={busy || undefined}>
    {icon}{busy && busyLabel ? busyLabel : children}
  </button>;
}
