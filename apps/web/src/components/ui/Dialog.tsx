import { useId, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { useModalDialog } from "./use-modal.ts";

/**
 * Dialog و Sheet روی `<dialog>` بومی (docs/UI_PATTERNS.md، «لایه‌ها»).
 *
 * بومی یعنی به‌رایگان: بی‌اثرکردن پشت صحنه، Esc، لایهٔ بالایی و
 * نقش دسترس‌پذیر. بازگشت فوکوس و چرخش Tab از `use-modal.ts` می‌آید — همان
 * زیرساختی که برگهٔ «بیشتر» دارد. وقتی `dismissible` خاموش است (عمل مالی
 * در حال اجرا) Esc و پس‌زمینه نمی‌بندند.
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
  const { ref, props } = useModalDialog(open, { onDismiss: onClose, dismissible });
  const titleId = useId();
  const descId = useId();
  return <dialog ref={ref} className={`ui-dialog ui-dialog--${variant} ui-dialog--${size}${tone ? ` ui-dialog--${tone}` : ""}`}
    aria-labelledby={titleId} aria-describedby={description ? descId : undefined} {...props}>
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
