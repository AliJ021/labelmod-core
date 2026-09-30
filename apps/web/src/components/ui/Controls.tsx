import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/**
 * کنترل‌های فرم — روی عنصر بومی، با برچسب همیشه‌دیدنی.
 *
 * جای‌نگهدار جای برچسب نیست. راهنما و خطا با `aria-describedby` به
 * ورودی وصل می‌شوند و خطا `aria-invalid` می‌گذارد؛ متن خطا انسانی و
 * فارسی است و می‌گوید چه باید کرد.
 *
 * برچسب با `htmlFor` به کنترل وصل است، نه با دربرگرفتن: برچسبِ دربرگیرنده
 * متن راهنما و خطا را هم وارد **نام** کنترل می‌کرد («رمز فعلی — حداقل ۱۲…»)
 * و نام دسترس‌پذیر با هر خطا عوض می‌شد. راهنما فقط توضیح است
 * (`aria-describedby`)، نه بخشی از نام. `id` کنترل اگر داده شده باشد حفظ می‌شود.
 */
export function Field({ label, hint, error, children, optional = false, className }: {
  label: string; hint?: ReactNode; error?: string | null; children: ReactElement<Record<string, unknown>>; optional?: boolean; className?: string;
}) {
  const ownId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const controlId = isValidElement(children) && typeof children.props.id === "string" ? children.props.id : ownId;
  const control = isValidElement(children)
    ? cloneElement(children, { id: controlId, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })
    : children;
  return <div className={`field${className ? ` ${className}` : ""}`}>
    <label className="field-label" htmlFor={controlId}>{label}{optional ? <span className="field-optional"> (اختیاری)</span> : null}</label>
    {control}
    {hint ? <span id={hintId} className="field-hint">{hint}</span> : null}
    {error ? <span id={errorId} className="field-error">{error}</span> : null}
  </div>;
}

/**
 * کلید روشن/خاموش: `role="switch"` روی checkbox بومی — کیبورد و فرم رایگان.
 * توضیح بیرون از برچسب و با `aria-describedby` است تا نام کلید کوتاه بماند.
 * `stateLabels` وضعیت را **متنی** هم می‌گوید (رنگ به‌تنهایی حامل معنا نیست).
 *
 * `describedBy` شناسهٔ توضیحی است که مصرف‌کننده **بیرون** از کلید می‌کشد (مثل
 * راهنما و خطای ردیف تنظیمات)؛ با `description` خودِ کلید جمع می‌شود، نه جایگزین.
 */
export function Switch({ label, checked, onChange, disabled = false, description, stateLabels, id, describedBy }: {
  label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; description?: ReactNode;
  stateLabels?: readonly [on: string, off: string]; id?: string; describedBy?: string | undefined;
}) {
  const hintId = useId();
  const described = [description ? hintId : null, describedBy ?? null].filter(Boolean).join(" ") || undefined;
  const control = <label className="switch">
    <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={described} onChange={e => onChange(e.target.checked)} />
    <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    <span className="switch-text"><span>{label}</span>{stateLabels ? <span className="switch-state" aria-hidden="true">{checked ? stateLabels[0] : stateLabels[1]}</span> : null}</span>
  </label>;
  if (!description) return control;
  return <div className="switch-field">{control}<span id={hintId} className="field-hint">{description}</span></div>;
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
