import { useRef } from "react";
import { Icon } from "./Icon.tsx";

/** جست‌وجوی مشترک: نام قابل دسترس، آیکون و پاک‌کردن بدون ارسال فرم. */
export function SearchField({ label, value, onChange, onSearch, onClear, placeholder = label, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSearch?: () => void;
  onClear?: () => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="search-field">
      <Icon name="search" />
      <input ref={input} type="search" inputMode="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && onSearch) { e.preventDefault(); onSearch(); } }} disabled={disabled} />
      {value !== "" ? <button type="button" className="icon-button search-clear" aria-label={`پاک‌کردن ${label}`} title="پاک‌کردن جست‌وجو" disabled={disabled} onClick={() => { onChange(""); onClear?.(); input.current?.focus(); }}><Icon name="close" /></button> : null}
    </div>
  );
}
