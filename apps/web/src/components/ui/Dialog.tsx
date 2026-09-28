import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";

/**
 * Dialog و Sheet روی `<dialog>` بومی (docs/UI_PATTERNS.md، «لایه‌ها»).
 *
 * بومی یعنی به‌رایگان: بی‌اثرکردن پشت صحنه، Esc، لایهٔ بالایی و
 * نقش دسترس‌پذیر. کامپوننت فقط دو کار اضافه می‌کند: فوکوس را پس از بستن
 * به جای قبلی برمی‌گرداند، و وقتی `dismissible` خاموش است (عمل مالی در
 * حال اجرا) Esc را می‌بندد.
 *
 * `variant="sheet"` روی موبایل از پایین و روی دسکتاپ از کنار (inline-end)
 * می‌آید. انیمیشن فقط transform و opacity است.
 */
export function Dialog({ open, onClose, title, description, children, footer, variant = "dialog", dismissible = true, size = "md", tone }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: "dialog" | "sheet";
  dismissible?: boolean;
  size?: "sm" | "md" | "lg";
  tone?: "final" | "destructive";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    }
  }, [open]);
  useEffect(() => () => {
    const back = opener.current;
    if (ref.current?.open && back instanceof HTMLElement && back.isConnected) back.focus();
  }, []);
  return <dialog ref={ref} className={`ui-dialog ui-dialog--${variant} ui-dialog--${size}${tone ? ` ui-dialog--${tone}` : ""}`}
    aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
    onCancel={e => { e.preventDefault(); if (dismissible) onClose(); }}
    onClick={e => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
    <div className="ui-dialog-body">
      <div className="ui-dialog-head">
        <h2 id={titleId} className="ui-dialog-title">{title}</h2>
        {dismissible ? <button type="button" className="icon-button" aria-label="بستن" onClick={onClose}><Icon name="close" /></button> : null}
      </div>
      {description ? <div id={descId} className="ui-dialog-description">{description}</div> : null}
      {children}
      {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
    </div>
  </dialog>;
}
