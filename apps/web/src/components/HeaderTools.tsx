import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Me } from "../lib/session.ts";
import type { Theme } from "../lib/theme.ts";
import { lastServerResponse, onServerResponse } from "../lib/api.ts";
import { formatClock } from "../lib/dashboard-freshness.ts";
import { Icon } from "./Icon.tsx";

/**
 * حساب کاربر: دکمهٔ بازکنندهٔ برگهٔ «ارتقای نشست PIN / تغییر رمز من».
 *
 * طرح ۱۰: در دسکتاپ پای نوار کناری (نام و نوع نشست کنار نشان)، در گوشی نماد در نوار بالا.
 * نام دسترس‌پذیر در هر دو یکی است («حساب …») تا هر دو یک کنترل باشند، نه دو کنترل متفاوت.
 */
export function AccountMenu({ me, onPassword, onReauth, variant, children }: {
  me: Me;
  onPassword: () => void;
  onReauth: () => void;
  variant: "icon" | "footer";
  /** محتوای دیداری دکمه در پای منو (نشان و نام). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !area.current?.contains(e.target)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className={`account-area account-area--${variant}`} ref={area} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className={variant === "icon" ? "icon-button" : "account-trigger"} aria-label={`حساب ${me.fullName}`} title={`حساب ${me.fullName}`}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
      {variant === "icon" ? <><Icon name="user" />{!me.elevated ? <span className="account-pin" aria-label="نشست PIN" /> : null}</> : children}
    </button>
    {open ? <div id={id} className="account-panel">
      <strong>{me.fullName}</strong>
      <span className="muted small">حساب کاربری شما</span>
      {!me.elevated ? <button type="button" className="btn btn--quiet" onClick={() => { setOpen(false); onReauth(); }}><Icon name="lock" />ارتقای نشست PIN</button> : null}
      <button type="button" className="btn btn--quiet" onClick={() => { trigger.current?.focus(); setOpen(false); onPassword(); }}><Icon name="key" />تغییر رمز من</button>
    </div> : null}
  </div>;
}

/**
 * «به‌روزشده ساعت …» (طرح ۱۰) — زمان آخرین پاسخ **موفق** سرور به همین صفحه، نه ساعت دستگاه.
 * تا پاسخی نرسیده چیزی ادعا نمی‌شود؛ قطع اتصال نقطه را از سبز به هشدار می‌برد.
 */
export function ServerFreshness({ online }: { online: boolean }) {
  const at = useSyncExternalStore(onServerResponse, lastServerResponse, () => null);
  if (at === null) return null;
  return <span className="server-fresh" data-state={online ? "ok" : "offline"} title="زمان آخرین پاسخ موفق سرور">
    <i className="server-fresh-dot" aria-hidden="true" />
    <span className="server-fresh-text">{online ? "به‌روزشده ساعت" : "قطع اتصال؛ آخرین پاسخ"} <span className="nowrap">{formatClock(at)}</span></span>
  </span>;
}

/**
 * ابزار نوار بالا (طرح ۱۰، تصمیم مالک): در هر عرض فقط قفل و تم. حساب و خروج در دسکتاپ پای نوار
 * کناری‌اند و در گوشی پای منوی ☰ (همان `ShellUser`) — یک کنترل، نه دو نسخه.
 */
export function HeaderTools({ theme, onTheme, onLock }: {
  theme: Theme;
  onTheme: () => void;
  onLock: () => void;
}) {
  const themeLabel = theme === "system" ? "تم: سیستم؛ تغییر به روشن" : theme === "light" ? "تم: روشن؛ تغییر به تیره" : "تم: تیره؛ تغییر به سیستم";
  return (
    <div className="tools" aria-label="ابزارهای حساب">
      <button type="button" className="icon-button" aria-label="قفل صفحه" title="قفل صفحه" onClick={onLock}><Icon name="lock" /></button>
      <button type="button" className="icon-button" aria-label={themeLabel} title={themeLabel} onClick={onTheme}><Icon name={theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon"} /></button>
    </div>
  );
}
