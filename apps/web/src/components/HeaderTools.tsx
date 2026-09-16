import { useEffect, useId, useRef, useState } from "react";
import type { Me } from "../lib/session.ts";
import type { Theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";

export function HeaderTools({ me, theme, onTheme, onLock, onLogout, onPassword, onReauth }: {
  me: Me;
  theme: Theme;
  onTheme: () => void;
  onLock: () => void;
  onLogout: () => void;
  onPassword: () => void;
  onReauth: () => void;
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
  const themeLabel = theme === "system" ? "تم: سیستم؛ تغییر به روشن" : theme === "light" ? "تم: روشن؛ تغییر به تیره" : "تم: تیره؛ تغییر به سیستم";
  return (
    <div className="tools" aria-label="ابزارهای حساب">
      <div className="account-area" ref={area} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
        <button ref={trigger} type="button" className="icon-button" aria-label={`حساب ${me.fullName}`} title={`حساب ${me.fullName}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <Icon name="user" />{!me.elevated ? <span className="account-pin" aria-label="نشست PIN" /> : null}
        </button>
        {open ? <div id={id} className="account-panel">
          <strong>{me.fullName}</strong>
          <span className="muted small">حساب کاربری شما</span>
          {!me.elevated ? <button type="button" className="btn btn--quiet" onClick={() => { setOpen(false); onReauth(); }}><Icon name="lock" />ارتقای نشست PIN</button> : null}
          <button type="button" className="btn btn--quiet" onClick={() => { trigger.current?.focus(); setOpen(false); onPassword(); }}><Icon name="key" />تغییر رمز من</button>
        </div> : null}
      </div>
      <button type="button" className="icon-button" aria-label="قفل صفحه" title="قفل صفحه" onClick={onLock}><Icon name="lock" /></button>
      <button type="button" className="icon-button" aria-label="خروج" title="خروج" onClick={onLogout}><Icon name="logout" /></button>
      <button type="button" className="icon-button" aria-label={themeLabel} title={themeLabel} onClick={onTheme}><Icon name={theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon"} /></button>
    </div>
  );
}
