import { useId } from "react";
import { Icon } from "../Icon.tsx";
import { useModalDialog } from "../ui/use-modal.ts";
import { NAV_GROUPS, routeUrl, type AccessState, type NavItem, type Zone } from "../../lib/navigation.ts";

/**
 * برگهٔ «بیشتر» — مودال واقعی، نه disclosure (یافتهٔ F-110-04).
 *
 * ظاهرش همان برگهٔ تأییدشده است (سرگروه + ردیف فشرده، تک‌ستونی روی گوشی و
 * دوستونی روی تبلت)، ولی رفتارش حالا با پرده‌اش می‌خواند: روی `<dialog>`
 * بومی و `use-modal.ts` مشترک با Dialog. پشت صحنه inert است، Tab داخل
 * برگه می‌چرخد، و Esc، پس‌زمینه و «بستن» همه فوکوس را به دکمهٔ «بیشتر»
 * برمی‌گردانند. انتخاب یک بخش «بستن» نیست، رفتن است: فوکوس به محتوای
 * بخش تازه می‌رود، مثل هر تغییر بخش دیگری.
 *
 * مقصدها پیوندند (`aria-current="page"`)، نه زبانه: درون مودال tablistی
 * نیست که پنل‌هایش بیرونِ inert باشند.
 */
export function MoreSheet({ open, items, pending, access, zone, onNavigate, onDismiss, onRetry, trigger }: {
  open: boolean;
  items: readonly NavItem[];
  pending: number;
  access: AccessState;
  zone: Zone;
  onNavigate: (zone: Zone) => void;
  onDismiss: () => void;
  onRetry: () => void;
  trigger: () => HTMLElement | null;
}) {
  const titleId = useId();
  const { ref, props, closeInto } = useModalDialog(open, {
    onDismiss,
    returnFocus: trigger,
    // ورود پیش‌بینی‌پذیر: بخش باز اگر در برگه هست، وگرنه نخستین مقصد.
    initialFocus: dialog => dialog.querySelector<HTMLElement>('a[aria-current="page"]') ?? dialog.querySelector<HTMLElement>("a[href]"),
  });
  const groups = NAV_GROUPS.map(g => ({ ...g, items: items.filter(z => z.navGroup === g.key) })).filter(g => g.items.length > 0);
  return <dialog ref={ref} id="more-sheet" className="more-sheet" aria-labelledby={titleId} aria-modal="true" {...props}>
    <div className="more-sheet-body">
      <h2 id={titleId} className="more-sheet-title">همهٔ بخش‌ها</h2>
      {access === "degraded" ? <div className="nav-access-note" role="status">
        <p>دسترسی بعضی بخش‌ها بررسی نشد؛ تا پاسخ سرور نیاید نشان داده نمی‌شوند.</p>
        <button type="button" className="btn" onClick={onRetry}>بررسی دوباره</button>
      </div> : null}
      {access === "loading" && pending > 0 ? <p className="sr-only" role="status">در حال بررسی دسترسی بخش‌ها…</p> : null}
      {groups.map(g => <section key={g.key} className="more-group" aria-labelledby={`${titleId}-${g.key}`}>
        <h3 id={`${titleId}-${g.key}`} className="more-group-title">{g.label}</h3>
        <ul className="more-list">
          {g.items.map(z => <li key={z.key}>
            <a href={routeUrl(z.key)} aria-current={z.key === zone ? "page" : undefined} className={z.key === zone ? "on" : undefined}
              onClick={e => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                closeInto(document.getElementById("workspace-content"));
                onNavigate(z.key);
              }}>
              <Icon name={z.icon} /><span>{z.label}</span>
            </a>
          </li>)}
        </ul>
      </section>)}
      {access === "loading" && pending > 0 ? <ul className="more-list more-list--pending" aria-hidden="true">
        {Array.from({ length: pending }, (_, i) => <li key={i}><span className="skeleton more-pending" /></li>)}
      </ul> : null}
      <button type="button" className="more-sheet-close" aria-label="بستن بخش‌های بیشتر" onClick={onDismiss}>
        <Icon name="close" /><span>بستن</span>
      </button>
    </div>
  </dialog>;
}
