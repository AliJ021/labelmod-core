import { useRef } from "react";
import { Icon } from "./Icon.tsx";

/** جست‌وجوی مشترک: نام قابل دسترس، آیکون و پاک‌کردن بدون ارسال فرم. */
export function SearchField({ label, value, onChange, placeholder = label, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="search-field">
      <Icon name="search" />
      <input ref={input} type="search" inputMode="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      {value !== "" ? <button type="button" className="icon-button search-clear" aria-label={`پاک‌کردن ${label}`} title="پاک‌کردن جست‌وجو" disabled={disabled} onClick={() => { onChange(""); input.current?.focus(); }}><Icon name="close" /></button> : null}
    </div>
  );
}
