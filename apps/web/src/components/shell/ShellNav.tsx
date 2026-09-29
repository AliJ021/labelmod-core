import { useEffect, useLayoutEffect, useRef } from "react";
import { Glass } from "../Glass.tsx";
import { Icon } from "../Icon.tsx";
import { TabList, type TabItem } from "../Tabs.tsx";
import { MoreSheet } from "./MoreSheet.tsx";
import { NAV_ITEMS, routeUrl, type AccessState, type NavItem, type Zone } from "../../lib/navigation.ts";

/**
 * ناوبری اصلی — یک رجیستری، سه نمایش (docs/UI_PATTERNS.md، «پوسته»).
 *
 *   ≥ ۹۰۰px  نوار کناری گروه‌بندی‌شده با آیکون.
 *   < ۹۰۰px  نوار پایین با مقصدهای `mobilePrimary` + «بیشتر».
 *   «بیشتر»  برگهٔ مودال همهٔ مقصدها (`MoreSheet.tsx`).
 *
 * مجوز محافظه‌کار است (F-110-01): تا پاسخ سرور نیامده، مقصد مجوزدار دیده
 * نمی‌شود و فقط جای‌نگهدارِ بی‌برچسب جایش را نگه می‌دارد. اگر پرسش نرسید،
 * پیامی آرام با «بررسی دوباره» می‌آید؛ مقصدِ نامعلوم هرگز نشان داده نمی‌شود.
 */
export function ShellNav({ id, items, pending, access, onRetry, zone, onZone, compact, more, onMore }: {
  id: string;
  items: readonly NavItem[];
  pending: readonly NavItem[];
  access: AccessState;
  onRetry: () => void;
  zone: Zone;
  onZone: (next: Zone) => void;
  compact: boolean;
  more: boolean;
  onMore: (open: boolean) => void;
}) {
  const toggle = useRef<HTMLButtonElement>(null);
  /**
   * جای نوار پایین را محتوا از **ارتفاع واقعی** نوار رزرو می‌کند، نه از یک
   * عدد ثابت: روی ۳۲۰ پیکسل برچسب «کالا و قیمت» دو خط می‌شود و نوار از
   * ۶۶ به ۷۹ پیکسل می‌رسد. برگهٔ «بیشتر» لایهٔ جداست و نوار را عوض نمی‌کند.
   */
  useLayoutEffect(() => {
    // نوار همان Glass دربرگیرندهٔ دکمهٔ «بیشتر» است؛ Glass ref بیرونی نمی‌پذیرد.
    const el = toggle.current?.closest<HTMLElement>(".workspace-nav"), root = document.documentElement;
    if (!compact || !el) return;
    const apply = () => root.style.setProperty("--bottom-nav-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [compact]);
  useEffect(() => () => { document.documentElement.style.removeProperty("--bottom-nav-h"); }, []);
  // بخش باز که در نوار پایین نیست: «بیشتر» حالت انتخاب می‌گیرد تا کاربر بداند کجاست.
  const current = items.find(z => z.key === zone);
  const insideMore = compact && current !== undefined && !current.mobilePrimary;
  const waiting = access === "loading" && pending.length > 0;
  // همان ترتیب رجیستری؛ جای‌نگهدار بی‌برچسب و بی‌گروه جای مقصد بی‌پاسخ را نگه می‌دارد.
  const tabs = NAV_ITEMS.flatMap((z): TabItem<Zone>[] => items.includes(z)
    ? [{ key: z.key, label: z.label, group: z.group, primary: z.mobilePrimary, icon: <Icon name={z.icon} /> }]
    : pending.includes(z) ? [{ key: z.key, label: "", primary: z.mobilePrimary, pending: true }] : []);
  return <>
    <Glass as="nav" className="workspace-nav" refract={false} aria-label="ناوبری اصلی">
      {waiting ? <p className="sr-only" role="status">در حال بررسی دسترسی بخش‌ها…</p> : null}
      <TabList id={id} items={tabs} value={zone} onChange={onZone} label="بخش‌ها" className="zones workspace-zones" vertical={!compact} hrefFor={key => routeUrl(key)} />
      {!compact && access === "degraded" ? <div className="nav-access-note" role="status">
        <p>دسترسی بعضی بخش‌ها بررسی نشد؛ تا پاسخ سرور نیاید نشان داده نمی‌شوند.</p>
        <button type="button" className="btn" onClick={onRetry}>بررسی دوباره</button>
      </div> : null}
      <button ref={toggle} type="button" className="workspace-more" aria-haspopup="dialog" aria-expanded={compact && more} aria-controls={compact ? "more-sheet" : undefined}
        aria-label="بخش‌های بیشتر" aria-description={insideMore ? `بخش باز: ${current.label}` : access === "degraded" ? "دسترسی بعضی بخش‌ها بررسی نشد" : undefined}
        data-current={insideMore ? "" : undefined} onClick={() => onMore(true)}>
        <Icon name="more" />
        <span className="tab-label">بیشتر</span>
      </button>
    </Glass>
    {compact ? <MoreSheet open={more} items={items} pending={pending.length} access={access} zone={zone}
      onNavigate={onZone} onDismiss={() => onMore(false)} onRetry={onRetry} trigger={() => toggle.current} /> : null}
  </>;
}
